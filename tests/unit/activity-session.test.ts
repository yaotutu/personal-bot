import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createActivityHistory } from "../../src/adapters/pi/activity-history.js";
import { createActivitySession, projectActivities } from "../../src/features/activities/activity-session.js";
import { createActivityObserver } from "../../src/adapters/pi/activity-observer.js";
import { createToolPresentation } from "../../src/adapters/ag-ui/tool-presentation.js";
import { ActivityError, type ActivityEntry } from "../../src/features/activities/types.js";

test("activity-session: start creates running overview and execution step; duplicate start is idempotent", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  const activity = run1.start({
    title: "Test work",
    goal: "Achieve outcome",
    deliverable: "Deliverable document",
  });

  assert.equal(activity.spaceId, "thread-1");
  assert.equal(activity.title, "Test work");
  assert.equal(activity.status, "running");
  assert.equal(activity.currentRunId, "run-1");

  // 在同一 run 内重复 start 必须幂等返回当前 activity，不创建新记录
  const repeat = run1.start({
    title: "Another title",
    goal: "Another goal",
    deliverable: "Another deliverable",
  });
  assert.equal(repeat.id, activity.id);
  assert.equal(repeat.title, "Test work");

  const details = session.details();
  assert.equal(details.length, 1);
  assert.equal(details[0]?.steps.length, 1);
  assert.equal(details[0]?.steps[0]?.kind, "execution");
  assert.equal(details[0]?.steps[0]?.status, "running");

  run1.close();
});

test("activity-session: update and wait update overview progress and status", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });

  run1.update("Step 1 done");
  let detail = session.details()[0]!;
  assert.equal(detail.activity.progress, "Step 1 done");
  assert.equal(detail.activity.status, "running");

  run1.wait("Please choose option A or B");
  detail = session.details()[0]!;
  assert.equal(detail.activity.status, "waiting_user");
  assert.equal(detail.activity.progress, "Please choose option A or B");

  run1.finish("completed", true);
  run1.close();

  // 结束本轮后，未声明 complete 而是 wait，终态保持 waiting_user
  detail = session.details()[0]!;
  assert.equal(detail.activity.status, "waiting_user");
  assert.equal(detail.activity.currentRunId, null);
  assert.equal(detail.activity.finishedAt, null);
});

test("activity-session: complete guard requires unfinished steps to complete first", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });

  // 模拟工具步骤正在运行
  run1.observe({
    id: "tool-1",
    kind: "tool",
    phase: "start",
    title: "Tool executing",
  });

  // 在工具运行期间调用 complete 必须被受控拦截抛错
  assert.throws(() => {
    run1.complete("All done");
  }, (err: unknown) => err instanceof ActivityError && err.message.includes("Wait for tools"));

  // 工具结束后即可正常 complete
  run1.observe({
    id: "tool-1",
    kind: "tool",
    phase: "end",
    status: "succeeded",
    title: "Tool finished",
  });

  const completedOverview = run1.complete("Final deliverable ready");
  assert.match(completedOverview.progress, /Completion declared/);

  // 最终 run 结束且 delivered 确认，活动才真正投影为 completed
  run1.finish("completed", true);
  run1.close();

  const detail = session.details()[0]!;
  assert.equal(detail.activity.status, "completed");
  assert.equal(detail.activity.result, "Final deliverable ready");
  assert.ok(detail.activity.finishedAt);
});

test("activity-session: finish without complete results in awaiting_continuation", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });
  run1.update("Partially done");

  // 模型回复了，但没有声明 complete
  run1.finish("completed", true);
  run1.close();

  const detail = session.details()[0]!;
  assert.equal(detail.activity.status, "awaiting_continuation");
  assert.equal(detail.activity.currentRunId, null);
  assert.equal(detail.activity.finishedAt, null);
});

test("activity-session: stop marks activity and running steps as stopped/cancelled", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });
  run1.observe({ id: "tool-1", kind: "tool", phase: "start", title: "Tool running" });

  run1.finish("stopped");
  run1.close();

  const detail = session.details()[0]!;
  assert.equal(detail.activity.status, "stopped");
  assert.ok(detail.activity.finishedAt);
  const toolStep = detail.steps.find((s) => s.id.includes("tool-1"))!;
  assert.equal(toolStep.status, "cancelled");
});

test("activity-session: resume continues the same activity and appends execution step", () => {
  const manager = SessionManager.inMemory("/tmp");
  const history = createActivityHistory(manager);
  const session = createActivitySession("thread-1", history);

  const run1 = session.beginRun("run-1");
  const initial = run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });
  run1.finish("stopped");
  run1.close();

  // 下一轮继续
  const run2 = session.beginRun("run-2");
  const resumed = run2.resume(initial.id);
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.currentRunId, "run-2");
  assert.deepEqual(resumed.runIds, ["run-1", "run-2"]);

  // complete 并结束
  run2.complete("Delivered in second turn");
  run2.finish("completed", true);
  run2.close();

  const detail = session.details()[0]!;
  assert.equal(detail.activity.status, "completed");
  assert.equal(detail.activity.result, "Delivered in second turn");
  // 两个 execution 步骤均保留
  const executionSteps = detail.steps.filter((s) => s.kind === "execution");
  assert.equal(executionSteps.length, 2);
  assert.equal(executionSteps[0]?.status, "cancelled");
  assert.equal(executionSteps[1]?.status, "succeeded");
});

