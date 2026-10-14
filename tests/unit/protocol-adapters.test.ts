import assert from "node:assert/strict";
import { test } from "node:test";
import { firstValueFrom } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { Conversation } from "../../src/features/conversation/conversation-service.js";
import { ConversationError } from "../../src/features/conversation/errors.js";
import { PiAgent } from "../../src/adapters/ag-ui/agent.js";
import { createRunner } from "../../src/adapters/ag-ui/runner.js";
import { presentJob } from "../../src/http/job-presenters.js";
import { createMemorySchema, editMemorySchema, identitySchema } from "../../src/http/contracts/rest.js";
import type { Job } from "../../src/features/jobs/types.js";

const input: RunAgentInput = {
  threadId: "local-main", runId: "test-run", messages: [],
  state: {}, tools: [], context: [], forwardedProps: {},
};
const job: Job = {
  id: "job-id", prompt: "x".repeat(100), daily: false,
  at: "2030-01-01T00:00:00.000Z", enabled: true,
  createdAt: "2026-10-11T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
};

// 仅提供 adapter 真正用到的协调方法，不创建第二个执行内核或持久化历史。
const stubConversation = (methods: Pick<Conversation, "run" | "cancel" | "isRunning">) =>
  methods as Conversation;

const hubOf = (conversation: ReturnType<typeof stubConversation>) => ({
    // 与真实 hub 一致：非法 threadId 抛错，由调用方捕获。
    forThread: async (id: string) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
        throw new Error("UNSUPPORTED_THREAD");
      return conversation;
    },
    threads: async () => [],
    closeAll: async () => {},
  });

test("OpenMuse task presenter preserves every legacy field without mutating the job", () => {
  const before = structuredClone(job);
  assert.deepEqual(presentJob(job), {
    id: job.id, title: "x".repeat(80), prompt: job.prompt, kind: "monitor",
    status: "scheduled", plan: [], evidence: [], input: {}, state: {},
    createdAt: job.createdAt, updatedAt: job.createdAt, nextRunAt: job.nextRunAt,
    attempts: 0, artifactIds: [], result: undefined, error: null,
  });
  assert.deepEqual(job, before);
  assert.ok(!Object.hasOwn(JSON.parse(JSON.stringify(presentJob(job))), "result"));
});

test("OpenMuse one-shot task preserves failed status and result metadata after being disabled", () => {
  const failed = { ...job, lastStatus: "failed" as const, lastResult: "failed text", lastRunAt: "2026-10-12T00:00:00.000Z" };
  assert.equal(presentJob(failed).status, "failed");
  const disabled = presentJob({ ...failed, enabled: false });
  assert.equal(disabled.status, "failed");
  assert.equal(disabled.error, "Last run failed");
  assert.equal(disabled.result, "failed text");
  assert.equal(disabled.updatedAt, failed.lastRunAt);
  assert.equal(disabled.nextRunAt, undefined);
  assert.equal(presentJob({ ...job, lastStatus: "completed" }).status, "scheduled");
});

test("OpenMuse task status distinguishes scheduling from execution for every supported combination", () => {
  // 穷举调度开关、任务类型和最近执行状态，防止把自动停用的一次性任务误当成用户取消。
  const cases = [
    [true, false, undefined, "scheduled"],
    [true, false, "completed", "scheduled"],
    [true, false, "failed", "failed"],
    [true, true, undefined, "scheduled"],
    [true, true, "completed", "scheduled"],
    [true, true, "failed", "failed"],
    [false, false, undefined, "cancelled"],
    [false, false, "completed", "succeeded"],
    [false, false, "failed", "failed"],
    [false, true, undefined, "cancelled"],
    [false, true, "completed", "cancelled"],
    [false, true, "failed", "cancelled"],
  ] as const;
  cases.forEach(([enabled, daily, lastStatus, expected]) => {
    const source: Job = { ...job, enabled, daily, lastStatus };
    const before = structuredClone(source);
    const presented = presentJob(source);
    assert.equal(presented.status, expected, JSON.stringify({ enabled, daily, lastStatus }));
    assert.equal(presented.nextRunAt, enabled ? job.nextRunAt : undefined);
    assert.deepEqual(source, before);
  });
});

test("OpenMuse cancelled daily tasks retain historical success and failure metadata", () => {
  // cancelled 仅描述后续调度已取消，不能抹掉每日任务之前的执行结果或失败提示。
  (["completed", "failed"] as const).forEach((lastStatus) => {
    const source: Job = {
      ...job, daily: true, enabled: false, lastStatus,
      lastResult: "historical result", lastRunAt: "2026-10-12T00:00:00.000Z",
    };
    const presented = presentJob(source);
    assert.equal(presented.status, "cancelled");
    assert.equal(presented.result, source.lastResult);
    assert.equal(presented.updatedAt, source.lastRunAt);
    assert.equal(presented.error, lastStatus === "failed" ? "Last run failed" : null);
    assert.equal(presented.nextRunAt, undefined);
  });
});

