import assert from "node:assert/strict";
import { test } from "node:test";
import { type BaseEvent } from "@ag-ui/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createEventProjector } from "../../src/adapters/ag-ui/events.js";
import { projectExecutionEvent } from "../../src/adapters/pi/execution.js";

const projector = () => {
  const events: BaseEvent[] = [];
  const emit = createEventProjector((event) => events.push(event));
  emit({ type: "run_started", runId: "run", assistantId: "assistant-run" });
  return { emit, events };
};

test("event projector starts text once, ignores empty chunks and waits for explicit run terminal", () => {
  const { emit, events } = projector();
  emit({ type: "text_delta", delta: "" });
  emit({ type: "text_delta", delta: "a" });
  emit({ type: "text_delta", delta: "b" });
  emit({ type: "assistant_end", reason: "stop", text: "ab" });
  assert.deepEqual(events.map((x) => x.type), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT"]);
  emit({ type: "text_end", assistantId: "assistant-run" });
  emit({ type: "run_finished", runId: "run" });
  assert.deepEqual(events.slice(-2).map((x) => x.type), ["TEXT_MESSAGE_END", "RUN_FINISHED"]);
});

test("event projector repairs missing tool start/end-only arguments without duplicating streamed arguments", () => {
  const { emit, events } = projector();
  emit({ type: "tool_delta", id: "streamed", name: "read", delta: '{"path":' });
  emit({ type: "tool_start", id: "streamed", name: "read" });
  emit({ type: "tool_delta", id: "streamed", name: "read", delta: '"a.txt"}' });
  emit({ type: "tool_end", id: "streamed", name: "read", arguments: { path: "a.txt" } });
  emit({ type: "tool_end", id: "end-only", name: "read", arguments: { path: "b.txt" } });
  emit({ type: "tool_end", id: "no-args", name: "currentTime", arguments: {} });
  assert.equal(events.filter((x) => x.type === "TOOL_CALL_START").length, 3);
  assert.deepEqual(events.filter((x) => x.type === "TOOL_CALL_ARGS").map((x) => [x.toolCallId, x.delta]), [
    ["streamed", '{"path":'], ["streamed", '"a.txt"}'], ["end-only", '{"path":"b.txt"}'],
  ]);
  emit({ type: "tool_result", id: "streamed", content: "text" });
  assert.deepEqual(events.at(-1), { type: "TOOL_CALL_RESULT", messageId: "tool-streamed", toolCallId: "streamed", role: "tool", content: "text" });
});

test("pi execution scrubs diagnostic on the original assistant object before persistence, not normal text", () => {
  const event = { type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "visible answer" }], errorMessage: "secret provider URL/key" } };
  assert.deepEqual(projectExecutionEvent(event as AgentSessionEvent), { type: "assistant_end", reason: "error", text: "visible answer" });
  assert.equal(event.message.errorMessage, "Model request failed or was cancelled");
  assert.equal(event.message.content[0].text, "visible answer");
});

test("pi execution exposes only controlled denied tool errors and otherwise generic diagnostics", () => {
  const event = (isError: boolean, denied = false) => ({ type: "tool_execution_end", toolCallId: "call", toolName: "read", isError, result: { content: [{ type: "text", text: denied ? "Path denied" : "provider secret" }], details: { denied } } }) as AgentSessionEvent;
  assert.deepEqual(projectExecutionEvent(event(true)), { type: "tool_result", id: "call", content: "Tool execution failed" });
  assert.deepEqual(projectExecutionEvent(event(true, true)), { type: "tool_result", id: "call", content: "Path denied" });
  assert.deepEqual(projectExecutionEvent(event(false)), { type: "tool_result", id: "call", content: "provider secret" });
});

test("pi execution scrubs raw toolResult error on the persisted message object before SDK appendMessage", () => {
  // message_end 先于 SDK appendMessage，projectExecutionEvent 必须原地修改 event.message，
  // 否则绝对路径/堆栈/原始 details 会落进 JSONL 并在下一轮送回模型。
  const toolResultMessage = {
    role: "toolResult",
    toolCallId: "call",
    content: [{ type: "text", text: "Error: ENOENT /Users/secret/.ssh/id_rsa" }],
    details: { stderr: "ENOENT /Users/secret/.ssh/id_rsa", provider: "https://example/secret" },
    isError: true,
  };
  const event = { type: "message_end", message: toolResultMessage } as unknown as AgentSessionEvent;
  projectExecutionEvent(event);
  assert.equal(toolResultMessage.isError, true);
  assert.deepEqual(toolResultMessage.content, [{ type: "text", text: "Tool execution failed" }]);
  assert.equal(toolResultMessage.details, undefined);
});

test("pi execution keeps the controlled denied tool error text on the persisted message", () => {
  // 受控拒绝保留：原文与 denied 标记都进入 JSONL，让下一次模型仍能基于明确文案重试/修正。
  const toolResultMessage = {
    role: "toolResult",
    toolCallId: "call",
    content: [{ type: "text", text: "Access denied: path is outside the documents directory or contains a symlink." }],
    details: { denied: true },
    isError: true,
  };
  const event = { type: "message_end", message: toolResultMessage } as unknown as AgentSessionEvent;
  projectExecutionEvent(event);
  assert.deepEqual(toolResultMessage.content, [{ type: "text", text: "Access denied: path is outside the documents directory or contains a symlink." }]);
  assert.deepEqual(toolResultMessage.details, { denied: true });
});

test("pi execution does not touch a successful toolResult message", () => {
  const toolResultMessage = {
    role: "toolResult",
    toolCallId: "call",
    content: [{ type: "text", text: "literal file contents" }],
    details: { foo: "bar" },
    isError: false,
  };
  const event = { type: "message_end", message: toolResultMessage } as unknown as AgentSessionEvent;
  projectExecutionEvent(event);
  assert.deepEqual(toolResultMessage.content, [{ type: "text", text: "literal file contents" }]);
  assert.deepEqual(toolResultMessage.details, { foo: "bar" });
});
