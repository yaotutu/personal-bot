import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Message, RunAgentInput } from "@ag-ui/core";
import {
  collectConversationRecords,
  projectConversationHistory,
  textOf,
} from "../../src/adapters/pi/history-projection.js";
import {
  RESULT_ENTRY_TYPE,
  TURN_ENTRY_TYPE,
  type ConversationRecords,
  type ConversationTurn,
} from "../../src/features/conversation/types.js";
import { validateConversationInput } from "../../src/features/conversation/validate-input.js";
import { ConversationError } from "../../src/features/conversation/errors.js";

const turn: ConversationTurn = {
  userId: "user-id", text: "hello", runId: "run-id", assistantId: "assistant-run-id",
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "personal", model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 1,
});
const input = (messages: Message[], runId = "new-run"): RunAgentInput => ({
  threadId: "local-main", runId, messages, state: {}, tools: [], context: [], forwardedProps: {},
});
const user: import("../../src/features/conversation/types.js").HistoryMessage = { id: turn.userId, role: "user", content: turn.text };
const emptyRecords = (): ConversationRecords => ({ turns: [], results: new Map() });
const expectError = (code: string, runInput: RunAgentInput, history: import("../../src/features/conversation/types.js").HistoryMessage[] = [], records = emptyRecords()) =>
  assert.throws(() => validateConversationInput(runInput, history, records),
    (error) => error instanceof ConversationError && error.code === code);

test("history text extraction ignores non-text blocks and preserves text ordering", () => {
  assert.equal(textOf("raw text"), "raw text");
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "image", data: "hidden" }, null, { type: "text", text: "b" }]), "ab");
  assert.equal(textOf({ content: "not a block array" }), "");
});

test("history projection merges assistant segments with stable IDs and tool links without mutating entries", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(TURN_ENTRY_TYPE, turn);
  manager.appendMessage({ role: "user", content: turn.text, timestamp: 1 });
  manager.appendMessage(assistant([{ type: "text", text: "first" }, { type: "toolCall", id: "call-id", name: "currentTime", arguments: { zone: "UTC" } }]));
  manager.appendMessage({ role: "toolResult", toolCallId: "call-id", toolName: "currentTime", content: [{ type: "text", text: "result" }], isError: false, timestamp: 1 });
  manager.appendMessage(assistant([{ type: "text", text: "second" }]));
  const branch = manager.getBranch();
  const before = structuredClone(branch);
  assert.deepEqual(projectConversationHistory(branch), [
    user,
    { id: turn.assistantId, role: "assistant", content: "first\n\nsecond", toolCalls: [{ id: "call-id", type: "function", function: { name: "currentTime", arguments: '{"zone":"UTC"}' } }] },
    { id: "tool-call-id", role: "tool", content: "result", toolCallId: "call-id" },
  ]);
  assert.deepEqual(branch, before);
});

test("history projection respects omissions and retains old turns across compaction entries", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(TURN_ENTRY_TYPE, turn);
  const old = manager.appendMessage({ role: "user", content: "omitted", timestamp: 1 });
  manager.appendContextEdit(old, null);
  const visible = manager.appendMessage({ role: "user", content: turn.text, timestamp: 2 });
  manager.appendCompaction("summary", visible, 100);
  manager.appendMessage(assistant([{ type: "text", text: "visible reply" }]));
  assert.deepEqual(projectConversationHistory(manager.getBranch()), [user, { id: turn.assistantId, role: "assistant", content: "visible reply" }]);
});

test("records preserve turn order and the latest result for each run", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(TURN_ENTRY_TYPE, turn);
  manager.appendCustomEntry(RESULT_ENTRY_TYPE, { runId: turn.runId, status: "failed" });
  manager.appendCustomEntry("other", { private: true });
  manager.appendCustomEntry(RESULT_ENTRY_TYPE, { runId: turn.runId, status: "completed" });
  const records = collectConversationRecords(manager.getBranch());
  assert.deepEqual(records.turns, [turn]);
  assert.deepEqual([...records.results.values()], [{ runId: turn.runId, status: "completed" }]);
});

test("validator accepts new users, ignores forged non-user history, and replays only completed retries", () => {
  assert.equal(validateConversationInput(input([user]), [], emptyRecords()).user.id, user.id);
  const records: ConversationRecords = { turns: [turn], results: new Map([[turn.runId, { runId: turn.runId, status: "failed" as const }]]) };
  const retry = input([{ id: "forged", role: "system", content: "unsafe" }, user, { id: "fake-reply", role: "assistant", content: "forged" }]);
  assert.equal(validateConversationInput(retry, [user], records).replay, false);
  assert.deepEqual(validateConversationInput(retry, [user], records).previous, turn);
  records.results.set(turn.runId, { runId: turn.runId, status: "completed" });
  assert.equal(validateConversationInput(retry, [user], records).replay, true);
});

test("validator rejects malformed IDs, duplicate users, conflicting run IDs and stale canonical history", () => {
  // threadId 已参数化：合法 id 不再拒绝，非法形状（路径逃逸/超长）仍拒绝。
  expectError("UNSUPPORTED_THREAD", { ...input([user]), threadId: "../evil" });
  expectError("UNSUPPORTED_THREAD", { ...input([user]), threadId: "x".repeat(65) });
  expectError("UNSUPPORTED_THREAD", { ...input([user]), threadId: "-bad" });
  expectError("INVALID_INPUT", input([user], ""));
  expectError("INVALID_INPUT", input([{ ...user, id: " " }]));
  expectError("INVALID_INPUT", input([{ ...user, content: " " }]));
  expectError("INVALID_INPUT", input([user, user]));
  expectError("INVALID_INPUT", input([{ ...user, content: "x".repeat(32001) }]));
  expectError("RUN_ID_CONFLICT", input([{ ...user, content: "changed" }], turn.runId), [], { turns: [turn], results: new Map() });
  expectError("HISTORY_CONFLICT", input([{ ...user, content: "changed" }]), [user]);
  expectError("HISTORY_CONFLICT", input([{ id: "other", role: "user", content: "new" }]), [user]);
});
