import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createService } from "../../src/bootstrap/create-service.js";
import { createHttpApp } from "../../src/http/app.js";
import { createScheduler } from "../../src/features/jobs/scheduler.js";
import type { Conversation } from "../../src/features/conversation/conversation-service.js";
import type { Job } from "../../src/features/jobs/types.js";
import type { JobService } from "../../src/features/jobs/job-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";

// tick 内含文件/会话的异步边界；推进假时钟后让 Promise 队列完整结算，避免依赖真实延时。
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};
const dueJob = (id = "test-job"): Job => ({
  id,
  prompt: "test reminder",
  daily: false,
  at: new Date(0).toISOString(),
  enabled: true,
  createdAt: new Date(0).toISOString(),
  nextRunAt: new Date(0).toISOString(),
  originThreadId: "local-main",
});
const schedulerConfig = createConfig({ runtime: { schedulerIntervalMs: 10 } });
// 调度器只需三个方法；生产会话仍由组合入口创建，不为测试另造执行内核。
const schedulerFor = (
  jobs: Pick<JobService, "list" | "markRun">,
  conversation: Pick<Conversation, "isRunning" | "trigger">,
) => createScheduler(schedulerConfig, jobs, conversation);

test("DataLayout describes the current paths without migrating legacy data", () => {
  const root = resolve(".personal-bot-test");
  assert.deepEqual(createDataLayout("./.personal-bot-test"), {
    root,
    workspaceDir: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    agentDir: join(root, "agent"),
    piAuthFile: join(root, "agent", "auth.json"),
    memoryFile: join(root, "memory.json"),
    jobsFile: join(root, "jobs.json"),
    goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"),
    monitorsFile: join(root, "monitors.json"),
    soulFile: join(root, "SOUL.md"),
    userFile: join(root, "USER.md"),
    dreamFile: join(root, "DREAM.md"),
    authKeyFile: join(root, "auth.key"),
    skillsDir: join(root, "skills"),
    subagentsDir: join(root, "subagents"),
  });
});

test("scheduler starts explicitly once, skips busy conversation and closes permanently", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let busy = true;
  let scans = 0;
  let triggers = 0;
  const job = dueJob();
  const scheduler = schedulerFor({
    list: async () => { scans++; return [job]; },
    markRun: async (id, status, text) => {
      assert.equal(id, job.id);
      assert.equal(status, "completed");
      assert.equal(text, "result");
      job.enabled = false;
      return job;
    },
  }, {
    isRunning: () => busy,
    trigger: async (text, runId) => {
      triggers++;
      assert.equal(text, "⏰ [定时任务] test reminder");
      assert.match(runId, /^job-test-job-\d+$/);
      return { status: "completed", text: "result" };
    },
  });
  t.after(() => scheduler.close());
  t.mock.timers.tick(10);
  await flush();
  assert.equal(scans, 0);
  scheduler.start();
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(scans, 0);
  busy = false;
  t.mock.timers.tick(10);
  await flush();
  assert.equal(scans, 2, "one scan plus one pre-dispatch recheck; no duplicate interval");
  assert.equal(triggers, 1);
  t.mock.timers.tick(10);
  await flush();
  assert.equal(scans, 3);
  assert.equal(triggers, 1, "disabled one-time job must not run again");
  const closed = scheduler.close();
  assert.equal(scheduler.close(), closed);
  await closed;
  scheduler.start();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(scans, 3);
});

test("scheduler close waits for a pending scan but never dispatches it after stopping", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const scan = deferred();
  let triggers = 0;
  const scheduler = schedulerFor({
    list: async () => { await scan.promise; return [dueJob()]; },
    markRun: async () => undefined,
  }, {
    isRunning: () => false,
    trigger: async () => { triggers++; return { status: "completed", text: "" }; },
  });
  t.after(async () => { scan.finish(); await scheduler.close(); });
  scheduler.start();
  t.mock.timers.tick(10);
  let settled = false;
  const closed = scheduler.close().then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  scan.finish();
  await closed;
  assert.equal(triggers, 0);
});

