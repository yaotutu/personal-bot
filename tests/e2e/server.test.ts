import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFakeModel } from "../support/fake-model.js";
import { createServiceProcess } from "../support/service-process.js";
import { createTestClient, waitForTest } from "../support/http-client.js";
import { agentSnapshot } from "../../src/http/contracts/responses.js";
import { approvalView } from "../../src/http/contracts/approvals.js";
import { workspaceEvents } from "../../src/http/contracts/workspace-events.js";

const fixture = async (t: TestContext) => {
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  // 在进程支架之前登记provider回收，避免启动失败留下监听端口。
  t.after(async () => { try { await service?.close(); } finally { await model?.close(); } });
  let service: Awaited<ReturnType<typeof createServiceProcess>> | undefined;
  model = await createFakeModel();
  service = await createServiceProcess(t, { modelBaseUrl: model.baseUrl });
  const response = await fetch(service.baseUrl + "/api/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: service.accessKey }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return { service, model, token: token as string, client: createTestClient(() => service!.baseUrl, token) };
};
const terminalSuccess = (events: { type: string }[]) => assert.equal(events.at(-1)?.type, "RUN_FINISHED");
const userText = (value: unknown) => typeof value === "string" ? value : Array.isArray(value) ? value.map((item) => item.text ?? "").join("") : "";
const childRequest = (request: { messages: { role: string; content: unknown }[] }) =>
  request.messages.some((message) => message.role === "system" && userText(message.content).includes("## Subagent role"));

test("e2e: built entry authenticates, streams tools, persists state and restarts with the same token/history", { timeout: 90_000 }, async (t) => {
  const { service, client, token } = await fixture(t);
  assert.equal((await fetch(service.baseUrl + "/api/agent", { signal: AbortSignal.timeout(5000) })).status, 401);
  const wrong = await fetch(service.baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "wrong" }), signal: AbortSignal.timeout(5000) });
  assert.equal(wrong.status, 401);
  const health = await client.json("/api/health");
  const spec = await client.json("/openapi.json");
  assert.equal(health.serviceVersion.mode, "build");
  assert.deepEqual(health.serviceVersion, spec["x-service-version"]);
  assert.equal(spec.paths["/api/agent/tasks"], undefined);
  assert.equal((await client.request("/api/agent/tasks", { prompt: "legacy must not execute" })).status, 501);
  assert.match(await (await client.request("/docs")).text(), /scalar\.js/);
  const timeEvents = await client.run("现在几点", "e2e-main");
  terminalSuccess(timeEvents);
  assert.ok(timeEvents.some((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "currentTime"));
  await client.run("记住E2E记忆", "e2e-main");
  const snapshot = agentSnapshot.parse(await client.json("/api/agent"));
  assert.ok(snapshot.memories.some((memory) => memory.text.includes("E2E记忆")));
  assert.equal(Object.hasOwn(snapshot, "worker"), false);
  await client.json("/api/threads/e2e-main/instructions", { instructions: "E2E-INSTRUCTIONS" }, "PUT");
  const before = await client.history("e2e-main");
  await service.restart();
  assert.deepEqual(await client.history("e2e-main"), before);
  assert.equal((await client.request("/api/agent")).status, 200, "auth.key and token survive process restart");
  assert.equal(await readFile(join(service.dataDir, "sessions/e2e-main/INSTRUCTIONS.md"), "utf8"), "E2E-INSTRUCTIONS\n");
  assert.equal(typeof token, "string");
  terminalSuccess(await client.run("hello after restart", "e2e-main"));
  assert.match(JSON.stringify(await client.history("e2e-main")), /after restart/);
});

