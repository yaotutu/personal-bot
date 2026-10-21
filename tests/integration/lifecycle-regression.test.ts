import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import type { ConversationInput } from "../../src/features/conversation/types.js";
import { createDataLayout, threadWorkspaceDir } from "../../src/adapters/storage/data-layout.js";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";

type Service = Awaited<ReturnType<typeof createService>>;
const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** 初始化前就登记回收：模型、服务、登录或断言任一步失败，都只清理本测试资源。 */
const createFixture = async (t: TestContext) => {
  let dataDir: string | undefined;
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Service | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      try { await model?.close(); }
      finally { if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  dataDir = await mkdtemp(join(tmpdir(), "personal-bot-lifecycle-regression-"));
  model = await createFakeModel();
  const configInput = {
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "test-secret-model-key" },
    runtime: { dataDir, runTimeoutMs: 30_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
  };
  return {
    model, configInput, layout: createDataLayout(dataDir),
    startService: async () => service = await createService(createConfig(configInput)),
  };
};

/** 有截止时间地等待真实异步状态；不吞 I/O 错误，也不用固定长睡眠掩盖竞态。 */
const until = async (check: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(20);
  }
};

const post = async (service: Service, path: string, body: unknown) => service.app.request(path, {
  method: "POST",
  headers: { Authorization: `Bearer ${service.auth.login()}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** app.request 未经 HTTP 编码，runtime 的 SSE 可能直接产出字符串 chunk。 */
const readSse = async (response: Response) => {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      text += typeof value === "string" ? value : decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
};

const readOptional = async (file: string) => {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

test("Stop cancels a pending write approval without changing the existing file", async (t) => {
  const h = await createFixture(t);
  const service = await h.startService();
  const target = join(threadWorkspaceDir(h.layout, "local-main"), "draft.md");
  const original = "EXISTING-DRAFT must survive Stop\n";
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, original);
  const runId = randomUUID();
  const input: ConversationInput = {
    spaceId: "local-main", runId,
    expectedRevision: "empty", message: { id: randomUUID(), content: "帮我写入草稿" },
  };
  // 立即消费 SSE，并提前接住失败，避免等待审批期间产生未处理的 rejection。
  const run = post(service, "/api/conversation/run", input)
    .then(async (response) => {
      assert.equal(response.status, 200);
      return readSse(response);
    })
    .then((text) => ({ text }), (error: unknown) => ({ error }));
  // 待审批没有 HTTP 列表接口；内部只读快照用于等待真实挂起状态，不伪造第二套状态。
  await until(async () => (await service.actions.snapshotPending()).length > 0,
    "write did not reach pending approval");
  const pending = await service.actions.snapshotPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "file_write");
  assert.equal(await readFile(target, "utf8"), original);

  const stopped = await post(service, "/api/conversation/stop", { spaceId: "local-main", runId });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).stopped, true);
  const outcome = await run;
  if ("error" in outcome) throw outcome.error;
  const events = outcome.text.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; code?: string });
  assert.equal(events.at(-1)?.code, "STOPPED");
  assert.ok(!events.some((event) => event.type === "RUN_FINISHED"));
  await until(async () => (await service.actions.list()).find((action) => action.id === pending[0].id)?.status === "cancelled",
    "Stop did not cancel the pending approval");
  // 同时核对落盘终态，防止仅内存撤销、进程重启后旧审批仍可批准。
  const persisted: { id: string; status: string }[] = JSON.parse(await readFile(h.layout.actionsFile, "utf8"));
  assert.equal(persisted.find((action) => action.id === pending[0].id)?.status, "cancelled");
  assert.equal((await service.conversationHub.forThread("local-main")).isRunning(), false);
  assert.equal(await readFile(target, "utf8"), original);
});

test("closed service rejects task creation and memory writes through its original app with 503", async (t) => {
  const h = await createFixture(t);
  const service = await h.startService();
  const seed = await post(service, "/api/memories", { text: "LIFECYCLE-ORIGINAL-MEMORY" });
  assert.equal(seed.status, 200);
  const memoryId: string = (await seed.json()).id;
  const before = await readOptional(h.layout.memoryFile);
  await service.close();
  const requestCount = h.model.requests.length;
  for (const [path, body] of [
    ["/api/agent/tasks", { prompt: "MUST-NOT-RUN", title: "MUST-NOT-BE-PERSISTED" }],
    ["/api/memories", { text: "MUST-NOT-BE-ADDED" }],
    [`/api/memories/${memoryId}`, { text: "MUST-NOT-REPLACE-SEED" }],
  ] as const) {
    const response = await post(service, path, body);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: "Service is closing" });
  }
  assert.equal(await readOptional(h.layout.memoryFile), before);
  assert.equal(h.model.requests.length, requestCount);
});

test("corrupt monitor document fails initialization without keeping a child process alive", async (t) => {
  for (const domain of ["monitors"] as const) {
    await t.test(domain, async (t) => {
      const h = await createFixture(t);
      const file = h.layout.monitorsFile;
      const corrupt = "{invalid-json-preserve-original";
      await writeFile(file, corrupt);
      // 在子进程调用同一真实组合入口。不调用 process.exit：遗留调度 interval、worker
      // 或会话资源会阻止自然退出，execFile 的超时会让回归测试明确失败并回收子进程。
      const script = `
        import assert from "node:assert/strict";
        import { createService } from ${JSON.stringify(new URL("../../src/bootstrap/create-service.ts", import.meta.url).href)};
        import { createConfig } from ${JSON.stringify(new URL("../../src/config/load-config.ts", import.meta.url).href)};
        let service;
        try {
          await assert.rejects(async () => {
            service = await createService(createConfig(${JSON.stringify(h.configInput)}));
          }, { name: "InvalidDocumentError", message: "Invalid ${domain} document; restore a valid backup before writing" });
          console.log("INITIALIZATION_REJECTED");
        } finally {
          await service?.close();
        }
      `;
      const child = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: projectRoot, timeout: 15_000, killSignal: "SIGKILL",
        env: { ...process.env, COPILOTKIT_TELEMETRY_DISABLED: "true", DO_NOT_TRACK: "1" },
      });
      assert.match(child.stdout, /INITIALIZATION_REJECTED/);
      assert.equal(await readFile(file, "utf8"), corrupt);
      assert.equal(h.model.requests.length, 0);
    });
  }
});