test("OpenMuse disabled tasks without lastStatus do not infer success from historical metadata", () => {
  // 兼容缺少 lastStatus 的历史数据；时间和结果文本不是执行成功的权威标记。
  [false, true].forEach((daily) => {
    const source: Job = {
      ...job, daily, enabled: false,
      lastResult: "historical result", lastRunAt: "2026-10-12T00:00:00.000Z",
    };
    const presented = presentJob(source);
    assert.equal(presented.status, "cancelled");
    assert.equal(presented.result, source.lastResult);
    assert.equal(presented.updatedAt, source.lastRunAt);
    assert.equal(presented.error, null);
  });
});

test("OpenMuse schemas retain trimming, bounds, optional fields and unknown-field stripping", () => {
  assert.deepEqual(createMemorySchema.parse({ text: " tea ", source: "UI", unknown: "ignored" }), { text: "tea", source: "UI" });
  for (const text of ["  ", "x".repeat(2001)]) {
    assert.equal(createMemorySchema.safeParse({ text }).success, false);
    assert.equal(editMemorySchema.safeParse({ text }).success, false);
  }
  assert.deepEqual(identitySchema.parse({ name: " Tea Bot ", tone: "warm", unknown: "ignored" }), { name: "Tea Bot", tone: "warm" });
  assert.deepEqual(identitySchema.parse({}), {});
  assert.equal(identitySchema.safeParse({ tone: "unknown" }).success, false);
  assert.equal(identitySchema.safeParse({ showChatUpdates: "false" }).success, false);
});

test("AG-UI agent forwards events and signal, completes and does not cancel a settled run", async () => {
  const controller = new AbortController();
  const events: BaseEvent[] = [];
  const cancelled: unknown[] = [];
  const conversation = stubConversation({
    run: async (received, emit, signal) => {
      assert.equal(received, input);
      assert.equal(signal, controller.signal);
      emit({ type: "run_started", threadId: input.threadId, runId: input.runId, assistantId: "assistant-" + input.runId });
      emit({ type: "run_finished", threadId: input.threadId, runId: input.runId });
    },
    cancel: async (...args) => { cancelled.push(args); return true; },
    isRunning: () => false,
  });
  const agent = new PiAgent(hubOf(conversation), controller.signal);
  assert.notEqual(agent.clone(), agent);
  await new Promise<void>((resolve, reject) => agent.run(input).subscribe({
    next: (event) => events.push(event), complete: resolve, error: reject,
  }));
  assert.deepEqual(events.map((event) => event.type), [EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  assert.deepEqual(cancelled, []);
});

test("AG-UI unsubscribe cancels only the request's own run", async () => {
  const cancelled: unknown[] = [];
  const conversation = stubConversation({
    run: () => new Promise<void>(() => {}),
    cancel: async (...args) => { cancelled.push(args); return true; },
    isRunning: () => true,
  });
  const subscription = new PiAgent(hubOf(conversation), new AbortController().signal).run(input).subscribe();
  subscription.unsubscribe();
  // hub.forThread 是异步的；退订后等微任务跑完再断言补偿取消已发出。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelled, [["DISCONNECTED", input.runId]]);
});

test("AG-UI startup rejection exposes only controlled ConversationError or generic text", async () => {
  for (const [error, code, message] of [
    [new ConversationError("BUSY", "Conversation is running"), "BUSY", "Conversation is running"],
    [new Error("secret provider details"), "RUN_ERROR", "Unable to start conversation"],
  ] as const) {
    const conversation = stubConversation({
      run: async () => { throw error; }, cancel: async () => false, isRunning: () => false,
    });
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => new PiAgent(hubOf(conversation), new AbortController().signal).run(input).subscribe({
      next: (event) => events.push(event), complete: resolve, error: reject,
    }));
    assert.deepEqual(events, [{ type: EventType.RUN_ERROR, code, message }]);
  }
});

test("AG-UI runner rejects reconnect and scopes running/stop per thread", async () => {
  let checks = 0;
  let stops = 0;
  const conversation = stubConversation({
    run: async () => {}, isRunning: () => { checks++; return true; },
    cancel: async () => { stops++; return true; },
  });
  const runner = createRunner(hubOf(conversation));
  // hub 按 threadId 定位会话；任意合法 id 都能查询/停止，非法 id 安全返回 false。
  assert.equal(await runner.isRunning({ threadId: "any-thread" }), true);
  assert.equal(await runner.stop({ threadId: "any-thread" }), true);
  assert.equal(checks, 1);
  assert.equal(stops, 1);
  assert.equal(await runner.isRunning({ threadId: "../evil" }), false);
  assert.equal(await runner.stop({ threadId: "../evil" }), false);
  assert.equal(checks, 1);
  assert.equal(stops, 1);
  assert.deepEqual(await firstValueFrom(runner.connect()), {
    type: EventType.RUN_ERROR, code: "UNSUPPORTED",
    message: "Reconnect is not supported; reload completed history",
  });
});
