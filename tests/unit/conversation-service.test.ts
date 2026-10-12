import assert from "node:assert/strict";
import { test } from "node:test";
import { createConversation } from "../../src/features/conversation/conversation-service.js";
import type { ConversationDependencies, ConversationExecution, ConversationHistoryPort } from "../../src/features/conversation/ports.js";
import type { ConversationEvent, ExecutionEvent } from "../../src/features/conversation/types.js";

/** 这里只替换 port 测生命周期，不模拟 agent loop；真实 pi/HTTP 仍由集成套件保护。 */
const fixture = () => {
  const calls: string[] = [];
  let listener: (event: ExecutionEvent) => void = () => {};
  const history: ConversationHistoryPort = {
    history: () => [], records: () => ({ turns: [], results: new Map() }), checkpoint: () => "leaf",
    omitTurn: () => { calls.push("omit"); }, appendTurn: () => { calls.push("turn"); },
    appendResult: (result) => { calls.push(result.status); }, restoreIfNoUser: () => { calls.push("restore"); },
  };
  const session: ConversationExecution = {
    prompt: async () => { calls.push("prompt"); listener({ type: "assistant_end", reason: "stop", text: "answer" }); },
    waitForIdle: async () => { calls.push("idle"); }, abort: async () => { calls.push("abort"); },
    dispose: () => { calls.push("dispose"); }, syncContext: () => { calls.push("sync"); },
    subscribe: (next) => { listener = next; return () => { calls.push("unsubscribe"); }; },
  };
  const dependencies: ConversationDependencies = { history, openSession: async () => session };
  return { calls, session, dependencies };
};
const input = { threadId: "local-main", runId: "run", messages: [{ id: "user", role: "user", content: "hello" }] };

test("coordinator finishes only after pi idle and persisted result and then releases its sole lock", async () => {
  const { calls, dependencies } = fixture();
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const events: ConversationEvent[] = [];
  await conversation.run(input, (event) => {
    if (event.type === "run_finished") assert.deepEqual(calls.slice(-2), ["idle", "completed"]);
    events.push(event);
  });
  assert.equal(events.at(-1)?.type, "run_finished");
  assert.equal(conversation.isRunning(), false);
  assert.deepEqual(calls.slice(-2), ["unsubscribe", "dispose"]);
});

test("trigger keeps its legacy no-client-timeout behavior and shares the lock with client runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, dependencies } = fixture();
  let release!: () => void;
  const opened = new Promise<ConversationExecution>((resolve) => { release = () => resolve(fixture().session); });
  dependencies.openSession = () => opened;
  const conversation = createConversation({ configured: true, runTimeoutMs: 1 }, dependencies);
  const pending = conversation.trigger("scheduled", "job");
  t.mock.timers.tick(1000);
  assert.equal(conversation.isRunning(), true);
  await assert.rejects(conversation.run(input, () => {}), { code: "agent_thread_locked" });
  assert.deepEqual(await conversation.trigger("other", "other-job"), { status: "failed", text: "busy" });
  assert.equal(await conversation.cancel("STOPPED", "not-owner"), false);
  release();
  assert.deepEqual(await pending, { status: "completed", text: "answer" });
  assert.equal(calls.includes("abort"), false);
  assert.equal(conversation.isRunning(), false);
});

test("client early cancellation after opening never records a replacement turn", async () => {
  const { calls, dependencies, session } = fixture();
  let release!: () => void;
  dependencies.openSession = () => new Promise((resolve) => { release = () => resolve(session); });
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const events: ConversationEvent[] = [];
  const pending = conversation.run(input, (event) => events.push(event));
  const cancelled = conversation.cancel();
  release();
  await pending;
  assert.equal(await cancelled, true);
  assert.equal(calls.includes("turn"), false);
  assert.equal(calls.includes("sync"), false);
  assert.deepEqual(events.at(-1), { type: "run_error", code: "STOPPED", message: "Run stopped by user" });
});
