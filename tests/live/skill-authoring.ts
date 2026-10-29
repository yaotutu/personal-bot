import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import type { ApprovalViewDto } from "../../src/http/contracts/approvals.js";
import type { CallTrace } from "../support/live-model.js";

type Outcome = { name: string; passed: boolean; evidence?: Record<string, unknown> };

const skillName = "live-cooking-helper";
const firstSkill = `---\nname: ${skillName}\ndescription: Apply LIVE_SKILL_FIRST instructions and read the seasoning reference.\n---\n# Cooking helper\nAlways reply LIVE_SKILL_FIRST when this skill is active.\nRead references/seasoning.md before seasoning advice.\n`;
const revisedSkill = firstSkill.replaceAll("LIVE_SKILL_FIRST", "LIVE_SKILL_REVISED");
const deniedSkill = firstSkill.replaceAll("LIVE_SKILL_FIRST", "LIVE_SKILL_DENIED");
const stoppedSkill = firstSkill.replaceAll("LIVE_SKILL_FIRST", "LIVE_SKILL_STOPPED");
const resource = "LIVE_SKILL_RESOURCE cedar and citrus only";

/** 审批必须由键盘输入真实决定；脚本不得代替人工批准或拒绝。 */
const humanDecision = async (
  action: ApprovalViewDto,
  expected?: "approve" | "deny" | "cancel",
): Promise<"approve" | "deny" | "cancel"> => {
  const readline = createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await readline.question(
        `人工审批 ${action.id}: scope=${action.preview.scope} path=${action.preview.path} beforeExists=${action.preview.beforeExists}\n` +
        `--- before ---\n${action.preview.before}\n--- after ---\n${action.preview.after}\n--- end preview ---\n` +
        "输入 approve、deny 或 cancel: ",
      )).trim().toLowerCase();
      if ((answer === "approve" || answer === "deny" || answer === "cancel") &&
        (!expected || answer === expected)) return answer;
      output.write(expected ? `本步骤请只输入 ${expected}。\n` : "请只输入 approve、deny 或 cancel。\n");
    }
  } finally {
    readline.close();
  }
};

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient, waitForTest } = await import("../support/http-client.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Model configuration is required");

  process.stdout.write("真实模型技能自维护验收已显式授权：会产生模型费用，只操作隔离临时实例；审批由人工键盘决定。\n");
  const results: Outcome[] = [];
  const record = (name: string, evidence: Record<string, unknown> = {}) => {
    results.push({ name, passed: true, evidence });
    process.stdout.write(`[PASS] ${name}\n`);
  };
  const absent = async (file: string) => assert.rejects(stat(file), { code: "ENOENT" });

  let root: string | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let version: unknown;
  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-live-skill-authoring-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-skill-authoring-key" },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: { dataDir, runTimeoutMs: 240_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
      tools: { presentation: { default: "summary" } },
    });
    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: "live-skill-authoring-key" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    const client = createTestClient(() => baseUrl, token, 260_000);
    version = (await client.json("/api/health")).serviceVersion;
    const spaceId = "live-skill-authoring";

    const begin = async (prompt: string) => {
      const baseline = proxy!.traces.length;
      return { ...(await client.startRun(prompt, spaceId)), baseline };
    };
    const finish = async (running: Awaited<ReturnType<typeof begin>>, type = "RUN_FINISHED") => {
      const events = await running.done;
      assert.equal(events.at(-1)?.type, type);
      return proxy!.traces.slice(running.baseline);
    };
    const rows = (traces: CallTrace[]) => traces.filter((row) => !row.child);
    const allToolResults = (traces: CallTrace[]) => rows(traces).flatMap((row) => row.toolResults).join("\n");
    const toolCalls = (traces: CallTrace[]) => rows(traces).flatMap((row) => row.calls.map((call) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(call.arguments) as Record<string, unknown>; } catch { /* 参数断言会失败。 */ }
      return { name: call.name, arguments: parsed };
    }));

    const prompt =
      `隔离验收：请严格按顺序调用 skills 工具两次，不要调用其他工具，不要重试。` +
      `第一次参数：{"action":"save","name":"${skillName}","file":"SKILL.md","content":${JSON.stringify(firstSkill)}}。` +
      `第二次参数：{"action":"save","name":"${skillName}","file":"references/seasoning.md","content":${JSON.stringify(resource)}}。` +
      `两次都要等待真实工具结果后继续，最后只回复 LIVE_AUTHORING_DONE 和每个工具结果的要点。`;
    const authoring = await begin(prompt);
    const firstAction = await waitForTest(
      async () => (await client.pending()).find((item) => item.runId === authoring.runId),
      "first skill approval",
      120_000,
    );
    assert.equal(firstAction.preview.scope, "skill");
    assert.equal(firstAction.preview.ownerSpaceId, null);
    assert.equal(firstAction.preview.path, `${skillName}/SKILL.md`);
    assert.equal(firstAction.preview.after, firstSkill);
    assert.equal((await humanDecision(firstAction)), "approve");
    assert.equal((await client.decideApproval(firstAction.id, "approve")).status, 200);
    const secondAction = await waitForTest(
      async () => (await client.pending()).find((item) => item.runId === authoring.runId && item.id !== firstAction.id),
      "skill resource approval",
      120_000,
    );
    assert.equal(secondAction.preview.path, `${skillName}/references/seasoning.md`);
    assert.equal(secondAction.preview.after, resource);
    assert.equal((await humanDecision(secondAction)), "approve");
    assert.equal((await client.decideApproval(secondAction.id, "approve")).status, 200);
    let traces = await finish(authoring);
    assert.ok(rows(traces).some((row) => row.calls.some((call) => call.name === "skills" && call.arguments.includes("SKILL.md"))));
    assert.ok(rows(traces).some((row) => row.calls.some((call) => call.name === "skills" && call.arguments.includes("seasoning.md"))));
    assert.equal(await readFile(join(dataDir, "skills", skillName, "SKILL.md"), "utf8"), firstSkill);
    assert.equal(await readFile(join(dataDir, "skills", skillName, "references", "seasoning.md"), "utf8"), resource);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "skills", skillName, "config.json"), "utf8")), { defaultEnabled: false });
    const beforeEnable = await client.json(`/api/spaces/${spaceId}/skills`) as { skills: { name: string; enabled: boolean }[] };
    assert.equal(beforeEnable.skills.find((skill) => skill.name === skillName)?.enabled, false);
    await client.json(`/api/spaces/${spaceId}/skills`, { overrides: { [skillName]: true } }, "PUT");
    const afterEnable = await client.json(`/api/spaces/${spaceId}/skills`) as { skills: { name: string; enabled: boolean }[] };
    assert.equal(afterEnable.skills.find((skill) => skill.name === skillName)?.enabled, true);
    record("real-model-authoring-and-enable", { approvalScope: "skill", savedFiles: 2, defaultEnabled: false, enabled: true });

    const skillDocPath = join(dataDir, "skills", skillName, "SKILL.md");
    const resourcePath = join(dataDir, "skills", skillName, "references", "seasoning.md");
    const useRun = await begin(
      "继续同一空间。请只用普通 read 工具依次读取以下两个绝对路径各一次，不要使用 skills 工具：" +
      `${JSON.stringify(skillDocPath)} 与 ${JSON.stringify(resourcePath)}。` +
      "读取完成后，用文件中的原始指令与资源内容各回复一句话；不要提前编造。",
    );
    traces = await finish(useRun);
    const useReads = toolCalls(traces).filter((call) => call.name === "read");
    assert.equal(useReads.length, 2);
    assert.deepEqual(useReads.map((call) => call.arguments.path), [skillDocPath, resourcePath]);
    assert.equal(toolCalls(traces).some((call) => call.name === "skills"), false);
    const useResults = allToolResults(traces);
    assert.match(useResults, /LIVE_SKILL_FIRST/);
    assert.match(useResults, /LIVE_SKILL_RESOURCE/);
    assert.ok(rows(traces).some((row) => row.output.includes("LIVE_SKILL_FIRST") && row.output.includes("LIVE_SKILL_RESOURCE")));
    record("next-turn-loaded-skill-and-resource", { ordinaryReadCalls: 2 });

    const modify = await begin(
      `请只调用一次 skills save，完整替换 ${skillName}/SKILL.md，参数：{"action":"save","name":"${skillName}","file":"SKILL.md","content":${JSON.stringify(revisedSkill)}}。等待人工审批，不重试。`,
    );
    const modifyAction = await waitForTest(
      async () => (await client.pending()).find((item) => item.runId === modify.runId),
      "modify approval",
      120_000,
    );
    assert.equal(modifyAction.preview.before, firstSkill);
    assert.equal(modifyAction.preview.after, revisedSkill);
    assert.equal(await humanDecision(modifyAction, "approve"), "approve");
    assert.equal((await client.decideApproval(modifyAction.id, "approve")).status, 200);
    await finish(modify);
    assert.equal(await readFile(skillDocPath, "utf8"), revisedSkill);

    const revisedRun = await begin(
      "继续同一空间。请只用普通 read 工具读取以下绝对路径一次，不要使用 skills 工具：" +
      `${JSON.stringify(skillDocPath)}。读取完成后复述文件中的原始指令；不要提前编造。`,
    );
    traces = await finish(revisedRun);
    const revisedReads = toolCalls(traces).filter((call) => call.name === "read");
    assert.equal(revisedReads.length, 1);
    assert.equal(revisedReads[0].arguments.path, skillDocPath);
    const revisedResults = allToolResults(traces);
    assert.ok(revisedResults.includes("LIVE_SKILL_REVISED"));
    assert.ok(revisedResults.lastIndexOf("LIVE_SKILL_REVISED") > revisedResults.lastIndexOf("LIVE_SKILL_FIRST"));
    assert.ok(rows(traces).some((row) => row.output.includes("LIVE_SKILL_REVISED") && !row.output.includes("LIVE_SKILL_FIRST")));
    record("approved-modification-and-next-turn-read", { ordinaryReadCalls: 1 });

    const denyRun = await begin(
      `请只调用一次 skills save，完整替换 ${skillName}/SKILL.md，参数：{"action":"save","name":"${skillName}","file":"SKILL.md","content":${JSON.stringify(deniedSkill)}}。等待人工审批，不重试。`,
    );
    const denyAction = await waitForTest(
      async () => (await client.pending()).find((item) => item.runId === denyRun.runId),
      "denied modification approval",
      120_000,
    );
    assert.equal(denyAction.preview.after, deniedSkill);
    assert.equal(await humanDecision(denyAction, "deny"), "deny");
    assert.equal((await client.decideApproval(denyAction.id, "deny")).status, 200);
    await finish(denyRun);
    assert.equal((await client.approval(denyAction.id)).status, "denied");
    assert.equal(await readFile(skillDocPath, "utf8"), revisedSkill);
    record("human-refusal-no-overwrite", { status: "denied" });

    const stopRun = await begin(
      `请只调用一次 skills save，完整替换 ${skillName}/SKILL.md，参数：{"action":"save","name":"${skillName}","file":"SKILL.md","content":${JSON.stringify(stoppedSkill)}}。等待人工审批，不重试。`,
    );
    const stopAction = await waitForTest(
      async () => (await client.pending()).find((item) => item.runId === stopRun.runId),
      "stopped modification approval",
      120_000,
    );
    assert.equal(stopAction.preview.after, stoppedSkill);
    assert.equal(await humanDecision(stopAction, "cancel"), "cancel");
    await client.json("/api/conversation/stop", { spaceId, runId: stopRun.runId });
    await finish(stopRun, "RUN_ERROR");
    const stopped = await client.approval(stopAction.id);
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.decidedAt, null);
    assert.equal(await readFile(skillDocPath, "utf8"), revisedSkill);
    record("human-stop-cancels-approval", { status: "cancelled", decidedAt: null });
    await absent(join(dataDir, "skills", skillName, "extension.ts"));
    assert.ok(proxy.traces.filter((row) => !row.child).every((row) => !row.toolNames.includes("bash")));
  } catch (error) {
    results.push({ name: "skill-authoring-live", passed: false });
    process.stdout.write(`[FAIL] skill-authoring-live: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}\n`);
    process.exitCode = 1;
  } finally {
    let cleanupFailed = false;
    try {
      if (service) await service.close();
    } catch { cleanupFailed = true; }
    if (http) {
      if ("closeAllConnections" in http) http.closeAllConnections();
      await new Promise<void>((resolve) => http!.close(() => resolve()));
    }
    try { await proxy?.close(); } catch { cleanupFailed = true; }
    if (root) {
      if (options.keepArtifacts) {
        const summary = redactApiKey(JSON.stringify({ version, results, traces: proxy?.traces }, null, 2), model.apiKey);
        await writeFile(join(root, "summary.json"), summary, { mode: 0o600 });
        process.stdout.write(`合成测试数据与脱敏证据保留于 ${root}\n`);
      } else await rm(root, { recursive: true, force: true });
    }
    if (cleanupFailed) {
      process.stderr.write("Live test resource cleanup failed\n");
      process.exitCode = 1;
    }
    process.stdout.write(`serviceVersion: ${JSON.stringify(version ?? null)}\n`);
  }
};

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") process.stdout.write(parsed.help);
else if (parsed.kind === "error") {
  process.stderr.write(parsed.message + "\n");
  process.exitCode = 2;
} else await execute(parsed.options).catch(() => {
  process.stderr.write("Live setup/report failed; configuration and provider details are not printed.\n");
  process.exitCode = 1;
});