test("e2e: parent dispatches single, concurrent and chained subagents without a second task queue", { timeout: 90_000 }, async (t) => {
  const { service, model, client } = await fixture(t);
  terminalSuccess(await client.run("E2E single", "e2e-subagent"));
  const parallelStart = model.requests.length;
  terminalSuccess(await client.run("E2E parallel", "e2e-subagent"));
  const parallelChildren = model.requests.map((request, index) => ({ request, timing: model.requestTimings[index], index }))
    .filter(({ request, index }) => index >= parallelStart && childRequest(request) && !request.messages.some((message) => message.role === "tool"));
  assert.equal(parallelChildren.length, 2);
  assert.ok(Math.max(...parallelChildren.map(({ timing }) => timing.startedAt)) < Math.min(...parallelChildren.map(({ timing }) => timing.endedAt!)), "two provider requests must actually overlap");
  const chainStart = model.requests.length;
  terminalSuccess(await client.run("E2E chain", "e2e-subagent"));
  const chainChildren = model.requests.slice(chainStart).filter(childRequest);
  assert.equal(chainChildren.length, 2);
  assert.ok(chainChildren.some((request) => request.messages.some((message) => message.role === "user" && userText(message.content) === "Task: E2E previous E2E-CHAIN-SEED")));
  for (const request of model.requests.filter(childRequest)) {
    const names = (request.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(!names.some((name) => ["bash", "subagent", "schedule", "monitor", "instructions", "delegate_task"].includes(name)));
    assert.ok(!request.messages.some((message) => message.role === "user" && userText(message.content) === "E2E parallel"));
  }
  assert.ok((await readdir(join(service.dataDir, "sessions"))).every((name) => !name.startsWith("subagent-")));
  await assert.rejects(stat(join(service.dataDir, "tasks.json")), { code: "ENOENT" });
  await client.json("/api/threads/e2e-subagent/skills", { overrides: { task: false } }, "PUT");
  const disabledStart = model.requests.length;
  terminalSuccess(await client.run("plain check", "e2e-subagent"));
  assert.ok(!(model.requests[disabledStart].tools as { function: { name: string } }[]).some((tool) => tool.function.name === "subagent"));
});

for (const decision of ["approve", "deny", "cancel"] as const) {
  test(`e2e: subagent file approval ${decision} preserves ownership and filesystem truth`, { timeout: 90_000 }, async (t) => {
    const { service, client } = await fixture(t);
    const running = await client.startRun("请子代理写入", "e2e-approval");
    // 主同步来源仍为 SSE ready 的完整集合，HTTP pending 只是补充只读入口。
    const action = await waitForTest(async () => (await client.pending()).find((item) => item.runId === running.runId), "child approval");
    assert.equal(action.threadId, running.threadId);
    assert.equal(action.revision, 1);
    assert.match(action.preview.after, /DRAFT-CONTENT/);
    assert.equal(action.preview.path, "draft.md");
    assert.equal(action.preview.before, "");
    assert.equal(action.preview.beforeExists, false);
    const childDir = (await readdir(join(service.dataDir, "workspace/threads"))).find((name) => name.startsWith("subagent-"));
    assert.ok(childDir);
    const target = join(service.dataDir, "workspace/threads", childDir, "draft.md");
    await assert.rejects(stat(target), { code: "ENOENT" });
    if (decision === "cancel") {
      assert.equal((await client.json("/api/conversation/stop", { threadId: running.threadId, runId: running.runId })).stopped, true);
      const events = await running.done;
      assert.equal(events.at(-1)?.type, "RUN_ERROR");
    } else {
      assert.equal((await client.decideApproval(action.id, decision)).status, 200);
      terminalSuccess(await running.done);
    }
    const settled = await client.approval(action.id);
    assert.equal(settled.status, decision === "approve" ? "approved" : decision === "deny" ? "denied" : "cancelled");
    // 批准、执行开始、执行完成各推进 revision；拒绝/取消只有终态迁移。
    assert.equal(settled.revision, decision === "approve" ? 4 : 2);
    assert.equal(settled.execution?.status ?? null, decision === "approve" ? "succeeded" : null);
    assert.ok(settled.resolvedAt);
    assert.equal(settled.decidedAt === null, decision === "cancel");
    if (decision === "approve") assert.equal(await readFile(target, "utf8"), action.preview.after);
    else await assert.rejects(stat(target), { code: "ENOENT" });
    // 终态审批只出现在历史列表，pending 集合由 ready 给出且已为空。
    assert.deepEqual(await client.pending(), []);
    const page = await client.approvalPage(`?limit=1`);
    assert.equal(page.approvals.length, 1);
    assert.equal(page.approvals[0].id, action.id);
    assert.equal(Object.hasOwn(page.approvals[0], "preview"), false);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    terminalSuccess(await client.run("现在几点", running.threadId));
  });
}

test("e2e: Stop interrupts the child model and real slow HTTP socket, then the same thread remains usable", { timeout: 90_000 }, async (t) => {
  const { model, client } = await fixture(t);
  const started = model.requests.length;
  const child = await client.startRun("请子代理挂起", "e2e-stop");
  await waitForTest(() => model.requests.length >= started + 2, "child provider request");
  const closedBefore = model.slowClosed();
  assert.equal((await client.json("/api/conversation/stop", { threadId: child.threadId, runId: child.runId })).stopped, true);
  assert.equal((await child.done).at(-1)?.type, "RUN_ERROR");
  await waitForTest(() => model.slowClosed() > closedBefore, "child provider disconnect");
  terminalSuccess(await client.run("现在几点", child.threadId));
  let entered = false;
  let closed = false;
  const server = createServer((_request, response) => {
    entered = true;
    response.writeHead(200, { "Content-Type": "text/plain" }); response.write("partial body");
    response.once("close", () => { closed = true; });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const web = await client.startRun(`E2E child-web http://127.0.0.1:${address.port}/slow`, child.threadId);
  await waitForTest(() => entered, "child real HTTP socket");
  const stopStart = Date.now();
  assert.equal((await client.json("/api/conversation/stop", { threadId: web.threadId, runId: web.runId })).stopped, true);
  assert.equal((await web.done).at(-1)?.type, "RUN_ERROR");
  await waitForTest(() => closed, "slow socket closed", 3000);
  assert.ok(Date.now() - stopStart < 3000, "must not wait for web transport timeout");
  terminalSuccess(await client.run("现在几点", web.threadId));
});

test("e2e: private workspaces stay isolated and deleted threads do not revive on reads or late Stop", { timeout: 90_000 }, async (t) => {
  const { service, client } = await fixture(t);
  await client.json("/api/threads/e2e-owner/instructions", { instructions: "owner" }, "PUT");
  await client.json("/api/threads/e2e-other/instructions", { instructions: "other" }, "PUT");
  await writeFile(join(service.dataDir, "workspace/threads/e2e-owner/private.md"), "OWNER-PRIVATE");
  await writeFile(join(service.dataDir, "workspace/shared/shared.md"), "SHARED-OK");
  const missing = await client.run("读 private.md", "e2e-other");
  assert.ok(!JSON.stringify(missing).includes("OWNER-PRIVATE"));
  const shared = await client.run("读 shared/shared.md", "e2e-other");
  assert.match(shared.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join(""), /SHARED-OK/);
  terminalSuccess(await client.run("hello", "e2e-owner"));
  const remove = await client.json("/api/threads/e2e-owner", undefined, "DELETE");
  assert.deepEqual(remove.removed, { jobs: 0, monitors: 0 });
  assert.deepEqual(await client.history("e2e-owner"), { messages: [], revision: "empty" });
  assert.deepEqual(await client.json("/api/conversation/stop", { threadId: "e2e-owner", runId: "late" }), { stopped: false });
  assert.ok(!(await client.json("/api/threads")).threads.some((thread: { id: string }) => thread.id === "e2e-owner"));
  await assert.rejects(stat(join(service.dataDir, "sessions/e2e-owner")), { code: "ENOENT" });
});

test("e2e: workspace named SSE pushes ready state and real run status without memory invalidation frames", { timeout: 90_000 }, async (t) => {
  const { service, client } = await fixture(t);
  const stream = await client.subscribeEvents();
  t.after(async () => { await stream.close(); });
  // ready 是首帧且直接携带完整当前集合，不再是空对象通知。
  const readyFrame = await stream.next();
  assert.equal(readyFrame?.event, "ready");
  const ready = workspaceEvents.ready.parse(readyFrame!.data);
  assert.equal(typeof ready.instanceId, "string");
  assert.ok(Number.isFinite(Date.parse(ready.serverTime)));
  assert.deepEqual(ready.agentStatuses, []);
  assert.deepEqual(ready.pendingApprovals, []);
  // 真实 run 期间必须收到 agent_status_updated（含终态），事件本身按各自 schema 校验。
  const running = await client.startRun("现在几点", "e2e-events");
  // 从事件流中取本轮终态帧；帧本身用契约 schema 校验，证明推送的是可展示状态而非空通知。
  const terminal = await (async () => {
    for (;;) {
      const frame = await stream.next();
      assert.ok(frame, "event stream ended before the run terminal status");
      assert.ok(["agent_status_updated", "approval_pending", "approval_updated"].includes(frame.event), `unexpected event ${frame.event}`);
      if (frame.event === "agent_status_updated") {
        const status = workspaceEvents.agent_status_updated.parse(frame.data);
        if (status.runId === running.runId && status.status !== "running") return status;
      }
    }
  })();
  terminalSuccess(await running.done);
  assert.equal(terminal.phase, null);
  assert.ok(terminal.endedAt);
  // 记忆写入不再发失效通知；下一条业务帧应属于新 run 而不是 memory/workspace_updated。
  await client.json("/api/agent/memories", { text: "SSE-E2E" });
  const nextRun = await client.startRun("现在几点", "e2e-events");
  const next = await stream.next();
  assert.equal(next?.event, "agent_status_updated");
  assert.equal(workspaceEvents.agent_status_updated.parse(next!.data).runId, nextRun.runId);
  // 排空本轮其余状态帧直到终态，避免把遗留增量误当作断流后的 EOF。
  for (;;) {
    const frame = await stream.next();
    assert.ok(frame);
    if (frame.event !== "agent_status_updated") continue;
    const status = workspaceEvents.agent_status_updated.parse(frame.data);
    if (status.runId === nextRun.runId && status.status !== "running") break;
  }
  terminalSuccess(await nextRun.done);
  const spec = await client.json("/openapi.json");
  assert.deepEqual(Object.keys(spec.paths["/api/events"].get.responses["200"]["x-sse-events"]).sort(),
    ["agent_status_updated", "approval_pending", "approval_updated", "ready"]);
  // 结束服务应关闭长连接，客户端读到 EOF。
  await service.stop();
  assert.equal(await stream.next(), null);
});

test("e2e: ready carries a real approval, HTTP detail matches id/revision, reconnect loses nothing and terminal status survives disconnect", { timeout: 90_000 }, async (t) => {
  const { service, client } = await fixture(t);
  const first = await client.subscribeEvents();
  t.after(async () => { await first.close(); });
  assert.deepEqual(workspaceEvents.ready.parse((await first.next())!.data).pendingApprovals, []);
  const running = await client.startRun("帮我写入草稿", "e2e-sse-approval");
  let pending: ReturnType<typeof workspaceEvents.approval_pending.parse> | undefined;
  let waiting: { pendingApprovalIds: string[]; phase: string | null } | undefined;
  for (;;) {
    const frame = await first.next();
    assert.ok(frame, "event stream ended before approval_pending");
    if (frame.event === "approval_pending") {
      const approval = workspaceEvents.approval_pending.parse(frame.data);
      if (approval.runId === running.runId) pending = approval;
    } else if (frame.event === "agent_status_updated") {
      const status = workspaceEvents.agent_status_updated.parse(frame.data);
      if (status.runId === running.runId && status.phase === "waiting_approval") waiting = status;
    }
    if (pending && waiting) break;
  }
  assert.equal(pending.revision, 1);
  assert.equal(pending.status, "pending");
  assert.equal(pending.preview.path, "draft.md");
  assert.equal(pending.preview.scope, "thread");
  assert.equal(pending.preview.ownerThreadId, running.threadId);
  assert.match(pending.preview.after, /DRAFT-CONTENT/);
  assert.ok(waiting.pendingApprovalIds.includes(pending.id));
  // HTTP 完整视图与 SSE 推送是同一 id、同一 revision、同一不可变预览。
  const detail = approvalView.parse(await client.approval(pending.id));
  assert.equal(detail.id, pending.id);
  assert.equal(detail.revision, pending.revision);
  assert.deepEqual(detail.preview, pending.preview);
  // 断线重连以新 ready 为同步边界：待审批集合完整恢复，不依赖丢失的增量。
  await first.close();
  const second = await client.subscribeEvents();
  t.after(async () => { await second.close(); });
  const reconnected = workspaceEvents.ready.parse((await second.next())!.data);
  assert.deepEqual(reconnected.pendingApprovals.map((item) => [item.id, item.revision]), [[pending.id, 1]]);
  assert.deepEqual(reconnected.agentStatuses.map((item) => item.runId), [running.runId]);
  assert.equal((await client.decideApproval(pending.id, "approve")).status, 200);
  let settled: ReturnType<typeof workspaceEvents.approval_updated.parse> | undefined;
  let terminal: { status: string; endedAt: string | null } | undefined;
  for (;;) {
    const frame = await second.next();
    assert.ok(frame, "event stream ended before the run terminal status");
    if (frame.event === "approval_updated") {
      const approval = workspaceEvents.approval_updated.parse(frame.data);
      if (approval.id === pending.id) settled = approval;
    } else if (frame.event === "agent_status_updated") {
      const status = workspaceEvents.agent_status_updated.parse(frame.data);
      if (status.runId === running.runId && status.status !== "running") terminal = status;
    }
    if (settled && terminal) break;
  }
  // 轻量投影记录真实执行回执，最终 revision=4；不包含 preview/title。
  assert.equal(settled.status, "approved");
  assert.equal(settled.revision, 4);
  assert.equal(settled.execution?.status, "succeeded");
  assert.ok(settled.decidedAt && settled.resolvedAt);
  assert.equal(Object.hasOwn(settled, "preview"), false);
  assert.equal(Object.hasOwn(settled, "title"), false);
  terminalSuccess(await running.done);
  assert.equal(terminal.status, "succeeded");
  // 本轮新增输出与落盘结果都可读；断线后运行终态仍能通过 GET /api/agent/status 取回。
  const history = await client.history(running.threadId);
  assert.match(JSON.stringify(history), /DRAFT-CONTENT|write reply:/);
  assert.equal(await readFile(join(service.dataDir, "workspace/threads/e2e-sse-approval/draft.md"), "utf8"),
    pending.preview.after);
  await second.close();
  const final = await client.json(`/api/agent/status?threadId=${encodeURIComponent(running.threadId)}&runId=${encodeURIComponent(running.runId)}`);
  assert.equal(final.status.status, "succeeded");
  assert.equal(final.status.endedAt, terminal.endedAt);
  assert.deepEqual(final.status.pendingApprovalIds, []);
});
