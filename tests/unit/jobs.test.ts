import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { nextRunAfter } from "../../src/features/jobs/schedule-calculator.js";
import type { Job } from "../../src/features/jobs/types.js";

const tempFile = async (t: { after: (cleanup: () => Promise<void>) => void }) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "jobs.json");
};

const baseJob = (id: string): Job => ({
  id,
  prompt: "legacy prompt",
  daily: false,
  at: "2030-01-01T00:00:00.000Z",
  enabled: true,
  createdAt: "2029-01-01T00:00:00.000Z",
  nextRunAt: "2030-01-01T00:00:00.000Z",
});

test("nextRunAfter keeps one-time and daily scheduling semantics", () => {
  // 每日日程基于本地时区；测试不预设运行环境为 UTC。
  const after = new Date(2030, 0, 1, 10, 30);
  assert.equal(
    nextRunAfter(false, "2030-01-02T00:00:00.000Z", after),
    "2030-01-02T00:00:00.000Z",
  );
  assert.equal(
    nextRunAfter(true, "10:30", after),
    new Date(2030, 0, 2, 10, 30).toISOString(),
  );
  assert.equal(
    nextRunAfter(true, "10:31", after),
    new Date(2030, 0, 1, 10, 31).toISOString(),
  );
  assert.equal(
    nextRunAfter(true, "10:29", after),
    new Date(2030, 0, 2, 10, 29).toISOString(),
  );
  // 一次性时间不受 after 限制，且纯函数不得改变传入的 Date。
  assert.equal(
    nextRunAfter(false, "2029-01-01T00:00:00.000Z", after),
    "2029-01-01T00:00:00.000Z",
  );
  assert.equal(after.getTime(), new Date(2030, 0, 1, 10, 30).getTime());
});

test("reconcileOnStart follows nanobot restart semantics", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  const now = new Date(2030, 0, 5, 10, 30);
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const daily: Job = {
    ...baseJob("daily"),
    daily: true,
    at: "10:30",
    nextRunAt: new Date(0).toISOString(),
  };
  const expired: Job = { ...baseJob("expired"), at: now.toISOString(), nextRunAt: now.toISOString() };
  const future: Job = {
    ...baseJob("future"),
    at: new Date(Date.now() + 60_000).toISOString(),
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const staleFuture = { ...future, id: "stale-future", nextRunAt: new Date(0).toISOString() };
  const disabled = { ...daily, id: "cancelled", enabled: false };
  const completed = { ...expired, id: "completed", enabled: false, lastStatus: "completed" as const };
  await createJobRepository(file).update(() => ({
    items: [daily, expired, future, staleFuture, disabled, completed], result: undefined,
  }));
  await service.reconcileOnStart();
  const jobs = await service.list();
  assert.deepEqual(jobs, [
    { ...daily, nextRunAt: new Date(2030, 0, 6, 10, 30).toISOString() },
    { ...expired, enabled: false },
    future,
    { ...staleFuture, nextRunAt: future.at },
    disabled,
    completed,
  ]);
});

test("reconcileOnStart does not create a missing file or rewrite unchanged data", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2029, 0, 1).getTime() });
  await service.reconcileOnStart();
  await assert.rejects(stat(file), { code: "ENOENT" });
  const source = JSON.stringify([baseJob("future")], null, 2) + "\n";
  await writeFile(file, source);
  await service.reconcileOnStart();
  assert.equal(await readFile(file, "utf8"), source);
});

test("reconcileOnStart rejects damaged jobs without replacing the original file", async (t) => {
  const file = await tempFile(t);
  await writeFile(file, "broken original");
  await assert.rejects(createJobService(createJobRepository(file)).reconcileOnStart());
  assert.equal(await readFile(file, "utf8"), "broken original");
});

test("nextRunAfter preserves invalid input fallback and Date errors", () => {
  const after = new Date(2030, 0, 1, 10, 30);
  assert.equal(
    nextRunAfter(true, "invalid", after),
    new Date(2030, 0, 2).toISOString(),
  );
  assert.equal(
    nextRunAfter(true, "25:75", after),
    new Date(2030, 0, 2, 2, 15).toISOString(),
  );
  assert.throws(() => nextRunAfter(false, "invalid", after), RangeError);
  assert.throws(() => nextRunAfter(true, "Infinity:00", after), RangeError);
});

