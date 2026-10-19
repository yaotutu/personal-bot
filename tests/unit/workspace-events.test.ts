import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingAction } from "../../src/features/actions/types.js";
import { createWorkspaceEvents, type WorkspaceEvents, type WorkspaceUpdate } from "../../src/features/workspace/workspace-events.js";
import { createWorkspaceEventRoutes } from "../../src/http/routes/events.js";

/**
 * 工作区实时事件单测：createWorkspaceEvents 的投影/版本/隔离，以及 GET /api/events
 * 的真实 SSE 帧（ready、运行状态、审批、心跳、背压、连接上限）。帧按标准 SSE 解析后
 * 断言字段，不依赖生成 UUID 的具体值，也不做整段字符串匹配。
 */

const newPending = (overrides: Partial<PendingAction> = {}): PendingAction => ({
  id: "approval-1", kind: "file_write", title: "写入 notes.md",
  // 新增字段全部必填；payload 固定带 path/originalContent/content/beforeExists/baseVersion。
  payload: { path: "notes.md", originalContent: "", content: "hello", beforeExists: "true", baseVersion: "v1" },
  status: "pending", revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", resolvedAt: null, decidedAt: null,
  threadId: "local-main", runId: "run-1", toolCallId: "tc-1", subagentId: null,
  workspaceThreadId: "local-main", activityId: null,
  ...overrides,
});

const resolvePending = (pending: PendingAction, status: "approved" | "denied" | "expired" | "cancelled" = "approved"): PendingAction => ({
  ...pending, status, revision: pending.revision + 1, resolvedAt: "2026-01-01T00:01:00.000Z",
  decidedAt: status === "approved" || status === "denied" ? "2026-01-01T00:01:00.000Z" : null,
});

const expectedPreview = {
  scope: "thread", ownerThreadId: "local-main", path: "notes.md", before: "", after: "hello", beforeExists: true,
};

type Frame = { event: string | null; data: any; raw: string };
const parseFrame = (raw: string): Frame => {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return { event, data: data.length ? JSON.parse(data.join("\n")) : null, raw };
};

/** 持久缓冲区解析跨 chunk 的 SSE 帧；同一 chunk 的后续帧不会丢失。 */
const sseReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<Frame | null> => {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
    const end = buffer.indexOf("\n\n") + 2;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end);
    return parseFrame(raw);
  };
  const take = async (count: number) => {
    const frames: Frame[] = [];
    while (frames.length < count) { const frame = await next(); if (!frame) break; frames.push(frame); }
    return frames;
  };
  const until = async (event: string) => {
    for (let i = 0; i < 8; i++) { const frame = await next(); if (!frame) return null; if (frame.event === event) return frame; }
    return null;
  };
  const all = async () => {
    const frames: Frame[] = [];
    for (let frame = await next(); frame; frame = await next()) frames.push(frame);
    return frames;
  };
  return { next, take, until, all, close: () => reader.cancel() };
};

const open = async (events: WorkspaceEvents) => {
  const response = await createWorkspaceEventRoutes(events).request("/api/events");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return sseReader(response.body!.getReader());
};

test("unit: no legacy invalidate; throwing subscriber is dropped; copies are isolated", () => {
  const events = createWorkspaceEvents();
  assert.equal("invalidate" in events, false);
  const seen: WorkspaceUpdate[] = [];
  let badCalls = 0;
  events.subscribe({ notify: () => { badCalls++; throw new Error("boom"); }, close: () => {} });
  events.subscribe({ notify: (event) => seen.push(event), close: () => {} });
  const run = events.beginRun({ threadId: "local-main", runId: "run-copy", source: "chat" });
  assert.equal(badCalls, 1); // 坏订阅者只被调用一次，随后被移除

  const first = seen[0];
  assert.equal(first.event, "agent_status_updated");
  if (first.event !== "agent_status_updated") return;
  first.status.label = "mutated";
  first.status.tools.push({ toolCallId: "injected", name: "x", label: "x", status: "running", subagentId: null });
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-1", name: "write", subagentId: null });
  const second = seen[1];
  assert.equal(second.event, "agent_status_updated");
  if (second.event !== "agent_status_updated") return;
  assert.notEqual(second.status.label, "mutated");
  assert.deepEqual(second.status.tools.map((tool) => tool.toolCallId), ["tc-1"]);

  const current = events.current();
  current[0].label = "external mutation";
  assert.notEqual(run.snapshot().label, "external mutation");
  assert.deepEqual(events.current(), [run.snapshot()]);
  assert.equal(badCalls, 1);
});

