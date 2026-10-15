import assert from "node:assert/strict";
import { test } from "node:test";
import { presentJob } from "../../src/http/job-presenters.js";
import { createMemorySchema, editMemorySchema, identitySchema } from "../../src/http/contracts/rest.js";
import type { Job } from "../../src/features/jobs/types.js";

const job: Job = {
  id: "job-id", prompt: "x".repeat(100), daily: false,
  at: "2030-01-01T00:00:00.000Z", enabled: true,
  createdAt: "2026-10-11T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
};

test("task presenter exposes only recorded business facts without mutating the job", () => {
  const before = structuredClone(job);
  assert.deepEqual(presentJob(job), {
    id: job.id, title: "x".repeat(80), prompt: job.prompt, kind: "job",
    status: "scheduled",
    createdAt: job.createdAt, updatedAt: job.createdAt, nextRunAt: job.nextRunAt,
    result: undefined, error: null,
  });
  assert.deepEqual(job, before);
  assert.ok(!Object.hasOwn(JSON.parse(JSON.stringify(presentJob(job))), "result"));
});

test("one-shot task preserves failed status and result metadata after being disabled", () => {
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

test("task status distinguishes scheduling from execution for every supported combination", () => {
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

test("cancelled daily tasks retain historical success and failure metadata", () => {
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

test("disabled tasks without lastStatus do not infer success from historical metadata", () => {
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

test("schemas retain trimming, bounds, optional fields and unknown-field stripping", () => {
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
