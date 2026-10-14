import { randomUUID } from "node:crypto";
import type { JobRepository } from "./ports.js";
import { nextRunAfter } from "./schedule-calculator.js";
import type { Job, JobControlAction, JobControlResult } from "./types.js";

/**
 * 所有控制共用完整的读改写队列，按对象身份仅替换旧文件中首次命中的任务。
 * isBusy 在队列取得最新文档后再检查；它是保守拒绝，不是第二把执行锁或 durable claim。
 */
const controlJob = (
  repository: JobRepository,
  id: string,
  action: JobControlAction,
  isBusy: () => boolean,
): Promise<JobControlResult> => repository.update<JobControlResult>((jobs) => {
  const job = jobs.find((item) => item.id === id);
  if (!job) return { result: { ok: false, code: "not_found", message: "Task not found" } };
  const conflict = (message: string) => ({ result: { ok: false as const, code: "conflict" as const, message } });
  const unchanged = () => ({ result: { ok: true as const, job } });
  if ((action === "resume" || action === "retry") && isBusy())
    return conflict("Wait for the current response and scheduled result to finish before resuming or retrying");
  const now = new Date();
  const at = now.toISOString();
  let updated: Job;
  if (action === "pause") {
    if (job.controlState === "paused" && !job.enabled) return unchanged();
    if (!job.enabled || job.controlState === "cancelled")
      return conflict("Only an active task can be paused");
    updated = { ...job, enabled: false, controlState: "paused", lastControl: { action, at } };
  } else if (action === "resume") {
    if (job.controlState !== "paused") return conflict("Only a paused task can be resumed");
    if (!job.daily && (!Number.isFinite(Date.parse(job.at)) || Date.parse(job.at) <= now.getTime()))
      return conflict("This one-time task has expired. Create a new reminder instead of resuming it");
    updated = {
      ...job, enabled: true, controlState: undefined,
      nextRunAt: nextRunAfter(job.daily, job.at, now), lastControl: { action, at },
    };
  } else if (action === "cancel") {
    if (job.controlState === "cancelled") return unchanged();
    if (!job.daily && job.lastStatus === "completed")
      return conflict("A completed one-time task cannot be cancelled");
    updated = { ...job, enabled: false, controlState: "cancelled", lastControl: { action, at } };
  } else {
    if (job.lastStatus !== "failed" || job.controlState)
      return conflict("Only a failed task without a pending retry can be retried");
    // 用户显式点击才重新安排一次执行。仍交给现有 scheduler/会话锁，不在 HTTP 内跑模型。
    updated = {
      ...job, enabled: true, controlState: "retry_pending",
      nextRunAt: at, lastControl: { action, at },
    };
  }
  return {
    jobs: jobs.map((item) => item === job ? updated : item),
    result: { ok: true, job: updated },
  };
});

/** 领域只知道最小 repository/忙闲 port，不知道文件、OpenMuse DTO 或 pi SDK。 */
export const createJobService = (repository: JobRepository) => ({
  list: (): Promise<Job[]> => repository.read(),
  get: async (id: string): Promise<Job | undefined> =>
    (await repository.read()).find((job) => job.id === id),
  control: (id: string, action: JobControlAction, isBusy: () => boolean = () => false) =>
    controlJob(repository, id, action, isBusy),

  /**
   * 启动时沿 nanobot 语义重算 daily、停用过期 once；没有断点续跑。
   * 用户请求的即时 retry 也不在重启后自动恢复，清除队列展示标记，保留控制记录。
   */
  reconcileOnStart: (): Promise<void> => repository.update((jobs) => {
    const now = new Date();
    const updated = jobs.map((original) => {
      const job = original.controlState === "retry_pending"
        ? { ...original, controlState: undefined } : original;
      if (!job.enabled) return job;
      if (!job.daily && Date.parse(job.at) <= now.getTime()) return { ...job, enabled: false };
      const nextRunAt = nextRunAfter(job.daily, job.at, now);
      return nextRunAt === job.nextRunAt ? job : { ...job, nextRunAt };
    });
    return {
      ...(updated.some((job, index) => job !== jobs[index]) ? { jobs: updated } : {}),
      result: undefined,
    };
  }),

  add: (prompt: string, daily: boolean, at: string): Promise<Job> => repository.update((jobs) => {
    const job: Job = {
      id: randomUUID(), prompt: prompt.trim(), daily, at, enabled: true,
      createdAt: new Date().toISOString(), nextRunAt: nextRunAfter(daily, at, new Date()),
    };
    return { jobs: [...jobs, job], result: job };
  }),

  /** 对话 schedule 与页面 Cancel 复用同一转换；已完成 once 保持原有幂等确认，不改结果。 */
  cancel: async (id: string): Promise<boolean> => {
    const result = await controlJob(repository, id, "cancel", () => false);
    if (result.ok) return true;
    return result.code === "conflict";
  },

  /**
   * 只保存本次结果。补存传回实际完成时间，不重跑模型，也不覆盖期间的 pause/cancel。
   * retry_pending 在本次结果写入时消费；lastControl 保留作为最近控制事实。
   */
  markRun: (
    id: string,
    status: "completed" | "failed",
    result: string,
    completedAt: Date = new Date(),
  ): Promise<Job | undefined> => repository.update((jobs) => {
    const job = jobs.find((item) => item.id === id);
    if (!job) return { result: undefined };
    const updated: Job = {
      ...job,
      lastRunAt: completedAt.toISOString(), lastStatus: status, lastResult: result.slice(0, 2000),
      ...(job.controlState === "retry_pending" ? { controlState: undefined } : {}),
      ...(job.daily ? { nextRunAt: nextRunAfter(true, job.at, completedAt) } : { enabled: false }),
    };
    return { jobs: jobs.map((item) => item === job ? updated : item), result: updated };
  }),
});

export type JobService = ReturnType<typeof createJobService>;
