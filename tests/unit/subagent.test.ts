import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { createSubagentTool, type SubagentRole } from "../../src/adapters/pi/subagent/extension.js";
import { projectExecutionEvent } from "../../src/adapters/pi/execution.js";

const roles: SubagentRole[] = [
  { name: "worker", description: "Work", systemPrompt: "Work" },
  { name: "scout", description: "Scout", systemPrompt: "Scout" },
  { name: "reviewer", description: "Review", systemPrompt: "Review" },
];
const context = undefined as never;

test("SDK validateToolArguments strictly validates subagent tool arguments against schema", () => {
  const tool = createSubagentTool(roles, async (role, task) => ({ agent: role.name, task, output: task }));
  const call = (args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: "test-call", name: "subagent", arguments: args });

  // 合法入参通过校验
  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "worker", task: "hello" }] })));
  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "parallel", tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] })));
  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "chain", tasks: [{ agent: "worker", task: "a" }, { agent: "reviewer", task: "b" }] })));

  // 必填 mode / tasks 缺失
  assert.throws(() => validateToolArguments(tool, call({ tasks: [{ agent: "worker", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single" })));

  // 无效枚举
  assert.throws(() => validateToolArguments(tool, call({ mode: "concurrent", tasks: [{ agent: "worker", task: "a" }] })));

  // 空数组 (minItems: 1) 与超限 (maxItems: 8)
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "parallel", tasks: Array.from({ length: 9 }, () => ({ agent: "worker", task: "a" })) })));

  // 空字符串字段 (minLength: 1)
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "worker", task: "" }] })));

  // 旧字段与混传拒绝 (additionalProperties: false)
  assert.throws(() => validateToolArguments(tool, call({ agent: "worker", task: "a" })));
  assert.throws(() => validateToolArguments(tool, call({ chain: [{ agent: "worker", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "worker", task: "a" }], extra: true })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "chain", tasks: [{ agent: "worker", task: "a" }], agent: "planner", task: "unused" })));
});

test("subagent schema adapts to strict JSON schema constrained sampling", () => {
  const tool = createSubagentTool(roles, async (role, task) => ({ agent: role.name, task, output: task }));

  const strictSchema = makeStrictJsonSchema(tool.parameters);
  assert.equal(strictSchema.type, "object");
  assert.deepEqual(strictSchema.required, ["mode", "tasks"]);
  assert.equal(strictSchema.additionalProperties, false);

  const supportsStrict = resolveJsonSchemaStrictSampling(tool, true);
  assert.equal(supportsStrict, true);
});

test("subagent rejects single with multiple tasks and unknown roles before queuing or executing", async () => {
  let runs = 0;
  let queuedCount = 0;
  const tool = createSubagentTool(
    roles,
    async (role, task) => { runs++; return { agent: role.name, task, output: task }; },
    () => { queuedCount++; },
  );

  // single 包含两项：在排队与执行前受控拒绝
  const singleMulti = await tool.execute(
    "c-1",
    { mode: "single", tasks: [{ agent: "worker", task: "SECRET_TASK_1" }, { agent: "worker", task: "SECRET_TASK_2" }] },
    undefined, undefined, context,
  );
  assert.equal(singleMulti.isError, true);
  assert.equal(singleMulti.details?.denied, true);
  assert.equal(singleMulti.details?.mode, "single");
  assert.equal(runs, 0);
  assert.equal(queuedCount, 0);
  const singleText = singleMulti.content[0].type === "text" ? singleMulti.content[0].text : "";
  assert.equal(singleText, "Single mode requires exactly one task. For multiple tasks, set mode to 'chain' (sequential) or 'parallel' (concurrent).");
  assert.ok(!singleText.includes("SECRET_TASK"));

  // 经由 projectExecutionEvent 处理时，受控拒绝文案被完整保留且不被通用错误覆盖
  const projectedSingle = projectExecutionEvent({
    type: "tool_execution_end",
    toolCallId: "c-1",
    toolName: "subagent",
    result: singleMulti,
    isError: true,
  });
  assert.equal(projectedSingle?.type, "tool_result");
  if (projectedSingle?.type === "tool_result") {
    assert.equal(projectedSingle.content, "Single mode requires exactly one task. For multiple tasks, set mode to 'chain' (sequential) or 'parallel' (concurrent).");
  }

  // 未知角色：在排队与执行前受控拒绝，不泄露未知角色名与任务正文
  const unknownRole = await tool.execute(
    "c-2",
    { mode: "single", tasks: [{ agent: "SECRET_UNKNOWN_ROLE", task: "SECRET_TASK_BODY" }] },
    undefined, undefined, context,
  );
  assert.equal(unknownRole.isError, true);
  assert.equal(unknownRole.details?.denied, true);
  assert.equal(runs, 0);
  assert.equal(queuedCount, 0);
  const unknownText = unknownRole.content[0].type === "text" ? unknownRole.content[0].text : "";
  assert.ok(unknownText.startsWith("Unknown agent role. Available agents: "));
  assert.ok(!unknownText.includes("SECRET_UNKNOWN_ROLE"));
  assert.ok(!unknownText.includes("SECRET_TASK_BODY"));

  const projectedUnknown = projectExecutionEvent({
    type: "tool_execution_end",
    toolCallId: "c-2",
    toolName: "subagent",
    result: unknownRole,
    isError: true,
  });
  assert.equal(projectedUnknown?.type, "tool_result");
  if (projectedUnknown?.type === "tool_result") {
    assert.ok(projectedUnknown.content.startsWith("Unknown agent role. Available agents: "));
    assert.ok(!projectedUnknown.content.includes("SECRET_UNKNOWN_ROLE"));
  }
});

