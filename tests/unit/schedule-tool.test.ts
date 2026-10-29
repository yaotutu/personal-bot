import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleTool } from "../../src/adapters/pi/tools/schedule.js";
import type { Job } from "../../src/features/jobs/types.js";

const createJobs = (items: Job[]) => ({
  items,
  add: async (prompt: string, daily: boolean, at: string, originSpaceId = "local-main") => {
    const job: Job = {
      id: "job-full-id",
      prompt,
      daily,
      at,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      originSpaceId,
    };
    items.push(job);
    return job;
  },
  list: async () => items,
  cancel: async (id: string) => {
    const job = items.find((item) => item.id === id);
    if (!job) return false;
    job.enabled = false;
    job.controlState = "cancelled";
    return true;
  },
});

const text = (result: Awaited<ReturnType<ReturnType<typeof scheduleTool>["execute"]>>) =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

test("schedule create returns a full usable ID and defaults to local-main", async () => {
  const jobs = createJobs([]);
  const result = await scheduleTool(jobs).execute(
    "call-create",
    { action: "create", prompt: "main prompt", at: "2032-01-01T09:00:00+08:00" },
    undefined,
    undefined,
    {} as never,
  );

  assert.match(text(result), /Scheduled \(id job-full-id\)/);
  assert.equal(jobs.items[0]?.originSpaceId, "local-main");
});

test("schedule list and cancel are bounded to the current space", async () => {
  const own: Job = {
    id: "own-job-id",
    prompt: "own prompt",
    daily: true,
    at: "09:00",
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    originSpaceId: "space-a",
  };
  const other: Job = {
    id: "other-job-id",
    prompt: "other secret prompt",
    daily: true,
    at: "10:00",
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    originSpaceId: "space-b",
  };
  const jobs = createJobs([own, other]);
  const tool = scheduleTool(jobs, "space-a");

  const list = await tool.execute("call-list", { action: "list", prompt: "-", at: "-" } as never, undefined, undefined, {} as never);
  assert.match(text(list), /own-job-id daily 09:00.*own prompt/);
  assert.doesNotMatch(text(list), /other-job-id|other secret prompt/);

  const denied = await tool.execute("call-other", { action: "cancel", prompt: "-", at: "-", jobId: other.id } as never, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.equal(text(denied), "No such job.");
  assert.equal(other.enabled, true);
  assert.equal(other.controlState, undefined);

  const cancelled = await tool.execute("call-own", { action: "cancel", prompt: "-", at: "-", jobId: own.id } as never, undefined, undefined, {} as never);
  assert.equal(cancelled.isError, undefined);
  assert.equal(text(cancelled), "Cancelled.");
  assert.equal(own.controlState, "cancelled");
});