test("repository rejects bad job entries instead of filtering and preserves original bytes", async (t) => {
  const file = await tempFile(t);
  const repository = createJobRepository(file);
  for (const invalid of [
    { id: "minimal", prompt: "" }, { id: "missing-prompt" },
    { ...baseJob("bad"), daily: "yes" }, { ...baseJob("bad"), nextRunAt: "invalid" }, null,
  ]) {
    const source = JSON.stringify([baseJob("valid"), invalid]);
    await writeFile(file, source);
    await assert.rejects(repository.read(), /Invalid jobs document/);
    await assert.rejects(repository.update(() => ({ items: [], result: undefined })), /Invalid jobs document/);
    assert.equal(await readFile(file, "utf8"), source);
  }
});

test("add trims prompt and writes a 0600 JSON file", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));

  const job = await service.add("  hello  ", false, "2030-01-01T00:00:00.000Z");
  assert.equal(job.prompt, "hello");
  assert.equal(job.enabled, true);
  assert.equal(job.daily, false);
  assert.equal(job.nextRunAt, job.at);
  assert.deepEqual(await service.list(), [job]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("markRun advances daily jobs, closes one-time jobs, and truncates results", async (t) => {
  const created = new Date(2030, 0, 1, 10, 30);
  t.mock.timers.enable({ apis: ["Date"], now: created.getTime() });
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  const daily = await service.add("daily", true, "23:59");
  const once = await service.add("once", false, "2030-01-01T00:00:00.000Z");
  const result = "x".repeat(2001);

  // 推进到原计划之后再结束任务，验证下一轮按结束时间而非旧 nextRunAt 计算。
  const reference = new Date(2030, 0, 2, 23, 59);
  t.mock.timers.setTime(reference.getTime());
  const dailyRun = await service.markRun(daily.id, "completed", result);
  const onceRun = await service.markRun(once.id, "failed", result);
  assert.equal(dailyRun?.lastResult?.length, 2000);
  assert.equal(dailyRun?.enabled, true);
  assert.equal(dailyRun?.lastStatus, "completed");
  assert.equal(dailyRun?.lastRunAt, reference.toISOString());
  assert.equal(dailyRun?.nextRunAt, nextRunAfter(true, daily.at, reference));
  assert.notEqual(dailyRun?.nextRunAt, daily.nextRunAt);
  assert.equal(onceRun?.lastResult?.length, 2000);
  assert.equal(onceRun?.enabled, false);
  assert.equal(onceRun?.lastStatus, "failed");
  assert.equal(onceRun?.lastRunAt, reference.toISOString());
  assert.equal(onceRun?.nextRunAt, once.nextRunAt);
  assert.equal(onceRun?.lastResult, result.slice(0, 2000));
  assert.deepEqual(await service.list(), [dailyRun, onceRun]);
  // 失败的每日任务仍推进下一轮；取消后 markRun 不重新启用它。
  await service.cancel(daily.id);
  const failedDaily = await service.markRun(daily.id, "failed", "short");
  assert.equal(failedDaily?.enabled, false);
  assert.equal(failedDaily?.lastStatus, "failed");
  assert.equal(failedDaily?.lastResult, "short");
  assert.equal(failedDaily?.nextRunAt, nextRunAfter(true, daily.at, reference));
});

test("markRun uses the supplied completion time even when saving on a later day", async (t) => {
  const completedAt = new Date(2030, 0, 1, 10, 31);
  t.mock.timers.enable({ apis: ["Date"], now: completedAt.getTime() });
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  const daily = await service.add("daily", true, "10:30");
  const once = await service.add("once", false, "2030-01-01T00:00:00.000Z");

  // 跨日补写必须沿用实际结束时刻，不能把 lastRunAt 或下一轮推到存储恢复日。
  t.mock.timers.setTime(new Date(2030, 0, 5, 12).getTime());
  const dailyRun = await service.markRun(daily.id, "completed", "daily done", completedAt);
  const onceRun = await service.markRun(once.id, "failed", "once failed", completedAt);
  assert.equal(dailyRun?.lastRunAt, completedAt.toISOString());
  assert.equal(dailyRun?.nextRunAt, new Date(2030, 0, 2, 10, 30).toISOString());
  assert.equal(dailyRun?.enabled, true);
  assert.equal(onceRun?.lastRunAt, completedAt.toISOString());
  assert.equal(onceRun?.nextRunAt, once.nextRunAt);
  assert.equal(onceRun?.enabled, false);
  assert.equal(completedAt.getTime(), new Date(2030, 0, 1, 10, 31).getTime());
  assert.deepEqual(await service.list(), [dailyRun, onceRun]);
});

test("markRun retry keeps a daily job cancelled after its first save failed", async (t) => {
  const completedAt = new Date(2030, 0, 1, 10, 31);
  t.mock.timers.enable({ apis: ["Date"], now: completedAt.getTime() });
  const file = await tempFile(t);
  const repository = createJobRepository(file);
  const service = createJobService(repository);
  const daily = await service.add("cancel during retry", true, "10:30");
  const before = await readFile(file, "utf8");
  const failedUpdate = t.mock.method(repository, "update", async () => {
    throw new Error("test save failure");
  });
  await assert.rejects(service.markRun(daily.id, "completed", "original result", completedAt));
  failedUpdate.mock.restore();
  assert.equal(await readFile(file, "utf8"), before);

  // 模型已经结束但结果尚未保存时，取消仍通过同一 repository 生效。
  // 补写只重算运行字段，不能拿执行前快照覆盖 enabled，也不能更改完成时间。
  assert.equal(await service.cancel(daily.id), true);
  t.mock.timers.setTime(new Date(2030, 0, 5, 12).getTime());
  const retried = await service.markRun(daily.id, "completed", "original result", completedAt);
  assert.equal(retried?.enabled, false);
  assert.equal(retried?.lastStatus, "completed");
  assert.equal(retried?.lastResult, "original result");
  assert.equal(retried?.lastRunAt, completedAt.toISOString());
  assert.equal(retried?.nextRunAt, new Date(2030, 0, 2, 10, 30).toISOString());
  assert.deepEqual(await service.list(), [retried]);
});

test("cancel disables an existing job", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  const job = await service.add("cancel me", false, "2030-01-01T00:00:00.000Z");

  assert.equal(await service.cancel(job.id), true);
  const cancelled = await service.get(job.id);
  assert.equal(cancelled?.lastControl?.action, "cancel");
  assert.ok(Number.isFinite(Date.parse(cancelled!.lastControl!.at)));
  assert.deepEqual(await service.list(), [{ ...job, enabled: false, controlState: "cancelled", lastControl: cancelled!.lastControl }]);
  assert.equal(job.enabled, true);
  assert.equal(await service.cancel(job.id), true);
});

