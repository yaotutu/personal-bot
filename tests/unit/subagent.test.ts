import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentTool, type SubagentRole } from "../../src/adapters/pi/subagent/extension.js";

const roles: SubagentRole[] = [{ name: "worker", description: "Work", systemPrompt: "Work" }];
const context = undefined as never;

test("official subagent protocol preserves single and chain output substitution and stops failed chains", async () => {
  const calls: string[] = [];
  const tool = createSubagentTool(roles, async (role, task) => {
    calls.push(task);
    return { agent: role.name, task, output: task === "first" ? "literal $& value" : task, isError: task === "fail" };
  });
  const single = await tool.execute("one", { agent: "worker", task: "single" }, undefined, undefined, context);
  assert.equal(single.content[0].type === "text" && single.content[0].text, "single");
  const chain = await tool.execute("chain", { chain: [{ agent: "worker", task: "first" }, { agent: "worker", task: "next {previous}" }] }, undefined, undefined, context);
  assert.equal(chain.content[0].type === "text" && chain.content[0].text, "next literal $& value");
  const failed = await tool.execute("failed", { chain: [{ agent: "worker", task: "fail" }, { agent: "worker", task: "not-run" }] }, undefined, undefined, context);
  assert.equal(failed.isError, true);
  assert.ok(!calls.includes("not-run"));
});

test("subagent rejects unknown roles and ambiguous or oversized modes before starting children", async () => {
  let calls = 0;
  const tool = createSubagentTool(roles, async (role, task) => { calls++; return { agent: role.name, task, output: task }; });
  for (const params of [{}, { agent: "missing", task: "work" }, { agent: "worker", task: "work", tasks: [{ agent: "worker", task: "also" }] }, { tasks: Array.from({ length: 9 }, () => ({ agent: "worker", task: "work" })) }]) {
    const result = await tool.execute("invalid", params, undefined, undefined, context);
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(!Object.hasOwn(tool.parameters.properties, "cwd"));
  assert.ok(!Object.hasOwn(tool.parameters.properties, "agentScope"));
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
  const result = await tool.execute("parallel", { tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "worker", task: String(i) })) }, undefined, undefined, context);
  assert.equal(peak, 4);
  assert.deepEqual(result.details?.results.map((entry) => entry.task), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.ok(result.details?.results.every((entry) => Buffer.byteLength(entry.output) < 52_000 && !entry.output.includes("�")));
});

test("subagent child initialization failures are sanitized and preserve parallel mode", async () => {
  const tool = createSubagentTool(roles, async () => { throw new Error("PRIVATE-CHILD-DIAGNOSTIC"); });
  const result = await tool.execute("parallel", { tasks: [{ agent: "worker", task: "work" }, { agent: "worker", task: "more" }] }, undefined, undefined, context);
  assert.equal(result.isError, true);
  assert.equal(result.details?.mode, "parallel");
  assert.equal(result.details?.results.length, 2);
  assert.ok(!JSON.stringify(result).includes("PRIVATE-CHILD-DIAGNOSTIC"));
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
  const work = tool.execute("parallel", { tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "worker", task: String(i) })) }, controller.signal, undefined, context);
  assert.equal(started.length, 4);
  controller.abort();
  await assert.rejects(work);
  assert.equal(cleaned, 4);
  assert.equal(started.length, 4);
});