test("scheduler close drains the current trigger and markRun, without starting the next job", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const turn = deferred();
  const write = deferred();
  let triggers = 0;
  let marked = false;
  const scheduler = schedulerFor({
    list: async () => [dueJob("first"), dueJob("second")],
    markRun: async (id, status) => {
      assert.equal(id, "first");
      assert.equal(status, "failed");
      marked = true;
      await write.promise;
      return undefined;
    },
  }, {
    isRunning: () => false,
    trigger: async () => {
      triggers++;
      await turn.promise;
      return { status: "failed", text: "" };
    },
  });
  t.after(async () => { turn.finish(); write.finish(); await scheduler.close(); });
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(triggers, 1);
  let settled = false;
  const closed = scheduler.close().then(() => { settled = true; });
  turn.finish();
  await flush();
  assert.equal(marked, true);
  assert.equal(settled, false, "close must wait for the status write too");
  write.finish();
  await closed;
  assert.equal(triggers, 1);
});

test("a failed scheduler scan does not stop the next tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let scans = 0;
  const scheduler = schedulerFor({
    list: async () => { if (++scans === 1) throw new Error("test failure"); return []; },
    markRun: async () => undefined,
  }, {
    isRunning: () => false,
    trigger: async () => ({ status: "completed", text: "" }),
  });
  t.after(() => scheduler.close());
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(scans, 2);
});

test("scheduler does not duplicate a job while its status write is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const write = deferred();
  const job = dueJob("same-job");
  let triggers = 0;
  const scheduler = schedulerFor({
    list: async () => [job],
    markRun: async () => {
      await write.promise;
      job.enabled = false;
      return job;
    },
  }, {
    isRunning: () => false,
    trigger: async () => {
      triggers++;
      return { status: "completed", text: "done" };
    },
  });
  t.after(async () => { write.finish(); await scheduler.close(); });
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  t.mock.timers.tick(30);
  await flush();
  assert.equal(triggers, 1);
  write.finish();
  await scheduler.close();
});

for (const status of ["completed", "failed"] as const) {
  test(`scheduler retries saving a ${status} outcome without rerunning or scanning other jobs`, async (t) => {
    const startedAt = new Date(2030, 0, 1, 8).getTime();
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: startedAt });
    let jobs = [dueJob("first"), dueJob("second")];
    let scans = 0;
    let busy = false;
    let attempts = 0;
    const triggered: string[] = [];
    const savedTimes: string[] = [];
    const scheduler = schedulerFor({
      list: async () => { scans++; return jobs; },
      markRun: async (id, savedStatus, text, completedAt) => {
        if (id === "first") {
          attempts++;
          assert.equal(savedStatus, status);
          assert.equal(text, "original result");
          assert.ok(completedAt);
          savedTimes.push(completedAt.toISOString());
          // 初次保存与后续两轮补写均失败，验证失败之间不会重新扫描/调用模型。
          if (attempts <= 3) throw new Error("test save failure");
        }
        const current = jobs.find((job) => job.id === id)!;
        const updated = { ...current, enabled: false };
        jobs = jobs.map((job) => job === current ? updated : job);
        return updated;
      },
    }, {
      isRunning: () => busy,
      trigger: async (_text, runId) => {
        triggered.push(runId.includes("first") ? "first" : "second");
        return { status, text: "original result" };
      },
    });
    t.after(() => scheduler.close());
    scheduler.start();
    t.mock.timers.tick(10);
    await flush();
    const completedAt = new Date(startedAt + 10).toISOString();
    assert.equal(attempts, 1);
    assert.equal(scans, 2);
    assert.deepEqual(triggered, ["first"]);

    // 客户端会话忙也只影响模型派发，不阻挡既有执行结果的补写。
    busy = true;
    for (let attempt = 2; attempt <= 4; attempt++) {
      t.mock.timers.tick(10);
      await flush();
      assert.equal(attempts, attempt);
      assert.equal(scans, 2, "dirty outcome must be saved before any scan");
      assert.deepEqual(triggered, ["first"]);
      assert.deepEqual(savedTimes, Array(attempt).fill(completedAt));
    }
    assert.equal(jobs[0].enabled, false);
    assert.equal(jobs[1].enabled, true);

    // 成功补写的 tick 也不派发：下一次固定扫描恢复原候选重读与执行规则。
    busy = false;
    t.mock.timers.tick(10);
    await flush();
    assert.equal(scans, 4);
    assert.deepEqual(triggered, ["first", "second"]);
    assert.equal(attempts, 4, "saved first outcome must not be executed again");
  });
}

