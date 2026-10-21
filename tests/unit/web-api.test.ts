import assert from "node:assert/strict";
import { test } from "node:test";
import { addMemory, createGoal, decideApproval, editMemory, forgetMemory, getAgentSnapshot, getGoal, getMemory, getToken, listGoals, listMemories, listPendingApprovals, login, removeGoal, runConversation, setGoalStatus, subscribeAuth, toggleGoalMilestone, updateGoal } from "../../web/src/lib/api.js";

/** 只替换浏览器边界，复用真实 API 客户端；认证失效必须发布到 React 订阅而非只删缓存。 */
test("login rejects wrong keys normally and API 401 immediately invalidates the shared authentication state", async (t) => {
  const values = new Map<string, string>();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  let status = 401;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(status === 200 ? { token: "signed-token" } : { error: "Unauthorized" }), { status }));
  let changes = 0;
  const unsubscribe = subscribeAuth(() => { changes++; });
  t.after(() => {
    unsubscribe();
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  assert.equal(await login("wrong"), false);
  assert.equal(changes, 0);
  status = 200;
  assert.equal(await login("correct"), true);
  assert.equal(getToken(), "signed-token");
  assert.equal(changes, 1);
  status = 401;
  await assert.rejects(getAgentSnapshot(), /登录已过期/);
  assert.equal(getToken(), null);
  assert.equal(changes, 2);
});

test("approval client uses the new routes and validates the pending envelope instead of accepting legacy fields", async (t) => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "test-token" } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const approval = {
    id: "approval-1", kind: "file_write", title: "Write draft",
    spaceId: "local-main", threadId: "local-main",
    workspaceSpaceId: "local-main", workspaceThreadId: "local-main",
    preview: { scope: "space", ownerSpaceId: "local-main", ownerThreadId: "local-main", path: "draft.md", before: "", after: "complete preview", beforeExists: false }, status: "pending",
    revision: 1, runId: null, activityId: null, toolCallId: null, subagentId: null, resolvedAt: null, decidedAt: null,
    createdAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-10-19T00:05:00.000Z", execution: null,
  };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let body: unknown = { approvals: [approval] };
  let status = 200;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify(body), { status });
  });
  const controller = new AbortController();
  assert.deepEqual(await listPendingApprovals(controller.signal), [approval]);
  assert.equal(requests[0].path, "/api/approvals/pending");
  assert.equal(requests[0].init?.signal, controller.signal);
  assert.equal(new Headers(requests[0].init?.headers).get("Authorization"), "Bearer test-token");
  body = { ...approval, status: "approved", revision: 2 };
  assert.deepEqual(await decideApproval(approval.id, "approve", controller.signal), body);
  assert.equal(requests[1].path, "/api/approvals/approval-1/decision");
  assert.equal(requests[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { decision: "approve" });
  body = { actions: [approval] };
  await assert.rejects(listPendingApprovals());
  status = 409;
  await assert.rejects(decideApproval(approval.id, "deny"), /审批失败 \(409\)/);
});

test("chat client rejects malformed protocol events and streams that omit a terminal event", async (t) => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  let body = 'data: {"type":"TOOL_CALL_START","toolCallId":"missing-name"}\n\n';
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const input = { threadId: "main", runId: "run", expectedRevision: "empty", message: { id: "u", content: "hello" } };
  await assert.rejects(runConversation(input, () => assert.fail("invalid event must never reach the UI")), /不符合契约/);
  body = 'data: {"type":"RUN_STARTED","threadId":"main","runId":"run"}\n\n';
  await assert.rejects(runConversation(input, () => {}), /提前结束/);
  body += 'data: {"type":"RUN_FINISHED","threadId":"main","runId":"run"}\n\n';
  const events: string[] = [];
  await runConversation(input, (event) => events.push(event.type));
  assert.deepEqual(events, ["RUN_STARTED", "RUN_FINISHED"]);
});

