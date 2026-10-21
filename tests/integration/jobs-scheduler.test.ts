import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { createScheduler } from "../../src/features/jobs/scheduler.js";
import type { Conversation } from "../../src/features/conversation/conversation-service.js";

// 这里只替换模型执行端口，任务规则和 JSON 存储都使用真实实现；假时钟用于
// 跨日验证，不修改进程时区、系统时钟或真实 DATA_DIR，也不声称是真实模型验收。
const fixture = async (
  t: TestContext,
  now: Date,
  conversation: Pick<Conversation, "isRunning" | "trigger">,
) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-scheduler-"));
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const file = join(directory, "jobs.json");
  const jobs = createJobService(createJobRepository(file));
  const scheduler = createScheduler({ schedulerIntervalMs: 10 }, jobs, conversation);
  t.after(async () => {
    try { await scheduler.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { jobs, scheduler, file };
};

const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
  // 只模拟 Date，interval 保持真实，避免跨多天跳时触发海量虚拟 tick。
  // 超时也不使用 Date.now()，让真实文件 I/O 和 Promise 队列完成。
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail("scheduler state did not settle");
};

test("deleted job snapshot cannot execute after asynchronous destination resolution", async (t) => {
  let executions = 0;
  const target = { isRunning: () => false, trigger: async () => {
    executions++; return { status: "completed" as const, text: "done" };
  } };
  const { jobs } = await fixture(t, new Date(2030, 0, 1, 10, 30), target);
  await jobs.add("old job", false, new Date(0).toISOString(), "deleted");
  let reached = false;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const scheduler = createScheduler({ schedulerIntervalMs: 10 }, jobs, target, async () => {
    reached = true;
    await gate;
    return target;
  });
  t.after(async () => { resume(); await scheduler.close(); });
  scheduler.start();
  await waitFor(() => reached);
  await jobs.removeByOriginSpaceId("deleted");
  resume();
  await waitFor(() => !scheduler.isBusy());
  await scheduler.close();
  assert.equal(executions, 0);
});

test("daily job crossing midnight advances from completion time", async (t) => {
  let calls = 0;
  const { jobs, scheduler } = await fixture(t, new Date(2030, 0, 1, 23, 58), {
    isRunning: () => false,
    trigger: async () => { calls++; return { status: "completed", text: "done" }; },
  });
  const daily = await jobs.add("midnight", true, "23:59");
  t.mock.timers.setTime(new Date(2030, 0, 2, 0, 1).getTime());
  scheduler.start();
  await waitFor(async () => Boolean((await jobs.list())[0].lastRunAt));
  const [stored] = await jobs.list();
  assert.equal(stored.id, daily.id);
  assert.equal(stored.lastStatus, "completed");
  assert.equal(stored.enabled, true);
  assert.equal(stored.nextRunAt, new Date(2030, 0, 2, 23, 59).toISOString());
  await sleep(40);
  await scheduler.close();
  assert.equal(calls, 1);
});

test("long daily execution skips elapsed schedule times instead of replaying them", async (t) => {
  let calls = 0;
  const { jobs, scheduler } = await fixture(t, new Date(2030, 0, 1, 10, 29), {
    isRunning: () => false,
    trigger: async () => {
      calls++;
      // 任务执行超过两个日程时刻；对齐 nanobot，从结束时刻算未来一轮。
      t.mock.timers.setTime(new Date(2030, 0, 3, 10, 31).getTime());
      return { status: "completed", text: "long task done" };
    },
  });
  await jobs.add("long daily", true, "10:30");
  t.mock.timers.setTime(new Date(2030, 0, 1, 10, 30).getTime());
  scheduler.start();
  await waitFor(async () => Boolean((await jobs.list())[0].lastRunAt));
  const [stored] = await jobs.list();
  assert.equal(stored.lastRunAt, new Date(2030, 0, 3, 10, 31).toISOString());
  assert.equal(stored.nextRunAt, new Date(2030, 0, 4, 10, 30).toISOString());
  await sleep(40);
  await scheduler.close();
  assert.equal(calls, 1);
});

test("multiple due jobs execute serially and one failure does not retry or block later jobs", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // 先注册释放，断言失败时也不能让 scheduler.close 永久等待测试门闩。
  t.after(() => release());
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const { jobs, scheduler } = await fixture(t, new Date(2030, 0, 1, 10, 30), {
    isRunning: () => false,
    trigger: async (prompt) => {
      calls.push(prompt);
      active++;
      maxActive = Math.max(maxActive, active);
      if (prompt.endsWith("first")) await gate;
      active--;
      return prompt.endsWith("first")
        ? { status: "failed", text: "Model request failed" }
        : { status: "completed", text: "done" };
    },
  });
  for (const prompt of ["first", "second", "third"]) {
    await jobs.add(prompt, false, new Date(0).toISOString());
  }
  scheduler.start();
  await waitFor(() => calls.length === 1);
  await sleep(40);
  assert.equal(calls.length, 1, "later ticks cannot overlap the first model execution");
  release();
  await waitFor(async () => (await jobs.list()).every((job) => !job.enabled));
  assert.deepEqual(calls, ["first", "second", "third"].map((prompt) => `⏰ [定时任务] ${prompt}`));
  assert.equal(maxActive, 1);
  assert.deepEqual((await jobs.list()).map((job) => job.lastStatus), ["failed", "completed", "completed"]);
  await sleep(40);
  await scheduler.close();
  assert.equal(calls.length, 3, "completed and failed one-shot jobs are not retried");
});