test("unit: a finished run stays terminal and stops publishing", () => {
  const events = createWorkspaceEvents();
  const seen: WorkspaceUpdate[] = [];
  events.subscribe({ notify: (event) => seen.push(event), close: () => {} });
  const run = events.beginRun({ threadId: "local-main", runId: "run-done", source: "chat" });
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-1", name: "write", subagentId: null });
  const terminal = run.finish("succeeded");
  assert.deepEqual([terminal.status, terminal.phase, terminal.tools.length, terminal.endedAt !== null, events.current().length],
    ["succeeded", null, 0, true, 0]);

  const count = seen.length;
  run.observe({ kind: "tool", phase: "start", toolCallId: "late", name: "write", subagentId: null });
  run.finalizing();
  assert.deepEqual(run.finish("failed"), terminal); // 终态不可回到 running
  assert.equal(seen.length, count);
  assert.deepEqual(run.snapshot(), terminal);
});

test("unit: pending approvals put the parent tool and subagent into waiting_approval", () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ threadId: "local-main", runId: "run-wait", source: "chat" });
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-parent", name: "write", subagentId: null });
  run.observe({ kind: "subagent", phase: "start", id: "sub-1", role: "worker" });
  const parent = newPending({ id: "approval-parent", runId: "run-wait", toolCallId: "tc-parent" });
  const child = newPending({ id: "approval-child", runId: "run-wait", toolCallId: "tc-child", subagentId: "sub-1" });
  events.approvalChanged(parent);
  events.approvalChanged(child);

  const waiting = run.snapshot();
  assert.equal(waiting.phase, "waiting_approval");
  assert.deepEqual(waiting.pendingApprovalIds, ["approval-parent", "approval-child"]);
  assert.equal(waiting.tools.find((tool) => tool.toolCallId === "tc-parent")?.status, "waiting_approval");
  assert.equal(waiting.subagents[0].phase, "waiting_approval");

  events.approvalChanged(resolvePending(parent));
  events.approvalChanged(resolvePending(child));
  const resumed = run.snapshot();
  assert.deepEqual([resumed.phase, resumed.pendingApprovalIds.length, resumed.tools[0].status, events.pending().length],
    ["waiting_subagents", 0, "running", 0]);
});

test("routes: ready is the complete empty snapshot with instanceId", async () => {
  const events = createWorkspaceEvents();
  const sse = await open(events);
  const [ready] = await sse.take(1);
  assert.equal(ready.event, "ready");
  assert.equal(ready.data.instanceId, events.instanceId);
  assert.match(ready.data.serverTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual([ready.data.agentStatuses, ready.data.pendingApprovals], [[], []]);
  await sse.close();
});

test("routes: ready carries the full existing run and pending approval snapshot", async () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ threadId: "local-main", runId: "run-ready", source: "chat" });
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-1", name: "write", subagentId: null });
  const pending = newPending({ id: "approval-ready", runId: "run-ready", toolCallId: "tc-1" });
  events.seedApprovals([pending]);
  const sse = await open(events);
  const [ready] = await sse.take(1);
  assert.equal(ready.event, "ready");
  assert.equal(ready.data.instanceId, events.instanceId);
  assert.deepEqual(ready.data.agentStatuses, [run.snapshot()]);
  const view = ready.data.pendingApprovals[0];
  assert.deepEqual([view.id, view.revision, view.status, view.title, view.kind],
    [pending.id, 1, "pending", pending.title, pending.kind]);
  assert.deepEqual(view.preview, expectedPreview);
  assert.deepEqual(Object.keys(pending.payload).sort(), ["baseVersion", "beforeExists", "content", "originalContent", "path"]);
  await sse.close();
});

