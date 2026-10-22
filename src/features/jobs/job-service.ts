import { randomUUID } from "node:crypto";
import type { JobRepository } from "./ports.js";
import { assertValidSchedule, nextRunAfter } from "./schedule-calculator.js";
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
): Promise<JobControlResult> => repository.update<JobControlResult>((items) => {
  const job = items.find((item) => item.id === id);
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
    items: items.map((item) => item === job ? updated : item),
    result: { ok: true, job: updated },
  };
});

/** 领域只知道最小 repository/忙闲 port，不知道文件、HTTP DTO 或 pi SDK。 */
export const createJobService = (repository: JobRepository) => ({
  list: (): Promise<Job[]> => repository.read(),
  get: async (id: string): Promise<Job | undefined> =>
    (await repository.read()).find((job) => job.id === id),
  control: (id: string, action: JobControlAction, isBusy: () => boolean = () => false) =>
    controlJob(repository, id, action, isBusy),

  /**
   * 启动时对存量全部任务（无论 enabled 或停用）先做严格排期校验，遇到非法时刻立即拒绝启动，
   * 确保坏记录文件字节原样保留，不静默过滤、不自动禁用、不改写坏条目；
   * 校验通过后再重算 daily 与停用过期 once。没有断点续跑。
   */
  reconcileOnStart: (): Promise<void> => repository.update((items) => {
    // 先严格校验所有存量任务（包含 enabled 与停用），坏条目直接抛错阻止启动
    for (const job of items) {
      assertValidSchedule(job.daily, job.at);
    }
    const now = new Date();
    const updated = items.map((original) => {
      const job = original.controlState === "retry_pending"
        ? { ...original, controlState: undefined } : original;
      if (!job.enabled) return job;
      if (!job.daily && Date.parse(job.at) <= now.getTime()) return { ...job, enabled: false };
      const nextRunAt = nextRunAfter(job.daily, job.at, now);
      return nextRunAt === job.nextRunAt ? job : { ...job, nextRunAt };
    });
    return {
      ...(updated.some((job, index) => job !== items[index]) ? { items: updated } : {}),
      result: undefined,
    };
  }),

  add: (prompt: string, daily: boolean, at: string, originSpaceId: string = "local-main"): Promise<Job> => repository.update((items) => {
    const trimmedPrompt = prompt.trim();
    const trimmedAt = at.trim();
    assertValidSchedule(daily, trimmedAt);
    const job: Job = {
      id: randomUUID(), prompt: trimmedPrompt, daily, at: trimmedAt, enabled: true,
      createdAt: new Date().toISOString(), nextRunAt: nextRunAfter(daily, trimmedAt, new Date()),
      originSpaceId,
    };
    return { items: [...items, job], result: job };
  }),

  /** 对话 schedule 与页面 Cancel 复用同一转换；已完成 once 保持原有幂等确认，不改结果。 */
  cancel: async (id: string): Promise<boolean> => {
    const result = await controlJob(repository, id, "cancel", () => false);
    if (result.ok) return true;
    return result.code === "conflict";
  },

  /** 级联删除属于指定空间的全部定时任务 */
  removeByOriginSpaceId: (originSpaceId: string): Promise<number> => repository.update((items) => {
    const remaining = items.filter((item) => (item.originSpaceId ?? "local-main") !== originSpaceId);
    const count = items.length - remaining.length;
    return { items: remaining, result: count };
  }),

  /** 彻底删除单项定时任务；成功返回 true，不存在返回 false。 */
  remove: (id: string): Promise<boolean> => repository.update((items) => {
    const exists = items.some((item) => item.id === id);
    if (!exists) return { result: false };
    return { items: items.filter((item) => item.id !== id), result: true };
  }),

  /**
   * 修改定时任务的提示词、执行时刻（daily/at）或归属空间。
   * 无论任务是否处于调度中（包含 paused/cancelled 任务），最终合并后的 schedule
   * 必须通过领域排期校验，在 repository 读改写事务内校验防并发绕过；
   * 若设定时刻改变且任务处于调度中（enabled），基于当前时间重算 nextRunAt。
   */
  update: (
    id: string,
    updates: { prompt?: string; daily?: boolean; at?: string; originSpaceId?: string },
  ): Promise<Job | undefined> => repository.update((items) => {
    const job = items.find((item) => item.id === id);
    if (!job) return { result: undefined };
    const prompt = updates.prompt !== undefined ? updates.prompt.trim() : job.prompt;
    const daily = updates.daily !== undefined ? updates.daily : job.daily;
    const at = updates.at !== undefined ? updates.at.trim() : job.at;
    const originSpaceId = updates.originSpaceId !== undefined ? updates.originSpaceId : job.originSpaceId;

    // 校验合并后的排期设定；无论 enabled 与否都拒绝非法排期
    assertValidSchedule(daily, at);

    const timeChanged = daily !== job.daily || at !== job.at;
    const nextRunAt = timeChanged && job.enabled ? nextRunAfter(daily, at, new Date()) : job.nextRunAt;
    const updatedAt = new Date().toISOString();
    const updated: Job = {
      ...job,
      prompt,
      daily,
      at,
      nextRunAt,
      originSpaceId,
      updatedAt,
    };
    return { items: items.map((item) => item === job ? updated : item), result: updated };
  }),

  /**
   * 只保存本次结果。补存传回实际完成时间，不重跑模型，也不覆盖期间的 pause/cancel。
   * retry_pending 在本次结果写入时消费；lastControl 保留作为最近控制事实。
   */
  markRun: (
    id: string,
    status: "completed" | "failed",
    result: string,
    completedAt: Date = new Date(),
  ): Promise<Job | undefined> => repository.update((items) => {
    const job = items.find((item) => item.id === id);
    if (!job) return { result: undefined };
    const updated: Job = {
      ...job,
      lastRunAt: completedAt.toISOString(), lastStatus: status, lastResult: result.slice(0, 2000),
      ...(job.controlState === "retry_pending" ? { controlState: undefined } : {}),
      ...(job.daily ? { nextRunAt: nextRunAfter(true, job.at, completedAt) } : { enabled: false }),
    };
    return { items: items.map((item) => item === job ? updated : item), result: updated };
  }),
});

export type JobService = ReturnType<typeof createJobService>;
