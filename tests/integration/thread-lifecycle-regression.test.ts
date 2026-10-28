import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createMonitorScheduler } from "../../src/features/monitors/monitor-scheduler.js";
import { threadWorkspaceDir } from "../../src/adapters/storage/data-layout.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
};
const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-thread-regression-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const releaseGates: (() => void)[] = [];
  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };
  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { presentation: { overrides: { read: "summary" } } },
  });
  let baseUrl = "";
  const start = async () => {
    service = await createService(config);
    server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  await start();
  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const snapshot = async (id: string) => {
    const response = await request(`/api/conversation?spaceId=${id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ sessionId: string | null; messages: { role: string; content?: string }[]; revision: string }>;
  };
  const listed = async (id: string) => {
    const response = await request("/api/spaces");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { spaces?: { id: string }[]; threads?: { id: string }[] };
    return (body.spaces || body.threads || []).some((thread: { id: string }) => thread.id === id);
  };
  const run = async (id: string, text: string) => {
    const before = await snapshot(id);
    const response = await request("/api/conversation/run", "POST", {
      spaceId: id, runId: randomUUID(), expectedRevision: before.revision,
      message: { id: randomUUID(), content: text },
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /RUN_FINISHED/);
    return stream;
  };
  return { dir, model, service: () => service!, request, snapshot, listed, run, releaseGates,
    restart: async () => { await stop(); await start(); } };
};
const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

test("thread reads and late stop never create absent or deleted sessions, including during deletion", async (t) => {
  const h = await fixture(t);
  const id = "deleted-read";
  assert.deepEqual(await h.snapshot(id), { sessionId: null, messages: [], revision: "empty" });
  assert.equal(await h.listed(id), false);
  await assertMissing(join(h.dir, "sessions", id));
  await assertMissing(join(h.dir, "workspace", "threads", id));
  assert.equal((await h.request(`/api/spaces/${id}/instructions`, "PUT", { instructions: "test" })).status, 200);
  const entered = deferred();
  const proceed = deferred();
  const removeJobs = h.service().jobs.removeByOriginSpaceId;
  h.service().jobs.removeByOriginSpaceId = async (origin) => {
    entered.resolve(); await proceed.promise;
    return removeJobs(origin);
  };
  h.releaseGates.push(proceed.resolve);
  const deleting = h.request(`/api/spaces/${id}`, "DELETE");
  await entered.promise;
  assert.deepEqual(await h.snapshot(id), { sessionId: null, messages: [], revision: "empty" });
  const stop = await h.request("/api/conversation/stop", "POST", { spaceId: id, runId: "old" });
  assert.deepEqual(await stop.json(), { stopped: false });
  for (const [path, body] of [
    [`/api/spaces/${id}/instructions`, { instructions: "late" }],
    ["/api/monitors", { url: "https://example.com", condition: "change", originSpaceId: id }],
  ] as const) {
    const response = await h.request(path, path.includes("instructions") ? "PUT" : "POST", body);
    assert.equal(response.status, 409, path);
    assert.match(await response.text(), /(SPACE|THREAD)_DELETING/);
  }
  proceed.resolve();
  assert.equal((await deleting).status, 200);
  h.service().jobs.removeByOriginSpaceId = removeJobs;
  assert.deepEqual(await h.snapshot(id), { sessionId: null, messages: [], revision: "empty" });
  await h.request("/api/conversation/stop", "POST", { spaceId: id, runId: "old" });
  assert.equal(await h.listed(id), false);
  await assertMissing(join(h.dir, "sessions", id));
  await assertMissing(join(h.dir, "workspace", "threads", id));
  // 显式发起新一轮仍可复用 ID，但读取历史和迟到 stop 不代表创建意图。
  await h.run(id, "hello intentional recreate");
  assert.equal(await h.listed(id), true);
});

test("history reads remain side-effect free while unrelated threads are deleted", async (t) => {
  const h = await fixture(t);
  for (let index = 0; index < 12; index++) await h.service().conversationHub.forSpace(`list-race-${index}`);
  const responses = await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => h.request(`/api/spaces/list-race-${index}`, "DELETE")),
    ...Array.from({ length: 30 }, (_, index) => h.request(`/api/conversation?spaceId=never-created-${index}`)),
    ...Array.from({ length: 15 }, () => h.request("/api/spaces")),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  const listing = (await (await h.request("/api/spaces")).json()) as { spaces?: { id: string }[]; threads?: { id: string }[] };
  assert.deepEqual((listing.spaces || listing.threads || []).map((thread: { id: string }) => thread.id), ["local-main"]);
});

test("new monitor source receives notifications and deleted monitor snapshots cannot rebuild it", async (t) => {
  const h = await fixture(t);
  const id = "new-monitor-source";
  const response = await h.request("/api/monitors", "POST", {
    title: "MONITOR-ORIGIN", url: "https://example.com", condition: "contains", value: "MATCH", originSpaceId: id,
  });
  assert.equal(response.status, 200);
  const monitor = await response.json() as { id: string };
  await h.service().monitors.check(monitor.id, { body: "MATCH-FACT" });
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10 }, h.service().monitors,
    await h.service().conversationHub.forSpace("local-main"), (thread) => h.service().conversationHub.findThread(thread));
  scheduler.start();
  try {
    await until(async () => JSON.stringify(await h.snapshot(id)).includes("MONITOR-ORIGIN"));
    assert.doesNotMatch(JSON.stringify(await h.snapshot("local-main")), /MONITOR-ORIGIN/);
    assert.equal((await h.request(`/api/spaces/${id}`, "DELETE")).status, 200);
    await h.snapshot(id);
    assert.equal(await h.listed(id), false);
    await assertMissing(join(h.dir, "sessions", id));
  } finally { await scheduler.close(); }
});

test("missing-file diagnostics are safe in SSE, next model request, JSONL and reopened history", async (t) => {
  const h = await fixture(t);
  const id = "safe-file-error";
  const stream = await h.run(id, "读 absent-file.md");
  const messages = (await h.snapshot(id)).messages;
  const files = (await readdir(join(h.dir, "sessions", id))).filter((file) => file.endsWith(".jsonl"));
  const raw = (await Promise.all(files.map((file) => readFile(join(h.dir, "sessions", id, file), "utf8")))).join("\n");
  const toolRecords = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
  assert.equal(toolRecords.length, 1);
  assert.match(JSON.stringify(toolRecords), /File not found/);
  const modelToolResults = h.model.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool"));
  assert.ok(modelToolResults.length > 0);
  const physical = await realpath(h.dir);
  for (const value of [stream, JSON.stringify(messages), JSON.stringify(toolRecords), JSON.stringify(modelToolResults)]) {
    assert.ok(!value.includes(h.dir) && !value.includes(physical), value);
    assert.doesNotMatch(value, /ENOENT|lstat/);
  }
  assert.match(JSON.stringify(messages), /File not found/);
  await h.restart();
  assert.deepEqual((await h.snapshot(id)).messages, messages);
});

test("space reset: new sessionId generated, history cleared, workspace/instructions/skills survive, approvals cancelled, schedules conditionally cleared", async (t) => {
  const h = await fixture(t);
  const spaceId = "reset-space-test";

  // 1. 发起一轮对话，产生会话历史
  await h.run(spaceId, "hello before reset");
  const beforeSnapshot = await h.snapshot(spaceId);
  assert.ok(beforeSnapshot.messages.length > 0);

  // 2. 设置空间规则与技能覆盖
  const instRes = await h.request(`/api/spaces/${spaceId}/instructions`, "PUT", {
    instructions: "KEEP-THESE-INSTRUCTIONS",
  });
  assert.equal(instRes.status, 200);

  const skillsRes = await h.request(`/api/spaces/${spaceId}/skills`, "PUT", {
    overrides: { cron: false, web: false },
  });
  assert.equal(skillsRes.status, 200);

  // 3. 在工作区中写入文件
  const wsDir = threadWorkspaceDir(h.service().layout, spaceId);
  await writeFile(join(wsDir, "my-note.md"), "WORKSPACE-FILE-CONTENT", "utf-8");

  // 4. 添加定时任务与监控
  await h.service().jobs.add("bound reminder", false, new Date(0).toISOString(), spaceId);
  await h.service().monitors.create({
    url: "https://example.com/test",
    condition: "change",
    originSpaceId: spaceId,
  });

  // 5. 提交一个属于该空间的待审批
  const pendingAction = await h.service().actions.submit("file_write", "test write", {
    path: "test.txt",
    originalContent: "",
    content: "hello",
  }, { spaceId });
  assert.equal(pendingAction.status, "pending");

  // 确认初始列表信息包含 spaceId 和 sessionId
  const spacesListBefore = await (await h.request("/api/spaces")).json() as { spaces: { id: string; sessionId: string }[] };
  const spaceEntryBefore = spacesListBefore.spaces.find((s) => s.id === spaceId);
  assert.ok(spaceEntryBefore);
  const originalSessionId = spaceEntryBefore.sessionId;

  // 6. 执行默认重置（clearSchedules: false）
  const resetRes1 = await h.request(`/api/spaces/${spaceId}/reset`, "POST", { clearSchedules: false });
  assert.equal(resetRes1.status, 200);
  const resetBody1 = await resetRes1.json() as {
    ok: boolean;
    spaceId: string;
    sessionId: string;
    cancelledApprovals: number;
    removed: { jobs: number; monitors: number };
  };
  assert.equal(resetBody1.ok, true);
  assert.equal(resetBody1.spaceId, spaceId);
  assert.notEqual(resetBody1.sessionId, originalSessionId);
  assert.equal(resetBody1.cancelledApprovals, 1);
  assert.deepEqual(resetBody1.removed, { jobs: 0, monitors: 0 });

  // 7. 验证会话历史已清空，但工作区、指令、技能保留
  const afterSnapshot = await h.snapshot(spaceId);
  assert.deepEqual(afterSnapshot.messages, []);

  const instAfter = await (await h.request(`/api/spaces/${spaceId}/instructions`)).json() as { instructions: string };
  assert.ok(instAfter.instructions.includes("KEEP-THESE-INSTRUCTIONS"));

  const skillsAfter = await (await h.request(`/api/spaces/${spaceId}/skills`)).json() as { skills: { name: string; enabled: boolean }[] };
  assert.equal(skillsAfter.skills.find((s) => s.name === "cron")?.enabled, false);

  assert.equal(await readFile(join(wsDir, "my-note.md"), "utf-8"), "WORKSPACE-FILE-CONTENT");

  // 验证审批已取消
  const actionAfter = await h.service().actions.get(pendingAction.id);
  assert.equal(actionAfter?.status, "cancelled");

  // 验证定时任务和监控仍保留
  assert.ok((await h.service().jobs.list()).some((j) => j.originSpaceId === spaceId));
  assert.ok((await h.service().monitors.list()).some((m) => m.originSpaceId === spaceId));

  // 8. 再次重置，传入 clearSchedules: true
  const resetRes2 = await h.request(`/api/spaces/${spaceId}/reset`, "POST", { clearSchedules: true });
  assert.equal(resetRes2.status, 200);
  const resetBody2 = await resetRes2.json() as typeof resetBody1;
  assert.equal(resetBody2.ok, true);
  assert.deepEqual(resetBody2.removed, { jobs: 1, monitors: 1 });

  // 验证定时任务和监控被级联清除
  assert.ok(!(await h.service().jobs.list()).some((j) => j.originSpaceId === spaceId));
  assert.ok(!(await h.service().monitors.list()).some((m) => m.originSpaceId === spaceId));
});

test("space reset during in-flight active run with pending approval reports cancelledApprovals: 1", async (t) => {
  const h = await fixture(t);
  const spaceId = "reset-inflight-approval";

  // 1. 发起会话，触发写文件审批（"帮我写入草稿" 会让 fakeModel 触发 write 工具调用）
  const runPromise = h.request("/api/conversation/run", "POST", {
    spaceId: spaceId,
    runId: randomUUID(),
    expectedRevision: "empty",
    message: { id: randomUUID(), content: "帮我写入草稿" },
  });

  // 2. 等待审批登记且状态为 pending
  await until(async () => {
    const pendings = await h.service().actions.snapshotPending();
    return pendings.some((a) => a.spaceId === spaceId);
  });
  const pendingsBefore = await h.service().actions.snapshotPending();
  const pending = pendingsBefore.find((a) => a.spaceId === spaceId)!;
  assert.equal(pending.status, "pending");

  // 3. 在运行中且审批 pending 状态下调用 reset
  const resetRes = await h.request(`/api/spaces/${spaceId}/reset`, "POST", { clearSchedules: false });
  assert.equal(resetRes.status, 200);
  const resetBody = (await resetRes.json()) as {
    ok: boolean;
    spaceId: string;
    sessionId: string;
    cancelledApprovals: number;
  };
  assert.equal(resetBody.ok, true);
  assert.equal(resetBody.cancelledApprovals, 1);

  // 等待在途 run 结束
  await runPromise;

  // 4. 验证该审批变为 cancelled，pending 列表为空
  const actionAfter = await h.service().actions.get(pending.id);
  assert.equal(actionAfter?.status, "cancelled");
  const pendingsAfter = await h.service().actions.snapshotPending();
  assert.equal(pendingsAfter.filter((a) => a.spaceId === spaceId).length, 0);

  // 5. 验证历史已清空，可开启新对话
  const snapshot = await h.snapshot(spaceId);
  assert.deepEqual(snapshot.messages, []);
});
