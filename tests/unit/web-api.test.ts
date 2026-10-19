import assert from "node:assert/strict";
import { test } from "node:test";
import { decideApproval, getAgentSnapshot, getToken, listPendingApprovals, login, runConversation, subscribeAuth } from "../../web/src/lib/api.js";

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
    preview: { scope: "thread", ownerThreadId: "local-main", path: "draft.md", before: "", after: "complete preview", beforeExists: false }, status: "pending",
    revision: 1, threadId: "local-main", runId: null, activityId: null, toolCallId: null, subagentId: null, workspaceThreadId: "local-main", resolvedAt: null, decidedAt: null,
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
