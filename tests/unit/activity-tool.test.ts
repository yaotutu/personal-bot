import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityError, type ActivityOverview, type ActivityRun } from "../../src/features/activities/types.js";
import {
  ACTIVITY_TOOL_INSTRUCTIONS,
  ACTIVITY_TOOL_NAME,
  createActivityTool,
} from "../../src/adapters/pi/tools/activity.js";

const overview = (overrides: Partial<ActivityOverview> = {}): ActivityOverview => ({
  id: "activity-1",
  spaceId: "thread-1",
  title: "Research",
  goal: "Compare options",
  deliverable: "A short report",
  status: "running",
  progress: "Work started",
  result: null,
  runIds: ["run-1"],
  currentRunId: "run-1",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

/** 记录调用并返回固定投影；不触碰文件系统、存储或 provider。 */
const fakeRun = () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record = <T>(method: string, value: T) => {
    calls.push({ method, input: value });
    return overview({ progress: method });
  };
  const run: ActivityRun = {
    start: (input) => record("start", input),
    resume: (id) => record("resume", id),
    update: (progress) => record("update", progress),
    wait: (question) => record("wait", question),
    complete: (result) => record("complete", result),
    getCurrentActivityId: () => undefined,
    observe: () => undefined,
    finish: () => undefined,
    close: () => undefined,
  };
  return { run, calls };
};

const execute = (run: ActivityRun, params: Record<string, unknown>) =>
  createActivityTool(run).execute("call-1", params as never, undefined, undefined, {} as never);

const textOf = (result: Awaited<ReturnType<typeof execute>>) => {
  const [first] = result.content;
  assert.equal(first.type, "text");
  return first.type === "text" ? first.text : "";
};

const body = (result: Awaited<ReturnType<typeof execute>>) => JSON.parse(textOf(result));

test("activity tool exports a stable name and the registration semantics", () => {
  assert.equal(ACTIVITY_TOOL_NAME, "activity");
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /actually starting to advance/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /Ordinary conversation/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /resume with the existing activityId/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /contribute steps only/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /pending completion/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /approval is not a successful commit/);
  assert.match(ACTIVITY_TOOL_INSTRUCTIONS, /does not queue work/);
});

test("activity schema requires only action and forbids extra properties", () => {
  const tool = createActivityTool(fakeRun().run);
  assert.equal(tool.name, "activity");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(tool.parameters.properties.action.anyOf.map((item: { const: string }) => item.const), [
    "start", "resume", "update", "wait", "complete",
  ]);
});

test("start delegates trimmed title, goal and deliverable without completionPending", async () => {
  const { run, calls } = fakeRun();
  const result = await execute(run, {
    action: "start",
    title: "  Research  ",
    goal: "  Compare options  ",
    deliverable: "  A short report  ",
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{
    method: "start",
    input: { title: "Research", goal: "Compare options", deliverable: "A short report" },
  }]);
  assert.equal(body(result).activity.id, "activity-1");
  assert.equal("completionPending" in body(result), false);
});

test("resume, update and wait delegate their required value", async () => {
  const { run, calls } = fakeRun();
  await execute(run, { action: "resume", activityId: " activity-1 " });
  await execute(run, { action: "update", progress: " half done " });
  await execute(run, { action: "wait", progress: " Which format? " });
  assert.deepEqual(calls, [
    { method: "resume", input: "activity-1" },
    { method: "update", input: "half done" },
    { method: "wait", input: "Which format?" },
  ]);
});

test("complete delegates result and reports pending completion", async () => {
  const { run, calls } = fakeRun();
  const result = await execute(run, { action: "complete", result: " Delivered the report " });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: "complete", input: "Delivered the report" }]);
  assert.deepEqual(body(result), { activity: overview({ progress: "complete" }), completionPending: true });
});

test("missing, blank or omitted parameters are controlled errors and never write", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "start" }, /non-blank title/],
    [{ action: "start", title: "   ", goal: "g", deliverable: "d" }, /non-blank title/],
    [{ action: "start", title: "t", deliverable: "d" }, /non-blank goal/],
    [{ action: "start", title: "t", goal: "g", deliverable: "  " }, /non-blank deliverable/],
    [{ action: "resume" }, /non-blank activityId/],
    [{ action: "resume", activityId: " " }, /non-blank activityId/],
    [{ action: "update" }, /non-blank progress/],
    [{ action: "update", progress: "" }, /non-blank progress/],
    [{ action: "wait" }, /non-blank question/],
    [{ action: "wait", progress: "\n\t" }, /non-blank question/],
    [{ action: "complete" }, /non-blank result/],
    [{ action: "complete", result: "   " }, /non-blank result/],
  ];
  for (const [params, message] of cases) {
    const { run, calls } = fakeRun();
    const result = await execute(run, params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.deepEqual(result.details, { denied: true }, JSON.stringify(params));
    assert.match(textOf(result), message);
    assert.equal(calls.length, 0, JSON.stringify(params));
  }
});

test("length limits accept the boundary and reject one character over", async () => {
  const { run, calls } = fakeRun();
  await execute(run, {
    action: "start",
    title: "t".repeat(160),
    goal: "g".repeat(2000),
    deliverable: "d".repeat(2000),
  });
  assert.equal(calls.length, 1);

  const oversized: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "start", title: "t".repeat(161), goal: "g", deliverable: "d" }, /title must be at most 160/],
    [{ action: "start", title: "t", goal: "g".repeat(2001), deliverable: "d" }, /goal must be at most 2000/],
    [{ action: "start", title: "t", goal: "g", deliverable: "d".repeat(2001) }, /deliverable must be at most 2000/],
    [{ action: "update", progress: "p".repeat(2001) }, /progress must be at most 2000/],
    [{ action: "wait", progress: "q".repeat(2001) }, /progress must be at most 2000/],
    [{ action: "complete", result: "r".repeat(2001) }, /result must be at most 2000/],
  ];
  for (const [params, message] of oversized) {
    const { run: fresh, calls: freshCalls } = fakeRun();
    const result = await execute(fresh, params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.deepEqual(result.details, { denied: true });
    assert.match(textOf(result), message);
    assert.equal(freshCalls.length, 0);
  }
});

test("ActivityError is a controlled rejection while unexpected errors are not exposed", async () => {
  const failing: ActivityRun = {
    ...fakeRun().run,
    start: () => {
      throw new ActivityError("Activity cannot be resumed in its current state");
    },
    update: () => {
      throw new Error("secret internal failure");
    },
  };
  const controlled = await execute(failing, { action: "start", title: "t", goal: "g", deliverable: "d" });
  assert.equal(controlled.isError, true);
  assert.deepEqual(controlled.details, { denied: true });
  assert.equal(textOf(controlled), "Activity cannot be resumed in its current state");

  // 非 ActivityError 不在此处吞掉或改写；pi 执行层会统一脱敏。
  await assert.rejects(
    execute(failing, { action: "update", progress: "p" }),
    /secret internal failure/,
  );
});

test("an unknown action is rejected without touching the run", async () => {
  const { run, calls } = fakeRun();
  const result = await execute(run, { action: "cancel" });
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { denied: true });
  assert.match(textOf(result), /Unknown activity action/);
  assert.equal(calls.length, 0);
});