test("routes: status exposes tool name/hidden, subagent lifecycle, increasing revisions", async () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ threadId: "local-main", runId: "run-status", source: "chat" });
  const sse = await open(events);
  await sse.take(1); // ready

  const revisions: number[] = [];
  const nextStatus = async () => {
    const [frame] = await sse.take(1);
    assert.equal(frame.event, "agent_status_updated");
    assert.deepEqual([frame.data.instanceId, frame.data.threadId, frame.data.runId], [events.instanceId, "local-main", "run-status"]);
    revisions.push(frame.data.revision);
    return frame.data;
  };

  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-visible", name: "write", subagentId: null });
  const visible = await nextStatus();
  assert.deepEqual(visible.tools.map((tool: any) => [tool.toolCallId, tool.name, tool.label, tool.status]),
    [["tc-visible", "write", "正在写入文件", "running"]]);

  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-hidden", name: null, subagentId: null });
  const hidden = await nextStatus();
  assert.deepEqual(hidden.tools.find((tool: any) => tool.toolCallId === "tc-hidden"),
    { toolCallId: "tc-hidden", name: null, label: "正在执行工具", status: "running", subagentId: null });

  run.observe({ kind: "subagent", phase: "queued", id: "sub-1", role: "worker" });
  const queued = await nextStatus();
  assert.equal(queued.phase, "waiting_subagents");
  assert.deepEqual([queued.subagents[0].status, queued.subagents[0].phase, queued.subagents[0].startedAt, queued.subagents[0].label],
    ["queued", null, null, "等待子代理执行名额"]);

  run.observe({ kind: "subagent", phase: "start", id: "sub-1", role: "worker" });
  const started = await nextStatus();
  assert.deepEqual([started.subagents[0].status, started.subagents[0].phase, started.subagents[0].endedAt, started.subagents[0].startedAt !== null],
    ["running", "preparing", null, true]);

  run.observe({ kind: "subagent", phase: "end", id: "sub-1", role: "worker", outcome: "succeeded" });
  const ended = await nextStatus();
  assert.deepEqual([ended.subagents[0].status, ended.subagents[0].phase, ended.subagents[0].label, ended.subagents[0].endedAt !== null],
    ["succeeded", null, "子代理已完成", true]);
  assert.deepEqual(revisions, [2, 3, 4, 5, 6]);
  await sse.close();
});

test("routes: approval_pending is full, terminal is lightweight, status waits correctly", async () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ threadId: "local-main", runId: "run-approval", source: "chat" });
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-1", name: "write", subagentId: null });
  const sse = await open(events);
  const [ready] = await sse.take(1);
  assert.deepEqual(ready.data.pendingApprovals, []);

  const pending = newPending({ id: "approval-route", runId: "run-approval", toolCallId: "tc-1" });
  events.approvalChanged(pending);
  const added = await sse.until("approval_pending");
  assert.ok(added);
  assert.deepEqual([added.data.instanceId, added.data.id, added.data.revision, added.data.status, added.data.title, added.data.kind],
    [events.instanceId, pending.id, 1, "pending", pending.title, pending.kind]);
  assert.deepEqual(added.data.preview, expectedPreview);
  assert.equal("payload" in added.data, false);
  assert.equal(run.snapshot().phase, "waiting_approval");

  const resolved = resolvePending(pending);
  events.approvalChanged(resolved);
  const updated = await sse.until("approval_updated");
  assert.ok(updated);
  assert.deepEqual([updated.data.instanceId, updated.data.id, updated.data.revision, updated.data.status, updated.data.resolvedAt, updated.data.decidedAt],
    [events.instanceId, pending.id, 2, "approved", resolved.resolvedAt, resolved.decidedAt]);
  for (const key of ["preview", "title", "kind", "payload"]) assert.equal(key in updated.data, false);
  assert.equal(run.snapshot().phase, "executing_tool");
  await sse.close();
});