test("busy conversation spanning days runs an overdue daily job once when the lock is free", async (t) => {
  let busy = true;
  let calls = 0;
  const { jobs, scheduler } = await fixture(t, new Date(2030, 0, 1, 10, 29), {
    isRunning: () => busy,
    trigger: async () => { calls++; return { status: "failed", text: "failed" }; },
  });
  await jobs.add("busy daily", true, "10:30");
  scheduler.start();
  t.mock.timers.setTime(new Date(2030, 0, 5, 10, 31).getTime());
  await sleep(10);
  assert.equal(calls, 0);
  busy = false;
  await waitFor(async () => Boolean((await jobs.list())[0].lastRunAt));
  const [stored] = await jobs.list();
  assert.equal(stored.lastStatus, "failed");
  assert.equal(stored.enabled, true, "failure does not cancel future daily executions");
  assert.equal(stored.nextRunAt, new Date(2030, 0, 6, 10, 30).toISOString());
  await sleep(40);
  await scheduler.close();
  assert.equal(calls, 1);
});

test("restart rereads stored outcomes and schedules only future work", async (t) => {
  let calls = 0;
  const conversation = {
    isRunning: () => false,
    trigger: async () => { calls++; return { status: "completed" as const, text: "done" }; },
  };
  const { jobs, scheduler, file } = await fixture(t, new Date(2030, 0, 1, 10, 29), conversation);
  const daily = await jobs.add("daily", true, "10:30");
  const once = await jobs.add("once", false, new Date(0).toISOString());
  t.mock.timers.setTime(new Date(2030, 0, 1, 10, 31).getTime());
  scheduler.start();
  await waitFor(async () => (await jobs.list()).every((job) => Boolean(job.lastStatus)));
  await scheduler.close();
  await jobs.add("missed while offline", false, new Date(2030, 0, 2, 9).toISOString());
  t.mock.timers.setTime(new Date(2030, 0, 5, 11).getTime());
  const restartedJobs = createJobService(createJobRepository(file));
  await restartedJobs.reconcileOnStart();
  const stored = await restartedJobs.list();
  assert.equal(stored.find((job) => job.id === once.id)?.enabled, false);
  assert.equal(stored.find((job) => job.id === once.id)?.lastStatus, "completed");
  assert.equal(stored.find((job) => job.id === daily.id)?.nextRunAt, new Date(2030, 0, 6, 10, 30).toISOString());
  assert.equal(stored.at(-1)?.enabled, false);
  const restarted = createScheduler({ schedulerIntervalMs: 10 }, restartedJobs, conversation);
  t.after(() => restarted.close());
  restarted.start();
  await sleep(40);
  await restarted.close();
  assert.equal(calls, 2, "restart neither replays completed work nor catches up missed schedules");
});

test("scheduler dispatches to originSpaceId and skips busy origin while letting other threads run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-scheduler-multi-"));
  const file = join(directory, "jobs.json");
  const jobs = createJobService(createJobRepository(file));
  const threadRuns: Record<string, number> = { "thread-a": 0, "thread-b": 0 };
  let threadABusy = true;

  const conversationMap: Record<string, Pick<Conversation, "isRunning" | "trigger">> = {
    "thread-a": {
      isRunning: () => threadABusy,
      trigger: async () => { threadRuns["thread-a"]++; return { status: "completed", text: "done" }; },
    },
    "thread-b": {
      isRunning: () => false,
      trigger: async () => { threadRuns["thread-b"]++; return { status: "completed", text: "done" }; },
    },
  };

  const defaultConv: Pick<Conversation, "isRunning" | "trigger"> = {
    isRunning: () => false,
    trigger: async () => ({ status: "completed", text: "done" }),
  };

  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 },
    jobs,
    defaultConv,
    async (threadId) => conversationMap[threadId] ?? defaultConv,
  );

  t.after(async () => {
    try { await scheduler.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });

  // 添加属于 thread-a 和 thread-b 的即刻到期任务
  const past = new Date(0).toISOString();
  await jobs.add("job for a", false, past, "thread-a");
  await jobs.add("job for b", false, past, "thread-b");

  scheduler.start();

  // thread-b 应该顺利运行并完成，而 thread-a 正在 busy 所以被跳过
  await waitFor(async () => {
    const list = await jobs.list();
    const jobB = list.find((j) => j.originSpaceId === "thread-b");
    return jobB?.lastStatus === "completed";
  });

  assert.equal(threadRuns["thread-b"], 1);
  assert.equal(threadRuns["thread-a"], 0);

  // 解除 thread-a 的 busy
  threadABusy = false;

  // 等待 thread-a 触发并完成
  await waitFor(async () => {
    const list = await jobs.list();
    const jobA = list.find((j) => j.originSpaceId === "thread-a");
    return jobA?.lastStatus === "completed";
  });

  assert.equal(threadRuns["thread-a"], 1);
});
