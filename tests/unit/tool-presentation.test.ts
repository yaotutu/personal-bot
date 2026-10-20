import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { createConfig } from "../../src/config/load-config.js";
import { createToolPresentation } from "../../src/adapters/ag-ui/tool-presentation.js";
import { createEventProjector } from "../../src/adapters/ag-ui/events.js";
import type { ConversationHistory, ConversationEvent } from "../../src/features/conversation/types.js";

const policy = (defaultMode: "hidden" | "summary" = "hidden", overrides: Record<string, "hidden" | "summary"> = {}) =>
  createToolPresentation({ default: defaultMode, overrides });

const historyFixture = (): ConversationHistory => [
  { id: "u", role: "user", content: "请读资料并记住" },
  { id: "a", role: "assistant", content: "处理好了", toolCalls: [
    { id: "read-id", type: "function", function: { name: "read", arguments: '{"path":"private.txt"}' } },
    { id: "memory-id", type: "function", function: { name: "memory", arguments: '{"action":"remember","text":"private fact"}' } },
  ] },
  { id: "tool-read-id", role: "tool", toolCallId: "read-id", content: "private file content" },
  { id: "tool-memory-id", role: "tool", toolCallId: "memory-id", content: "Remembered: private fact" },
];

const lifecycle: ConversationEvent[] = [
  { type: "run_started", runId: "r", threadId: "local-main", assistantId: "a" },
  { type: "tool_start", id: "tool", name: "memory" },
  { type: "tool_delta", id: "tool", name: "memory", delta: '{"text":"private fact"}' },
  { type: "tool_end", id: "tool", name: "memory", arguments: { action: "remember", text: "private fact" } },
  { type: "tool_result", id: "tool", content: "Remembered: private fact" },
  { type: "text_delta", delta: "处理好了" },
  { type: "text_end", assistantId: "a" },
  { type: "run_finished", runId: "r", threadId: "local-main" },
];

test("presentation config defaults hidden, supports overrides for disabled capabilities, rejects invalid modes/names", () => {
  assert.deepEqual(createConfig({}).presentation, { default: "hidden", overrides: {} });
  assert.deepEqual(createConfig({ tools: { web: { enabled: false }, presentation: { overrides: { search_web: "summary" } } } }).presentation,
    { default: "hidden", overrides: { search_web: "summary" } });
  for (const presentation of [
    { default: "full" }, { overrides: { read: "full" } }, { overrides: { invented_tool: "hidden" } },
    { default: "hidden", unknown: true },
  ]) assert.throws(() => createConfig({ tools: { presentation } }));
});

test("hidden filters every tool phase without suppressing assistant text or terminal events", () => {
  const output: BaseEvent[] = [];
  const emit = createEventProjector((event) => output.push(event), policy());
  lifecycle.forEach(emit);
  assert.deepEqual(output.map((event) => event.type), [
    EventType.RUN_STARTED, EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED,
  ]);
  assert.ok(!JSON.stringify(output).includes("private fact"));
});

test("summary events preserve names/IDs and order but never raw argument deltas or content", () => {
  const output: BaseEvent[] = [];
  const emit = createEventProjector((event) => output.push(event), policy("summary"));
  lifecycle.forEach(emit);
  const tools = output.filter((event) => event.type.startsWith("TOOL_CALL")) as (BaseEvent & Record<string, unknown>)[];
  assert.deepEqual(tools.map((event) => event.type), [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]);
  assert.equal(tools[0]?.toolCallName, "memory");
  assert.ok(tools.every((event) => event.toolCallId === "tool"));
  assert.equal(tools[1]?.delta, "{}");
  assert.equal(tools[3]?.content, "已保存记忆");
  assert.ok(!JSON.stringify(output).includes("private fact"));
});

test("summary repairs missing start on end-only tools and drops orphan results", () => {
  const output: BaseEvent[] = [];
  const emit = createEventProjector((event) => output.push(event), policy("summary"));
  emit({ type: "tool_end", id: "t", name: "read", arguments: { path: "/private/file" } });
  emit({ type: "tool_result", id: "t", content: "raw file" });
  emit({ type: "tool_result", id: "orphan", content: "unmatched secret" });
  assert.equal(output.length, 4);
  assert.equal(output[0]?.type, EventType.TOOL_CALL_START);
  assert.ok(!JSON.stringify(output).includes("raw file"));
  assert.ok(!JSON.stringify(output).includes("unmatched secret"));
});

test("history filters matching hidden calls/results, preserves user IDs and is immutable and idempotent", () => {
  const source = historyFixture();
  const before = structuredClone(source);
  const presentation = policy("hidden", { memory: "summary" });
  const shown = presentation.presentHistory(source);
  assert.deepEqual(source, before);
  assert.equal(shown.length, 3);
  assert.deepEqual(shown[0], source[0]);
  const assistant = shown[1];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.equal(assistant.id, "a");
    assert.deepEqual(assistant.toolCalls?.map((call) => call.id), ["memory-id"]);
    assert.equal(assistant.toolCalls?.[0]?.function.arguments, "{}");
  }
  assert.equal(shown[2]?.content, "已保存记忆");
  assert.deepEqual(presentation.presentHistory(shown), shown);
  assert.ok(!JSON.stringify(shown).includes("private"));
});