test("routes: approval registered during subscribe appears in ready and its frame is not lost", async () => {
  const events = createWorkspaceEvents();
  const pending = newPending({ id: "approval-race", runId: null });
  const wrapped: WorkspaceEvents = {
    ...events,
    subscribe: (subscriber) => {
      const unsubscribe = events.subscribe(subscriber);
      events.approvalChanged(pending); // 订阅后、ready 快照生成前的同步登记
      return unsubscribe;
    },
  };
  const response = await createWorkspaceEventRoutes(wrapped).request("/api/events");
  assert.equal(response.status, 200);
  const sse = sseReader(response.body!.getReader());
  const [ready, added] = await sse.take(2);
  assert.equal(ready.event, "ready");
  assert.deepEqual(ready.data.pendingApprovals.map((item: any) => item.id), ["approval-race"]);
  assert.deepEqual([added.event, added.data.id, added.data.revision], ["approval_pending", "approval-race", 1]);
  await sse.close();
});

test("routes: cancel and service close clear the heartbeat timer", async () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Set<ReturnType<typeof originalSet>>();
  globalThis.setInterval = ((...args: Parameters<typeof originalSet>) => {
    const handle = originalSet(...args);
    timers.add(handle);
    return handle;
  }) as typeof originalSet;
  globalThis.clearInterval = ((handle?: Parameters<typeof originalClear>[0]) => {
    if (handle !== undefined) timers.delete(handle as ReturnType<typeof originalSet>);
    originalClear(handle);
  }) as typeof originalClear;
  try {
    const events = createWorkspaceEvents();
    const app = createWorkspaceEventRoutes(events);
    const sseA = sseReader((await app.request("/api/events")).body!.getReader());
    await sseA.take(1);
    assert.equal(timers.size, 1);
    await sseA.close();
    assert.equal(timers.size, 0);

    const sseB = sseReader((await app.request("/api/events")).body!.getReader());
    await sseB.take(1);
    assert.equal(timers.size, 1);
    events.close();
    assert.equal(timers.size, 0);
    assert.equal(await sseB.next(), null);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    for (const handle of timers) originalClear(handle);
  }
});

test("routes: 30s heartbeat is a comment frame", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events = createWorkspaceEvents();
  const sse = sseReader((await createWorkspaceEventRoutes(events).request("/api/events")).body!.getReader());
  await sse.take(1); // ready
  t.mock.timers.tick(30_000);
  const heartbeat = await sse.next();
  assert.ok(heartbeat);
  assert.deepEqual([heartbeat.event, heartbeat.data, heartbeat.raw], [null, null, ": keep-alive\n\n"]);
  await sse.close();
});

test("routes: slow reader merges run frames but preserves approval order", async () => {
  const events = createWorkspaceEvents();
  const run = events.beginRun({ threadId: "local-main", runId: "run-slow", source: "chat" });
  const response = await createWorkspaceEventRoutes(events).request("/api/events");
  const sse = sseReader(response.body!.getReader());

  for (let i = 0; i < 40; i++) run.observe({ kind: "model", phase: i % 2 === 0 ? "start" : "responding", subagentId: null });
  events.approvalChanged(newPending({ id: "approval-a", runId: null }));
  run.observe({ kind: "tool", phase: "start", toolCallId: "tc-late", name: "write", subagentId: null });
  events.approvalChanged(newPending({ id: "approval-b", runId: null }));

  const frames = await sse.take(4);
  assert.deepEqual(frames.map((frame) => frame.event), ["ready", "agent_status_updated", "approval_pending", "approval_pending"]);
  assert.equal(frames[1].data.revision, run.snapshot().revision); // 合并到最新 revision
  assert.deepEqual(frames[1].data.tools.map((tool: any) => tool.toolCallId), ["tc-late"]);
  assert.deepEqual(frames.slice(2).map((frame) => frame.data.id), ["approval-a", "approval-b"]);
  await sse.close();
});

test("routes: overflowing the bounded queue disconnects; 9th connection is 429", async () => {
  const events = createWorkspaceEvents();
  const app = createWorkspaceEventRoutes(events);
  const overflow = sseReader((await app.request("/api/events")).body!.getReader());
  for (let i = 0; i < 200; i++) events.approvalChanged(newPending({ id: `approval-${i}` }));
  assert.deepEqual((await overflow.all()).map((frame) => frame.event), ["ready"]);

  const readers = [];
  for (let i = 0; i < 8; i++) readers.push((await app.request("/api/events")).body!.getReader());
  const rejected = await app.request("/api/events");
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { error: "Too many event connections" });
  for (const reader of readers) await reader.cancel();
  assert.equal((await app.request("/api/events")).status, 200);
});
