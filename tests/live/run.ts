import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";

type Result = { name: string; passed: boolean; evidence?: unknown };
const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  // 只有显式授权后才加载SDK与配置；不接受原配置的runtime或其他业务设置。
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient, waitForTest } = await import("../support/http-client.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Model configuration is required");
  process.stdout.write("真实模型验收已显式授权：合成测试会产生模型费用，所有文件/审批仅操作隔离实例。\n");
  const results: Result[] = [];
  let scenario = "initialization";
  let root: string | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let target: ReturnType<typeof createServer> | undefined;
  let baseUrl = "";
  let version: unknown;
  const hits: { path: string; closed: boolean; finished: boolean }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stopService = async () => {
    const current = service; const server = http; service = undefined; http = undefined;
    try { await current?.close(); }
    finally {
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  };
  const record = (name: string, evidence: unknown = {}) => {
    results.push({ name, passed: true, evidence }); process.stdout.write(`[PASS] ${name}\n`);
  };
  const absent = (file: string) => assert.rejects(stat(file), { code: "ENOENT" });
  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-live-"));
    const dataDir = join(root, "data"); await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
    target = createServer((request, response) => {
      const hit = { path: request.url ?? "", closed: false, finished: false }; hits.push(hit);
      if (hit.path === "/slow-body") { response.writeHead(200, { "Content-Type": "text/plain" }); response.write("partial body"); }
      const timer = setTimeout(() => { hit.finished = true; response.end("too late"); }, 55_000); timers.add(timer);
      response.once("close", () => { hit.closed = true; clearTimeout(timer); timers.delete(timer); });
    });
    target.listen(0, "127.0.0.1"); await once(target, "listening");
    const address = target.address(); assert.ok(address && typeof address !== "string");
    const fixtureUrl = `http://127.0.0.1:${address.port}`;
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-isolated-access" },
      model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: "proxy-placeholder", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      runtime: { dataDir, runTimeoutMs: 180_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
      tools: { weather: { enabled: false }, web: { allowPrivateTargets: true, timeoutMs: 60_000 }, presentation: { default: "summary" } },
    });
    const startService = async () => {
      service = await createService(config);
      http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
      if (!http.listening) await once(http, "listening");
      const address = http.address(); assert.ok(address && typeof address !== "string");
      baseUrl = `http://127.0.0.1:${address.port}`;
    };
    await startService();
    const login = await fetch(baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "live-isolated-access" }), signal: AbortSignal.timeout(5000) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const client = createTestClient(() => baseUrl, token, 190_000);
    version = (await client.json("/api/health")).serviceVersion;
    const wait = <T>(check: () => T | Promise<T>, label: string, timeoutMs = 90_000) => waitForTest(check, label, timeoutMs);
    const begin = async (name: string, prompt: string, threadId = "live-" + name) => {
      scenario = name;
      const baseline = proxy!.traces.length;
      const running = await client.startRun(prompt, threadId);
      return { ...running, baseline };
    };
    const finish = async (running: Awaited<ReturnType<typeof begin>>, type = "RUN_FINISHED") => {
      const events = await running.done;
      assert.equal(events.at(-1)?.type, type);
      return proxy!.traces.slice(running.baseline);
    };
    const delegate = (params: object) => "这是隔离真实验收，请只调用一次subagent，严格使用参数：" + JSON.stringify(params) + "。不要自行执行子任务，不另起委派，不编造结果；等工具返回后简短总结。";
    type Rows = Awaited<ReturnType<typeof finish>>;
    const toolResults = (rows: Rows) => rows.flatMap((row) => row.toolResults).join("\n");
    const dispatch = (rows: Rows) => {
      const calls = rows.filter((row) => !row.child).flatMap((row) => row.calls).filter((call) => call.name === "subagent");
      assert.equal(calls.length, 1); return JSON.parse(calls[0].arguments);
    };

    const single = await begin("single", delegate({ agent: "worker", task: "实际调用currentTime一次，只回复LIVE-SINGLE与工具中的ISO时间。不要写文件。" }));
    let rows = await finish(single); dispatch(rows);
    assert.ok(rows.some((row) => row.child && row.calls.some((call) => call.name === "currentTime")));
    assert.match(toolResults(rows.filter((row) => row.child)), /ISO 8601/);
    assert.match(toolResults(rows.filter((row) => !row.child)), /LIVE-SINGLE/);
    record(scenario, { actualChildTool: "currentTime", resultReturnedToParent: true });

    const parallel = await begin("parallel", delegate({ tasks: [{ agent: "scout", task: "实际调用currentTime一次，只回复LIVE-PARA-A与ISO时间。" }, { agent: "reviewer", task: "实际调用currentTime一次，只回复LIVE-PARA-B与ISO时间。" }] }));
    rows = await finish(parallel); assert.equal(dispatch(rows).tasks.length, 2);
    const initial = rows.filter((row) => row.child && row.toolResults.length === 0); assert.equal(initial.length, 2);
    assert.ok(initial.every((row) => row.calls.some((call) => call.name === "currentTime")));
    assert.ok(Math.max(...initial.map((row) => row.startedAt)) < Math.min(...initial.map((row) => row.endedAt!)));
    const parentResults = toolResults(rows.filter((row) => !row.child));
    assert.match(parentResults, /LIVE-PARA-A/); assert.match(parentResults, /LIVE-PARA-B/);
    record(scenario, { actualConcurrentChildren: 2, bothResultsReturned: true });

    const chain = await begin("chain", delegate({ chain: [{ agent: "worker", task: "实际调用currentTime一次，只回复LIVE-CHAIN-ONE与ISO时间。" }, { agent: "reviewer", task: "上一步结果：{previous}。实际调用currentTime一次，再回复LIVE-CHAIN-TWO并保留上一步真实结果。" }] }));
    rows = await finish(chain); assert.equal(dispatch(rows).chain.length, 2);
    const chainInitial = rows.filter((row) => row.child && row.toolResults.length === 0); assert.equal(chainInitial.length, 2);
    assert.match(chainInitial[1].users.at(-1)!, /LIVE-CHAIN-ONE/); assert.ok(!chainInitial[1].users.at(-1)!.includes("{previous}"));
    assert.ok(chainInitial.every((row) => row.calls.some((call) => call.name === "currentTime")));
    const firstOutput = rows.find((row) => row.child && row.toolResults.length > 0)?.output;
    assert.equal(typeof firstOutput, "string"); assert.ok(firstOutput);
    assert.ok(chainInitial[1].users.at(-1)!.includes(firstOutput.trim()), "second child must receive actual first output");
    assert.match(toolResults(rows.filter((row) => !row.child)), /LIVE-CHAIN-TWO/);
    record(scenario, { previousResultSubstituted: true, chainResultReturned: true });

    scenario = "isolation";
    await client.json("/api/threads/live-isolation/instructions", { instructions: "PARENT-RULE-NOT-COPIED-582c" }, "PUT");
    await writeFile(join(dataDir, "workspace/threads/live-isolation/private.txt"), "PRIVATE-NO-LEAK-421e", { mode: 0o600 });
    await writeFile(join(dataDir, "workspace/shared/live-shared.txt"), "LIVE-SHARED-OK-a7cd", { mode: 0o600 });
    const isolation = await begin(scenario, delegate({ agent: "worker", task: "实际调用read三次：private.txt、shared/live-shared.txt、../live-isolation/private.txt。仅根据工具结果报告，不猜测，不写文件。" }));
    rows = await finish(isolation); dispatch(rows);
    const childRows = rows.filter((row) => row.child); const facts = toolResults(childRows);
    assert.match(facts, /File not found/); assert.match(facts, /LIVE-SHARED-OK-a7cd/); assert.match(facts, /Access denied/);
    assert.ok(!JSON.stringify(childRows).includes("PRIVATE-NO-LEAK-421e"));
    record(scenario, { privateRootDenied: true, sharedRead: true });

    for (const decision of ["approve", "deny", "cancel"] as const) {
      const name = "approval-" + decision;
      const path = `shared/live-${decision}.txt`; const content = "LIVE-" + decision.toUpperCase() + "-CONTENT";
      const running = await begin(name, delegate({ agent: "worker", task: `只调用一次write，path=${path}，content精确为${content}。等待人工审批，不假设批准，不改路径，不重试；如实返回工具结果。` }));
      const action = await wait(async () => (await client.json("/api/actions/pending")).actions.find((item: { runId: string }) => item.runId === running.runId), "child approval");
      assert.equal(action.threadId, running.threadId); assert.equal(action.payload.path, path); assert.equal(action.payload.content, content);
      await absent(join(dataDir, "workspace", path));
      if (decision === "cancel") {
        const start = Date.now(); assert.equal((await client.json("/api/conversation/stop", { threadId: running.threadId, runId: running.runId })).stopped, true);
        const elapsedMs = Date.now() - start; assert.ok(elapsedMs < 3000); await finish(running, "RUN_ERROR");
        assert.equal((await client.json(`/api/actions/${action.id}`)).status, "cancelled"); await absent(join(dataDir, "workspace", path));
        record(name, { elapsedMs, noWrite: true });
      } else {
        assert.equal((await client.request(`/api/actions/${action.id}/decide`, { decision })).status, 200);
        rows = await finish(running); assert.ok(rows.some((row) => row.child && row.calls.some((call) => call.name === "write")));
        assert.equal((await client.json(`/api/actions/${action.id}`)).status, decision === "approve" ? "approved" : "denied");
        if (decision === "approve") assert.equal(await readFile(join(dataDir, "workspace", path), "utf8"), content); else await absent(join(dataDir, "workspace", path));
        record(name, { written: decision === "approve", ownedByParentRun: true });
      }
    }

    const generating = await begin("model-stop", delegate({ agent: "worker", task: "不用任何工具，不写文件，连续输出3000条编号清单，每条20字，不省略不总结。" }));
    const activeModel = await wait(() => proxy!.traces.find((row) => row.index >= generating.baseline && row.child && !row.endedAt), "active child model");
    let start = Date.now(); assert.equal((await client.json("/api/conversation/stop", { threadId: generating.threadId, runId: generating.runId })).stopped, true);
    const modelStopMs = Date.now() - start; await finish(generating, "RUN_ERROR");
    await wait(() => activeModel.disconnected, "model socket close", 3000); assert.ok(modelStopMs < 3000); record(scenario, { elapsedMs: modelStopMs, modelDisconnected: true });

    for (const phase of ["headers", "body"] as const) {
      const path = phase === "body" ? "/slow-body" : "/slow";
      const running = await begin("web-stop-" + phase, delegate({ agent: "worker", task: `实际调用一次web_fetch读取${fixtureUrl}${path}，不要改URL，不搜索不写文件，等待真实结果。` }));
      const hit = await wait(() => hits.find((entry) => entry.path === path), "slow HTTP fixture");
      start = Date.now(); assert.equal((await client.json("/api/conversation/stop", { threadId: running.threadId, runId: running.runId })).stopped, true);
      const elapsedMs = Date.now() - start; rows = await finish(running, "RUN_ERROR");
      assert.ok(rows.some((row) => row.child && row.calls.some((call) => call.name === "web_fetch")));
      await wait(() => hit.closed, "web socket close", 3000); assert.equal(hit.finished, false); assert.ok(elapsedMs < 3000);
      record(scenario, { elapsedMs, socketClosed: true, fixtureFinished: false });
      const follow = await begin("after-stop-" + phase, "不要调用子代理，只实际调用currentTime一次，再回复LIVE-AFTER-STOP。", running.threadId);
      rows = await finish(follow); assert.ok(rows.some((row) => !row.child && row.calls.some((call) => call.name === "currentTime"))); record(scenario, { sameThreadCompleted: true });
    }

    scenario = "permissions-and-old-queue";
    assert.ok(proxy.traces.filter((row) => row.child).every((row) => !row.toolNames.some((name) => ["bash", "subagent", "delegate_task", "schedule", "monitor", "instructions"].includes(name))));
    assert.ok((await readdir(join(dataDir, "sessions"))).every((name) => !name.startsWith("subagent-"))); await absent(join(dataDir, "tasks.json"));
    assert.equal((await client.request("/api/agent/tasks", { prompt: "must not execute" })).status, 501);
    assert.equal(Object.hasOwn(await client.json("/api/agent"), "worker"), false); record(scenario);

    scenario = "restart";
    const threads = (await client.json("/api/threads")).threads as { id: string }[];
    const histories = Object.fromEntries(await Promise.all(threads.map(async (thread) => [thread.id, await client.history(thread.id)])));
    const actions = await readFile(join(dataDir, "actions.json"), "utf8");
    const sharedHashes = async () => Object.fromEntries(await Promise.all((await readdir(join(dataDir, "workspace/shared"))).map(async (name) => [name, createHash("sha256").update(await readFile(join(dataDir, "workspace/shared", name))).digest("hex")])));
    const hashes = await sharedHashes(); const requestCount = proxy.traces.length;
    await stopService(); await startService();
    for (const thread of threads) assert.deepEqual(await client.history(thread.id), histories[thread.id]);
    assert.equal(await readFile(join(dataDir, "actions.json"), "utf8"), actions); assert.deepEqual(await sharedHashes(), hashes);
    assert.deepEqual((await client.json("/api/actions/pending")).actions, []); assert.equal(proxy.traces.length, requestCount);
    record(scenario, { threads: threads.length, historiesAndFilesEqual: true, automaticModelRequests: 0 });
  } catch {
    results.push({ name: scenario, passed: false }); process.stdout.write(`[FAIL] ${scenario}: expected tool/state evidence was not observed; no automatic retry.\n`); process.exitCode = 1;
  } finally {
    let cleanupFailed = false;
    try { await stopService(); } catch { cleanupFailed = true; }
    for (const timer of timers) clearTimeout(timer);
    if (target) { target.closeAllConnections(); await new Promise<void>((resolve) => target!.close(() => resolve())); }
    try { await proxy?.close(); } catch { cleanupFailed = true; }
    if (cleanupFailed) { process.stderr.write("Live test resource cleanup failed\n"); process.exitCode = 1; }
    if (root) {
      if (options.keepArtifacts) {
        const summary = redactApiKey(JSON.stringify({ version, results, traces: proxy?.traces, fixtureHits: hits }, null, 2), model.apiKey);
        await writeFile(join(root, "summary.json"), summary, { mode: 0o600 });
        process.stdout.write(`合成测试数据与脱敏证据保留于 ${root}\n`);
      } else await rm(root, { recursive: true, force: true });
    }
    process.stdout.write(`serviceVersion: ${JSON.stringify(version ?? null)}\n`);
  }
};

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") process.stdout.write(parsed.help);
else if (parsed.kind === "error") { process.stderr.write(parsed.message + "\n"); process.exitCode = 2; }
else await execute(parsed.options).catch(() => { process.stderr.write("Live setup/report failed; configuration and provider details are not printed.\n"); process.exitCode = 1; });