test("hidden prunes tool-only assistant and orphan tool messages but preserves nonempty intermediate text", () => {
  const source = historyFixture();
  if (source[1]?.role === "assistant") source[1].content = "";
  source.push({ id: "orphan", role: "tool", toolCallId: "unknown", content: "orphan private" });
  assert.deepEqual(policy().presentHistory(source), [source[0]]);
  if (source[1]?.role === "assistant") source[1].content = "我先查一下";
  const shown = policy().presentHistory(source);
  assert.equal(shown.length, 2);
  assert.equal(shown[1]?.content, "我先查一下");
});

test("history snapshot applies the same policy and remains idempotent on already projected history", () => {
  const presentation = policy("hidden", { memory: "summary" });
  const shown = presentation.presentHistory(historyFixture());
  const output: BaseEvent[] = [];
  const emit = createEventProjector((event) => output.push(event), presentation);
  emit({ type: "history_snapshot", messages: shown });
  assert.deepEqual((output[0] as BaseEvent & { messages: unknown }).messages, shown);
});

test("search summary preserves SearchToolCard schema but strips excerpts, warnings and URL query/fragment", () => {
  const presentation = policy("summary");
  const content = JSON.stringify({ results: [
    { title: "A source", url: "https://example.com/article?token=private#fragment", snippet: "private snippet" },
    { title: "invalid", url: "javascript:alert(1)" },
  ], warnings: ["private diagnostic"], truncated: false });
  const summary = presentation.presentResult("search_web", content);
  assert.deepEqual(JSON.parse(summary), {
    results: [{ title: "A source", url: "https://example.com/article" }],
    warnings: ["部分搜索信息未展示。"], truncated: true,
  });
  assert.ok(!summary.includes("private"));
  assert.equal(presentation.presentResult("search_web", summary), summary);
  for (const raw of ["broken", "null", '{"error":"private failure"}', "Tool execution failed"]) {
    const error = presentation.presentResult("search_web", raw);
    assert.deepEqual(JSON.parse(error), { error: "Search failed." });
    assert.equal(presentation.presentResult("search_web", error), error);
  }
});

test("history failure uses pi isError, drops internal metadata and remains failed after a second projection", () => {
  const presentation = policy("summary");
  const raw: ConversationHistory = [
    { role: "assistant", id: "a", content: "", toolCalls: [{ id: "s", type: "function", function: { name: "schedule", arguments: "{}" } }] },
    { role: "tool", id: "tool-s", toolCallId: "s", content: "Invalid time: private diagnostic", isError: true },
  ];
  const shown = presentation.presentHistory(raw);
  assert.equal(shown[1]?.content, "工具执行失败");
  assert.equal(Object.hasOwn(shown[1]!, "isError"), false);
  assert.deepEqual(presentation.presentHistory(shown), shown);
  assert.equal(raw[1]?.content, "Invalid time: private diagnostic");
});

test("summaries are bounded and failures/unknown results never masquerade as writes", () => {
  const presentation = policy("summary");
  assert.equal(presentation.presentResult("memory", "Remembered: private text"), "已保存记忆");
  assert.equal(presentation.presentResult("memory", "Forgot memory private-id"), "已删除记忆");
  assert.equal(presentation.presentResult("memory", "Edited memory private-id"), "已修改记忆");
  assert.equal(presentation.presentResult("memory", "No memory with id private-id."), "未找到该记忆");
  assert.equal(presentation.presentResult("memory_search", "- [private-id] private text"), "已检索记忆");
  assert.equal(presentation.presentResult("memory_search", 'No memory matches "private".'), "未找到匹配的记忆");
  assert.equal(presentation.presentResult("schedule", 'Scheduled (id abc): "private job" next at 2030-01-01.'), "已创建提醒");
  assert.equal(presentation.presentResult("schedule", "Tool execution failed"), "工具执行失败");
  assert.equal(presentation.presentResult("read", "Access denied: path is outside the documents directory."), "Access denied: path is outside the documents directory.");
  for (const name of ["read", "web_fetch", "memory", "memory_search", "schedule", "old_tool"]) {
    const summary = presentation.presentResult(name, "unrecognized " + "secret".repeat(10000));
    assert.equal(summary, "工具执行已结束（详情已隐藏）");
    assert.equal(presentation.presentResult(name, summary), summary);
  }
  assert.equal(presentation.modeFor("toString"), "summary");
  assert.equal(policy().modeFor("toString"), "hidden");
  assert.equal(presentation.presentResult("currentTime", "local details\nISO 8601: 2026-10-12T00:00:00.000Z"), "ISO 8601: 2026-10-12T00:00:00.000Z");
  assert.equal(presentation.presentResult("get_weather", "place details\n当前 20°C，体感 19.5°C\nmore details"), "当前 20°C，体感 19.5°C");
});