test("activity-session: resume rejects completed activity or cross-thread activity", () => {
  const manager1 = SessionManager.inMemory("/tmp");
  const history1 = createActivityHistory(manager1);
  const session1 = createActivitySession("thread-1", history1);

  const run1 = session1.beginRun("run-1");
  const act = run1.start({ title: "Work", goal: "Goal", deliverable: "Deliv" });
  run1.complete("Done");
  run1.finish("completed", true);
  run1.close();

  const run2 = session1.beginRun("run-2");
  assert.throws(() => {
    run2.resume(act.id);
  }, /Activity cannot be resumed/);
  run2.close();

  // 跨会话拒绝
  const manager2 = SessionManager.inMemory("/tmp");
  const history2 = createActivityHistory(manager2);
  const session2 = createActivitySession("thread-2", history2);
  const runOther = session2.beginRun("run-other");
  assert.throws(() => {
    runOther.resume(act.id);
  }, /Activity not found in this conversation/);
  runOther.close();
});

test("activity-session: interrupted state when process crashes and run is no longer active", () => {
  const entries: ActivityEntry[] = [
    {
      kind: "overview",
      activity: {
        id: "a1a1a1a1-1111-4111-8111-111111111111",
        spaceId: "thread-1",
        title: "Interrupted work",
        goal: "Goal",
        deliverable: "Deliverable",
        status: "running",
        progress: "In progress",
        result: null,
        runIds: ["run-crashed"],
        currentRunId: "run-crashed",
        createdAt: "2026-10-18T00:00:00.000Z",
        updatedAt: "2026-10-18T00:00:00.000Z",
        finishedAt: null,
      },
    },
    {
      kind: "step",
      activityId: "a1a1a1a1-1111-4111-8111-111111111111",
      step: {
        id: "run-crashed:execution",
        runId: "run-crashed",
        parentId: null,
        kind: "execution",
        title: "Work execution",
        status: "running",
        startedAt: "2026-10-18T00:00:00.000Z",
        finishedAt: null,
        result: null,
      },
    },
  ];

  // 当 isRunning 返回 false 时，投影必须将当前运行状态映射为 interrupted
  const projected = projectActivities(entries, () => false);
  assert.equal(projected[0]?.activity.status, "interrupted");
  assert.equal(projected[0]?.activity.currentRunId, null);
  assert.equal(projected[0]?.steps[0]?.status, "interrupted");
  assert.equal(projected[0]?.steps[0]?.finishedAt, null);
  const session = createActivitySession("thread-1", { read: () => structuredClone(entries), append: (entry) => { entries.push(entry); } });
  const next = session.beginRun("run-resumed");
  next.resume(projected[0]!.activity.id);
  next.complete("Delivered after explicit continuation");
  next.finish("completed", true);
  next.close();
  const resumed = session.details()[0]!;
  assert.equal(resumed.activity.status, "completed");
  assert.deepEqual(resumed.steps[0], projected[0]?.steps[0]);
  assert.equal(resumed.steps[1].status, "succeeded");
});

test("activity-observer: records model, tool, approval, subagent and file commit steps without leaking secrets", () => {
  const events: unknown[] = [];
  const presentation = createToolPresentation({
    default: "summary",
    overrides: { currentTime: "hidden" },
  });
  const observer = createActivityObserver((ev) => events.push(ev), presentation, "main");

  // 1. turn_start -> model step
  observer({ type: "turn_start" } as never);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: "main:model:1",
    parentId: undefined,
    kind: "model",
    phase: "start",
    title: "Model processing",
  });

  // 2. message_end -> model finish
  observer({
    type: "message_end",
    message: { role: "assistant", stopReason: "toolUse", content: [] },
  } as never);
  assert.equal(events.length, 2);
  assert.equal((events[1] as { status?: string }).status, "succeeded");

  // 3. tool_execution_start (hidden tool) -> hides tool name
  observer({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "currentTime",
  } as never);
  assert.equal((events[2] as { title?: string }).title, "Executing tool");

  // 4. tool_execution_end
  observer({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "currentTime",
    result: { content: [{ type: "text", text: "2026-10-18" }] },
    isError: false,
  } as never);
  assert.equal((events[3] as { title?: string }).title, "Tool finished");
  assert.equal((events[3] as { status?: string }).status, "succeeded");

  // 5. write tool commit step
  observer({
    type: "tool_execution_start",
    toolCallId: "call-write",
    toolName: "write",
  } as never);
  observer({
    type: "tool_execution_end",
    toolCallId: "call-write",
    toolName: "write",
    result: { content: [{ type: "text", text: "Saved." }] },
    isError: false,
  } as never);
  // write 结束时会额外生成 file_commit 步骤
  const commitStep = events.find((e) => (e as { kind?: string }).kind === "file_commit");
  assert.ok(commitStep);
  assert.equal((commitStep as { status?: string }).status, "succeeded");

  // 6. activity tool calls are ignored by observer
  const beforeLen = events.length;
  observer({
    type: "tool_execution_start",
    toolCallId: "call-act",
    toolName: "activity",
  } as never);
  assert.equal(events.length, beforeLen);
});