test("cancel and markRun change only the first job with a duplicate id", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));
  const first = baseJob("duplicate");
  const second = { ...first, prompt: "second duplicate" };
  await writeFile(file, JSON.stringify([first, second]));

  assert.equal(await service.cancel(first.id), true);
  const cancelledFirst = await service.get(first.id);
  assert.deepEqual(await service.list(), [{ ...first, enabled: false, controlState: "cancelled", lastControl: cancelledFirst!.lastControl }, second]);
  const run = await service.markRun(first.id, "completed", "first only");
  assert.equal(run?.lastResult, "first only");
  assert.deepEqual(await service.list(), [run, second]);
});

test("concurrent updates are serialized without losing jobs", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));

  const jobs = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.add(`job-${index}`, false, "2030-01-01T00:00:00.000Z"),
    ),
  );
  assert.equal(jobs.length, 20);
  assert.deepEqual(await service.list(), jobs);
  // add/cancel/markRun 必须共用完整读改写队列，混合并发也不能覆盖其他结果。
  const [cancelled, marked, added] = await Promise.all([
    service.cancel(jobs[0].id),
    service.markRun(jobs[1].id, "completed", "done"),
    service.add("last", false, "2030-01-01T00:00:00.000Z"),
  ]);
  assert.equal(cancelled, true);
  const stored = await service.list();
  assert.equal(stored[0].lastControl?.action, "cancel");
  assert.deepEqual(stored, [
    { ...jobs[0], enabled: false, controlState: "cancelled", lastControl: stored[0].lastControl }, marked, ...jobs.slice(2), added,
  ]);
});

test("missing cancel and markRun do not create or rewrite the file", async (t) => {
  const file = await tempFile(t);
  const service = createJobService(createJobRepository(file));

  assert.equal(await service.cancel("missing"), false);
  assert.equal(await service.markRun("missing", "failed", "ignored"), undefined);
  assert.deepEqual(await readdir(dirname(file)), []);

  // 使用与 repository 写入格式不同的文本，并同时核对写入时间，捕获无意义重写。
  await writeFile(file, JSON.stringify([baseJob("existing")]));
  const before = await readFile(file, "utf8");
  const beforeStat = await stat(file, { bigint: true });
  assert.equal(await service.cancel("missing"), false);
  assert.equal(await service.markRun("missing", "completed", "ignored"), undefined);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await stat(file, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
});

test("repository writes returned empty arrays and recovers after a failed update", async (t) => {
  const file = await tempFile(t);
  const repository = createJobRepository(file);
  await assert.rejects(repository.update(() => { throw new Error("change failed"); }));
  assert.equal(await repository.update(() => ({ items: [], result: "cleared" })), "cleared");
  assert.equal(await readFile(file, "utf8"), "[]\n");
});