test("memory client uses dedicated /api/memories routes with query params, patch and delete", async (t) => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "test-token" } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const memory = {
    id: "mem-1", text: "User likes coffee", source: "Web UI",
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
  };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let body: unknown = { memories: [memory] };
  let status = 200;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify(body), { status });
  });

  // 1. listMemories with query
  const list = await listMemories("coffee", 5);
  assert.deepEqual(list, [memory]);
  assert.equal(requests[0].path, "/api/memories?q=coffee&limit=5");

  // 2. getMemory
  body = memory;
  const item = await getMemory("mem-1");
  assert.deepEqual(item, memory);
  assert.equal(requests[1].path, "/api/memories/mem-1");

  // 3. addMemory
  body = memory;
  const created = await addMemory("User likes coffee");
  assert.deepEqual(created, memory);
  assert.equal(requests[2].path, "/api/memories");
  assert.equal(requests[2].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { text: "User likes coffee", source: "Web UI" });

  // 4. editMemory
  const editedMem = { ...memory, text: "User likes tea" };
  body = editedMem;
  const edited = await editMemory("mem-1", "User likes tea");
  assert.deepEqual(edited, editedMem);
  assert.equal(requests[3].path, "/api/memories/mem-1");
  assert.equal(requests[3].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[3].init?.body)), { text: "User likes tea" });

  // 5. forgetMemory
  body = { ok: true, id: "mem-1" };
  await forgetMemory("mem-1");
  assert.equal(requests[4].path, "/api/memories/mem-1");
  assert.equal(requests[4].init?.method, "DELETE");

  // 6. 错误处理
  status = 404;
  await assert.rejects(getMemory("missing"), /无法加载记忆详情/);
});

test("goals client uses dedicated /api/goals routes with filtering, patch, toggle and delete", async (t) => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "test-token" } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const goal = {
    id: "g-1", title: "Run 10km", description: "Training", category: "fitness", status: "active" as const,
    milestones: [{ id: "m-1", title: "Run 5km", done: false }],
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
  };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let body: unknown = { goals: [goal] };
  let status = 200;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify(body), { status });
  });

  // 1. listGoals with query
  const list = await listGoals({ status: "active", category: "fitness" });
  assert.deepEqual(list, [goal]);
  assert.equal(requests[0].path, "/api/goals?status=active&category=fitness");

  // 2. getGoal
  body = goal;
  const item = await getGoal("g-1");
  assert.deepEqual(item, goal);
  assert.equal(requests[1].path, "/api/goals/g-1");

  // 3. createGoal
  body = goal;
  const created = await createGoal({ title: "Run 10km", milestones: ["Run 5km"] });
  assert.deepEqual(created, goal);
  assert.equal(requests[2].path, "/api/goals");
  assert.equal(requests[2].init?.method, "POST");

  // 4. updateGoal & setGoalStatus
  const updatedGoal = { ...goal, status: "completed" as const };
  body = updatedGoal;
  const updated = await updateGoal("g-1", { status: "completed" });
  assert.deepEqual(updated, updatedGoal);
  assert.equal(requests[3].path, "/api/goals/g-1");
  assert.equal(requests[3].init?.method, "PATCH");

  // 5. toggleGoalMilestone
  const toggledGoal = { ...goal, milestones: [{ ...goal.milestones[0], done: true }] };
  body = toggledGoal;
  const toggled = await toggleGoalMilestone("g-1", "m-1");
  assert.deepEqual(toggled, toggledGoal);
  assert.equal(requests[4].path, "/api/goals/g-1/milestones/m-1/toggle");
  assert.equal(requests[4].init?.method, "POST");

  // 6. removeGoal
  body = { ok: true, id: "g-1" };
  await removeGoal("g-1");
  assert.equal(requests[5].path, "/api/goals/g-1");
  assert.equal(requests[5].init?.method, "DELETE");

  // 7. 错误处理
  status = 404;
  await assert.rejects(getGoal("missing"), /无法加载目标详情/);
});