for (const phase of ["initial write", "retry write"] as const) {
  test(`scheduler close waits for a failing ${phase} without retrying forever`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const write = deferred();
    let attempts = 0;
    let scans = 0;
    let triggers = 0;
    const scheduler = schedulerFor({
      list: async () => { scans++; return [dueJob("first"), dueJob("second")]; },
      markRun: async () => {
        attempts++;
        if (phase === "retry write" && attempts === 1) throw new Error("test initial failure");
        await write.promise;
        throw new Error("test save failure during close");
      },
    }, {
      isRunning: () => false,
      trigger: async () => { triggers++; return { status: "completed", text: "done" }; },
    });
    t.after(async () => { write.finish(); await scheduler.close(); });
    scheduler.start();
    t.mock.timers.tick(10);
    await flush();
    if (phase === "retry write") {
      t.mock.timers.tick(10);
      await flush();
    }
    const expectedAttempts = phase === "initial write" ? 1 : 2;
    assert.equal(attempts, expectedAttempts);
    let settled = false;
    const closing = scheduler.close();
    assert.equal(scheduler.close(), closing);
    void closing.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false, "close must drain the already started save");
    // 不用真实延时：手动释放失败写入，确认 close 结束而不发起任何额外补写。
    write.finish();
    await flush();
    assert.equal(settled, true, "a failed save must not keep close alive");
    await closing;
    scheduler.start();
    t.mock.timers.tick(100);
    await flush();
    assert.equal(attempts, expectedAttempts);
    assert.equal(scans, 2);
    assert.equal(triggers, 1);
  });
}

test("scheduler keeps one scan in flight while storage reads are pending", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const read = deferred();
  const job = dueJob("slow-read");
  let scans = 0;
  let triggers = 0;
  const scheduler = schedulerFor({
    list: async () => { scans++; await read.promise; return [job]; },
    markRun: async () => { job.enabled = false; return job; },
  }, {
    isRunning: () => false,
    trigger: async () => { triggers++; return { status: "completed", text: "done" }; },
  });
  t.after(async () => { read.finish(); await scheduler.close(); });
  scheduler.start();
  t.mock.timers.tick(40);
  await flush();
  assert.equal(scans, 1);
  assert.equal(triggers, 0);
  read.finish();
  await flush();
  assert.equal(triggers, 1);
  await scheduler.close();
});

for (const change of ["close", "client run"] as const) {
  test(`scheduler does not dispatch after ${change} during its pre-dispatch read`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const recheck = deferred();
    let scans = 0;
    let triggers = 0;
    let busy = false;
    const scheduler = schedulerFor({
      list: async () => {
        if (++scans === 2) await recheck.promise;
        return [dueJob()];
      },
      markRun: async () => { assert.fail("unstarted job must not be marked"); },
    }, {
      isRunning: () => busy,
      trigger: async () => { triggers++; return { status: "completed", text: "done" }; },
    });
    t.after(async () => { recheck.finish(); await scheduler.close(); });
    scheduler.start();
    t.mock.timers.tick(10);
    await flush();
    assert.equal(scans, 2);
    const closing = change === "close" ? scheduler.close() : undefined;
    busy = change === "client run";
    recheck.finish();
    await flush();
    assert.equal(triggers, 0);
    await (closing ?? scheduler.close());
  });
}

test("scheduler rechecks a job before dispatching an old due snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const first = { ...dueJob("first"), prompt: "first" };
  const second = { ...dueJob("second"), prompt: "second" };
  let jobs = [first, second];
  const calls: string[] = [];
  const scheduler = schedulerFor({
    list: async () => jobs,
    markRun: async (id) => {
      const job = jobs.find((item) => item.id === id)!;
      jobs = jobs.map((item) => item === job ? { ...item, enabled: false } : item);
      return job;
    },
  }, {
    isRunning: () => false,
    trigger: async (text) => {
      calls.push(text.endsWith("first") ? "first" : "second");
      // 真实 repository 返回新对象；保留旧扫描快照才能验证重新读取的必要性。
      if (text.endsWith("first")) jobs = jobs.map((job) =>
        job.id === second.id ? { ...job, enabled: false } : job,
      );
      return { status: "completed", text: "done" };
    },
  });
  t.after(() => scheduler.close());
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  assert.deepEqual(calls, ["first"]);
  await scheduler.close();
});

