import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import {
  dreamOverviewResponse,
  dreamThreadResponse,
  memoriesResponse,
} from "../../src/http/contracts/responses.js";
import { createFakeModel } from "../support/fake-model.js";

const createFixture = async (t: TestContext) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-dream-int-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: {
        dataDir,
        runTimeoutMs: 5000,
        schedulerIntervalMs: 60000,
        monitorScanIntervalMs: 60000,
      },
    }),
  );
  const token = service.auth.login()!;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const json = async (path: string, method = "GET", body?: unknown) => {
    const res = await service!.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const chat = async (threadId: string, content: string, runId: string) => {
    const hist = await json(`/api/conversation?spaceId=${encodeURIComponent(threadId)}`);
    const revision = (hist.body as { revision: string }).revision;
    const res = await service!.app.request("/api/conversation/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        spaceId: threadId,
        runId,
        expectedRevision: revision,
        message: { id: `u-${runId}`, content },
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
  };
  return { model, dataDir, service, json, chat };
};

test("Dream integration: main thread consolidates USER/SOUL/MEMORY, advances cursor and skips empty follow-ups", async (t) => {
  const { json, chat, model } = await createFixture(t);

  // 1. 独立记忆查询 GET /api/agent/memories 与参数校验。
  const emptyList = await json("/api/memories");
  assert.equal(emptyList.status, 200);
  assert.deepEqual(memoriesResponse.parse(emptyList.body), { memories: [] });
  assert.equal((await json("/api/memories?extra=1")).status, 400);
  assert.equal((await json("/api/memories?q=a&q=b")).status, 400);
  assert.equal((await json("/api/memories?q=a&limit=99")).status, 400);

  // 2. 在主会话产生一条含用户偏好、助手人设与长期事实的对话。
  await chat(
    "local-main",
    "请记一下：用户偏好:每天早起喝黑咖啡\n助手人设:回答直接不寒暄\n长期事实:服务器部署在东京区域",
    "run-main-1",
  );

  // 3. 立即执行主会话 Dream 整理：通过真实 pi SessionManager.inMemory + propose_notes 提交。
  const runRes = await json("/api/spaces/local-main/dream/run", "POST", {});
  assert.equal(runRes.status, 200);
  const state = dreamThreadResponse.parse(runRes.body);
  assert.equal(state.lastRun?.status, "completed");
  assert.equal(state.cursor, "assistant-run-main-1");
  assert.deepEqual(state.lastRun?.changed.sort(), ["memory", "soul", "user"]);

  // 4. 核对 USER.md、SOUL.md 与按需检索 memory.json 真实写入。
  const profile = (await json("/api/profile")).body as { soul: string; user: string };
  assert.equal(profile.user, "每天早起喝黑咖啡");
  assert.equal(profile.soul, "回答直接不寒暄");
  const searched = memoriesResponse.parse((await json("/api/memories?q=东京")).body);
  assert.equal(searched.memories.length, 1);
  assert.equal(searched.memories[0]?.text, "服务器部署在东京区域");

  // 5. 无新消息时再次立即整理：不调用模型，不产生重复条目。
  const beforeCalls = model.requests.length;
  const secondRun = await json("/api/spaces/local-main/dream/run", "POST", {});
  assert.equal(secondRun.status, 200);
  assert.equal(model.requests.length, beforeCalls);
  assert.equal(dreamThreadResponse.parse(secondRun.body).lastRun?.processed, 0);
});

test("Dream integration: non-main thread routes session rules via purpose, holds global notes in pending, and respects failure cursor boundary", async (t) => {
  const { json, chat, dataDir } = await createFixture(t);

  // 1. 为邮件空间设置空间用途与初始规则，并开启 Dream + 自定义补充提示词。
  const savedInst = await json("/api/spaces/mail-thread/instructions", "PUT", {
    instructions: "保持礼貌。",
    purpose: "处理外部商务邮件",
  });
  assert.equal(savedInst.status, 200);
  assert.match((savedInst.body as { instructions: string }).instructions, /^## 空间用途\n处理外部商务邮件/);

  const savedDream = await json("/api/spaces/mail-thread/dream", "PUT", {
    enabled: true,
    inheritGlobalPrompt: true,
    prompt: "只提取与商务邮件格式相关的规则。",
  });
  assert.equal(savedDream.status, 200);
  const parsedDream = dreamThreadResponse.parse(savedDream.body);
  assert.equal(parsedDream.enabled, true);
  assert.equal(parsedDream.purpose, "处理外部商务邮件");

  // 2. 在邮件会话产生一条同时含会话规则与全局用户偏好的消息。
  await chat(
    "mail-thread",
    "会话规则:邮件落款统一写 Best regards\n用户偏好:周末不看工作消息",
    "run-mail-1",
  );

  // 3. 运行邮件会话 Dream：会话规则直接进该会话 INSTRUCTIONS.md，全局偏好进入 pending。
  const mailRun = await json("/api/spaces/mail-thread/dream/run", "POST", {});
  assert.equal(mailRun.status, 200);
  const mailState = dreamThreadResponse.parse(mailRun.body);
  assert.equal(mailState.lastRun?.status, "completed");
  assert.deepEqual(mailState.lastRun?.changed, ["instructions"]);
  assert.equal(mailState.pending.length, 1);
  assert.equal(mailState.pending[0]?.reason, "global_from_session");
  assert.equal(mailState.pending[0]?.text, "周末不看工作消息");

  // 全局 USER.md 未被非主会话直接污染。
  assert.equal(((await json("/api/profile")).body as { user: string }).user, "");
  // 会话指令已写入，且 `## 空间用途` 保持不变。
  const afterInst = (await json("/api/spaces/mail-thread/instructions")).body as {
    instructions: string;
  };
  assert.match(afterInst.instructions, /## 空间用途\n处理外部商务邮件/);
  assert.match(afterInst.instructions, /邮件落款统一写 Best regards/);

  // 4. 全局概览能看到待决项；用户确认写入 USER.md 后生效并清空 pending。
  const overview = dreamOverviewResponse.parse((await json("/api/agent/dream")).body);
  assert.equal(
    overview.threads.find((item) => item.spaceId === "mail-thread")?.pending.length,
    1,
  );
  const resolved = await json(
    `/api/spaces/mail-thread/dream/pending/${mailState.pending[0]!.id}`,
    "POST",
    { action: "apply", target: "user" },
  );
  assert.equal(resolved.status, 200);
  assert.equal(dreamThreadResponse.parse(resolved.body).pending.length, 0);
  assert.equal(((await json("/api/profile")).body as { user: string }).user, "周末不看工作消息");

  // 5. 模拟整理轮模型失败（DREAM-FAIL）：状态诚实记为 failed，游标不推进。
  const prevCursor = mailState.cursor;
  await chat("mail-thread", "DREAM-FAIL", "run-mail-fail");
  const failedRun = await json("/api/spaces/mail-thread/dream/run", "POST", {});
  assert.equal(failedRun.status, 200);
  const failedState = dreamThreadResponse.parse(failedRun.body);
  assert.equal(failedState.lastRun?.status, "failed");
  assert.equal(failedState.cursor, prevCursor);

  // 6. 记忆满 500 条时 POST /api/agent/memories 返回 409，不丢弃旧条目。
  await writeFile(
    join(dataDir, "profile", "memory.json"),
    JSON.stringify({
      memories: Array.from({ length: 500 }, (_, i) => ({
        id: `m-${i}`,
        text: `fact-${i}`,
        source: "seed",
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
      })),
      identity: { name: "pi-muse", tone: "warm", avatar: "sparkles", showChatUpdates: true },
    }),
  );
  const fullRes = await json("/api/memories", "POST", { text: "overflow" });
  assert.equal(fullRes.status, 409);
});
