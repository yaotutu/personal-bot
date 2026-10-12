import { randomUUID } from "node:crypto";
import type { JobRepository } from "./ports.js";
import { nextRunAfter } from "./schedule-calculator.js";
import type { Job } from "./types.js";

/**
 * 创建任务领域服务。
 *
 * 领域逻辑通过 repository.update 完成读改写，服务本身不关心持久化介质，
 * 并且用新对象替换任务，避免调用方持有的旧数组或旧任务被就地修改。
 */
export const createJobService = (repository: JobRepository) => ({
  list: (): Promise<Job[]> => repository.read(),

  /**
   * 服务启动时重算仍启用的任务时间。
   *
   * nanobot 不把停机期间错过的 at 任务当成“补发队列”：启动时只保留未来
   * 时间，daily 任务则从当前时刻重新计算下一次执行。我们沿用现有裸数组格式，
   * 只调整任务状态，不引入启动快照、claim 或第二套恢复记录。
   */
  reconcileOnStart: (): Promise<void> =>
    repository.update((jobs) => {
      const now = new Date();
      const updated = jobs.map((job) => {
        if (!job.enabled) return job;
        if (!job.daily && Date.parse(job.at) <= now.getTime()) {
          // 现有模型用 enabled=false 表示一次性任务已结束；这里也用同一
          // 状态表达“启动时发现已过期，不再补跑”，展示层会显示 cancelled。
          return { ...job, enabled: false };
        }
        const nextRunAt = nextRunAfter(job.daily, job.at, now);
        return nextRunAt === job.nextRunAt ? job : { ...job, nextRunAt };
      });
      // 缺失文件或无需调整时保持纯读取，避免每次启动重写业务文件。
      return {
        ...(updated.some((job, index) => job !== jobs[index]) ? { jobs: updated } : {}),
        result: undefined,
      };
    }),

  add: (prompt: string, daily: boolean, at: string): Promise<Job> =>
    repository.update((jobs) => {
      const job: Job = {
        id: randomUUID(),
        prompt: prompt.trim(),
        daily,
        at,
        enabled: true,
        createdAt: new Date().toISOString(),
        nextRunAt: nextRunAfter(daily, at, new Date()),
      };
      return { jobs: [...jobs, job], result: job };
    }),

  cancel: (id: string): Promise<boolean> =>
    repository.update((jobs) => {
      const found = jobs.find((job) => job.id === id);
      if (!found) return { result: false };
      return {
        // 旧文件允许重复 id；沿用 find 的语义，只替换首次命中的对象。
        jobs: jobs.map((job) =>
          job === found ? { ...job, enabled: false } : job,
        ),
        result: true,
      };
    }),

  /**
   * 一次运行结束：daily 推进下一轮；一次性任务关闭。
   * completedAt 默认取调用时刻；scheduler 补写时传回原完成时间，避免存储故障
   * 改写实际执行时间或延后 daily 下一轮。每次仍重读当前任务，保留期间的取消状态。
   */
  markRun: (
    id: string,
    status: "completed" | "failed",
    result: string,
    completedAt: Date = new Date(),
  ): Promise<Job | undefined> =>
    repository.update((jobs) => {
      const job = jobs.find((item) => item.id === id);
      if (!job) return { result: undefined };

      const updated: Job = {
        ...job,
        lastRunAt: completedAt.toISOString(),
        lastStatus: status,
        lastResult: result.slice(0, 2000),
        ...(job.daily
          ? { nextRunAt: nextRunAfter(true, job.at, completedAt) }
          : { enabled: false }),
      };
      return {
        // 按对象身份替换，避免修改旧文件中同 id 的后续任务。
        jobs: jobs.map((item) => (item === job ? updated : item)),
        result: updated,
      };
    }),
});

export type JobService = ReturnType<typeof createJobService>;