test("scheduler leaves a busy job due instead of consuming it as a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const job = dueJob("busy-job");
  let attempts = 0;
  let marked = 0;
  const scheduler = schedulerFor({
    list: async () => [job],
    markRun: async () => { marked++; return job; },
  }, {
    isRunning: () => false,
    trigger: async () => {
      attempts++;
      return attempts === 1
        ? { status: "failed", text: "busy" }
        : { status: "completed", text: "done" };
    },
  });
  t.after(() => scheduler.close());
  scheduler.start();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(marked, 0);
  t.mock.timers.tick(10);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(marked, 1);
});

test("HTTP construction does not own or implicitly restart the scheduler", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-http-boundary-"));
  const service = await createService(createConfig({ runtime: { dataDir } }));
  t.after(async () => {
    try { await service.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  // 两个调度器都要在 mock timers 激活前真实关闭；否则 close 时的
  // clearInterval 被 mock 拦截，真实 interval 泄漏挂起进程。
  await service.scheduler.close();
  await service.monitorScheduler.close();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const scans = t.mock.method(service.jobs, "list");
  const main = await service.conversationHub.forThread("local-main");
  const triggers = t.mock.method(main, "trigger");
  const app = await createHttpApp(service);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(scans.mock.callCount(), 0);
  assert.equal(triggers.mock.callCount(), 0);
  const response = await app.request("/api/health");
  assert.equal(response.status, 200);
});

test("HTTP and pi tools use the same composed stores; conversation exposes no stores", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-composition-"));
  const model = await createFakeModel();
  const service = await createService(createConfig({
    model: { baseUrl: model.baseUrl, id: "test-model" },
    runtime: { dataDir },
  }));
  t.after(async () => {
    try { await service.close(); }
    finally {
      try { await model.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const main = await service.conversationHub.forThread("local-main");
  assert.equal("memory" in main, false);
  assert.equal("jobs" in main, false);
  const memoryWrites = t.mock.method(service.memory, "add");
  const jobWrites = t.mock.method(service.jobs, "add");
  const headers = {
    Authorization: `Bearer ${service.auth.login()}`,
    "Content-Type": "application/json",
  };
  assert.equal((await service.app.request("/api/agent/memories", {
    method: "POST", headers, body: JSON.stringify({ text: "UI memory" }),
  })).status, 200);
  assert.equal(memoryWrites.mock.callCount(), 1);
  const run = (content: string, id: string) => main.run({
    threadId: "local-main", runId: id,
    expectedRevision: main.snapshot().revision, message: { id, content },
  }, () => {});
  await run("记住我喜欢喝茶", "memory-turn");
  assert.equal(memoryWrites.mock.callCount(), 2, "pi tool must share the UI writer");
  await run("提醒我喝茶", "schedule-turn");
  assert.equal(jobWrites.mock.callCount(), 1);
  const snapshot = await (await service.app.request("/api/agent", { headers })).json();
  assert.equal(snapshot.memories.length, 2);
  assert.equal(snapshot.tasks[0].id, (await service.jobs.list())[0].id);
  const closed = service.close();
  assert.equal(service.close(), closed);
  await closed;
});

test("service close cancels a running scheduled pi turn before draining its status write", {
  timeout: 10_000,
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-close-"));
  const model = await createFakeModel();
  const service = await createService(createConfig({
    model: { baseUrl: model.baseUrl, id: "test-model" },
    runtime: { dataDir, schedulerIntervalMs: 10 },
  }));
  let providerClosed = false;
  const closeProvider = async () => {
    if (providerClosed) return;
    providerClosed = true;
    await model.close();
  };
  // 若关闭顺序退化成“先等 trigger”，先断开测试 provider 作兜底，避免回归使测试进程挂住。
  t.after(async () => {
    try { await closeProvider(); await service.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const main = await service.conversationHub.forThread("local-main");
  const trigger = main.trigger;
  t.mock.method(main, "trigger", (_text: string, id: string) => trigger("freeze", id));
  const job = await service.jobs.add("test close", false, new Date(0).toISOString(), "local-main");
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Condition timed out");
  };
  await waitFor(() => model.requests.length > 0);
  assert.equal(main.isRunning(), true);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await waitFor(() => closed);
  await closing;
  assert.equal(main.isRunning(), false);
  const stored = (await service.jobs.list()).find((item) => item.id === job.id)!;
  assert.equal(stored.lastStatus, "failed");
  assert.equal(stored.enabled, false);
});
