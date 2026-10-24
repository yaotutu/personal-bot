import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamAggregator, projectHistory } from "../../web/src/chat/chat-state.js";

test("attachment-only user history and snapshots retain file metadata", () => {
  const attachment = {
    id: "file-1", name: "notes.txt", kind: "text" as const, mimeType: "text/plain", size: 5,
    sha256: "a".repeat(64),
  };
  const messages = [{ id: "user-file", role: "user" as const, content: "", attachments: [attachment] }];
  assert.deepEqual(projectHistory(messages)[0], {
    id: "user-file", role: "user", text: "", attachments: [attachment], toolCalls: [],
  });

  const stream = new StreamAggregator([]);
  stream.push({ type: "MESSAGES_SNAPSHOT", messages });
  assert.deepEqual(stream.messages[0]?.attachments, [attachment]);
});

test("chat stream reuses the tool placeholder when text starts with the same assistant ID", () => {
  const stream = new StreamAggregator([]);
  stream.push({ type: "TOOL_CALL_START", parentMessageId: "assistant-run", toolCallId: "tool", toolCallName: "currentTime" });
  stream.push({ type: "TOOL_CALL_ARGS", toolCallId: "tool", delta: "{}" });
  stream.push({ type: "TOOL_CALL_END", toolCallId: "tool" });
  stream.push({ type: "TOOL_CALL_RESULT", messageId: "tool-tool", role: "tool", toolCallId: "tool", content: "noon" });
  stream.push({ type: "TEXT_MESSAGE_START", role: "assistant", messageId: "assistant-run" });
  stream.push({ type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-run", delta: "It is noon" });
  stream.push({ type: "TEXT_MESSAGE_END", messageId: "assistant-run" });
  // 同一轮可经历多个文本阶段；稳定 ID 不应产生第二个 React 消息节点。
  stream.push({ type: "TEXT_MESSAGE_START", role: "assistant", messageId: "assistant-run" });
  stream.push({ type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-run", delta: "." });
  stream.settle();
  assert.equal(stream.messages.length, 1);
  assert.equal(stream.messages[0]?.text, "It is noon.");
  assert.deepEqual(stream.messages[0]?.toolCalls, [{ id: "tool", name: "currentTime", args: "{}", result: "noon" }]);
  assert.equal(stream.messages[0]?.streaming, false);
});

test("chat snapshot clears detached stream state before later tool and text events", () => {
  const stream = new StreamAggregator([]);
  stream.push({ type: "TOOL_CALL_START", parentMessageId: "old", toolCallId: "call", toolCallName: "old" });
  stream.push({ type: "TOOL_CALL_ARGS", toolCallId: "call", delta: "stale" });
  stream.push({ type: "MESSAGES_SNAPSHOT", messages: [{ id: "user", role: "user", content: "hello" }] });
  stream.push({ type: "TOOL_CALL_START", parentMessageId: "new", toolCallId: "call", toolCallName: "new" });
  stream.push({ type: "TOOL_CALL_END", toolCallId: "call" });
  stream.push({ type: "TEXT_MESSAGE_START", role: "assistant", messageId: "new" });
  stream.push({ type: "TEXT_MESSAGE_CONTENT", messageId: "new", delta: "fresh" });
  assert.deepEqual(stream.messages.map((message) => message.id), ["user", "new"]);
  assert.equal(stream.messages[1]?.text, "fresh");
  assert.equal(stream.messages[1]?.toolCalls[0]?.args, "{}");
});