test("subagent execution failure is scrubbed and does not carry denied flag", async () => {
  const tool = createSubagentTool(roles, async () => {
    throw new Error("SECRET_INTERNAL_DATABASE_CRASH");
  });

  const failedResult = await tool.execute(
    "c-exec",
    { mode: "single", tasks: [{ agent: "worker", task: "normal work" }] },
    undefined, undefined, context,
  );
  assert.equal(failedResult.isError, true);
  // 执行期失败绝不标记 denied: true
  assert.equal(failedResult.details?.denied, undefined);

  // 经由 projectExecutionEvent 时必须被脱敏为通用 Tool execution failed
  const projected = projectExecutionEvent({
    type: "tool_execution_end",
    toolCallId: "c-exec",
    toolName: "subagent",
    result: failedResult,
    isError: true,
  });
  assert.equal(projected?.type, "tool_result");
  if (projected?.type === "tool_result") {
    assert.equal(projected.content, "Tool execution failed");
  }
});

test("official subagent protocol preserves single and chain output substitution and stops failed chains", async () => {
  const calls: string[] = [];
  const tool = createSubagentTool(roles, async (role, task) => {
    calls.push(task);
    return { agent: role.name, task, output: task === "first" ? "literal $& value" : task, isError: task === "fail" };
  });
  const single = await tool.execute("one", { mode: "single", tasks: [{ agent: "worker", task: "single" }] }, undefined, undefined, context);
  assert.equal(single.content[0].type === "text" && single.content[0].text, "single");
  const chain = await tool.execute("chain", { mode: "chain", tasks: [{ agent: "worker", task: "first" }, { agent: "worker", task: "next {previous}" }] }, undefined, undefined, context);
  assert.equal(chain.content[0].type === "text" && chain.content[0].text, "next literal $& value");
  const failed = await tool.execute("failed", { mode: "chain", tasks: [{ agent: "worker", task: "fail" }, { agent: "worker", task: "not-run" }] }, undefined, undefined, context);
  assert.equal(failed.isError, true);
  assert.ok(!calls.includes("not-run"));
});

test("subagent parallel mode limits concurrency to four, preserves input order and caps UTF-8 output", async () => {
  let active = 0;
  let peak = 0;
  const tool = createSubagentTool(roles, async (role, task) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, Number(task) % 2 ? 1 : 5));
    active--;
    return { agent: role.name, task, output: "中".repeat(30_000) };
  });
  const result = await tool.execute("parallel", { mode: "parallel", tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "worker", task: String(i) })) }, undefined, undefined, context);
  assert.equal(peak, 4);
  assert.deepEqual(result.details?.results.map((entry) => entry.task), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.ok(result.details?.results.every((entry) => Buffer.byteLength(entry.output) < 52_000 && !entry.output.includes("\ufffd")));
});

test("subagent child initialization failures are sanitized and preserve parallel mode", async () => {
  const tool = createSubagentTool(roles, async () => { throw new Error("PRIVATE-CHILD-DIAGNOSTIC"); });
  const result = await tool.execute("parallel", { mode: "parallel", tasks: [{ agent: "worker", task: "work" }, { agent: "worker", task: "more" }] }, undefined, undefined, context);
  assert.equal(result.isError, true);
  assert.equal(result.details?.mode, "parallel");
  assert.equal(result.details?.results.length, 2);
  assert.ok(!JSON.stringify(result).includes("PRIVATE-CHILD-DIAGNOSTIC"));
  assert.equal(result.details?.denied, undefined);
});

test("subagent cancellation waits for active children and does not start queued children", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  let cleaned = 0;
  const tool = createSubagentTool(roles, async (role, task, signal) => {
    started.push(task);
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => { cleaned++; resolve(); }, { once: true }));
    return { agent: role.name, task, output: "cancelled" };
  });
  const work = tool.execute("parallel", { mode: "parallel", tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "worker", task: String(i) })) }, controller.signal, undefined, context);
  assert.equal(started.length, 4);
  controller.abort();
  await assert.rejects(work);
  assert.equal(cleaned, 4);
  assert.equal(started.length, 4);
});
