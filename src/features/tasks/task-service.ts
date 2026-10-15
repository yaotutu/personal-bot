import { randomUUID } from "node:crypto";
import type { Task, TaskRepository } from "./types.js";

export type TaskControlAction = "cancel" | "retry";

/** 异步任务的业务入口：CRUD 与控制；执行由 worker 驱动，不在这里跑模型。 */
export const createTaskService = (repository: TaskRepository) => {
  const now = () => new Date().toISOString();
  return {
    list: (): Promise<Task[]> => repository.read(),
    get: async (id: string): Promise<Task | undefined> =>
      (await repository.read()).find((task) => task.id === id),
    create: (prompt: string, source: Task["source"], title?: string): Promise<Task> =>
      repository.update((items) => {
        const task: Task = {
          id: randomUUID(),
          title: (title ?? prompt).slice(0, 80),
          prompt: prompt.trim(),
          status: "queued",
          source,
          createdAt: now(),
        };
        items.push(task);
        return { items, result: task };
      }),
    /**
     * 控制语义（诚实边界）：
     * cancel——queued/running 均可；running 的实际中止由 worker 的 abort 完成，
     * 这里只落控制意图，避免路由层触碰执行。
     * retry——failed/cancelled 可重试，重置为 queued；succeeded 不可重跑。
     */
    control: (
      id: string,
      action: TaskControlAction,
    ): Promise<
      | { ok: true; task: Task }
      | { ok: false; code: "not_found" | "invalid_state"; message: string }
    > =>
      repository.update(
        (items): {
          items?: Task[];
          result:
            | { ok: true; task: Task }
            | { ok: false; code: "not_found" | "invalid_state"; message: string };
        } => {
        const task = items.find((x) => x.id === id);
        if (!task) return { result: { ok: false, code: "not_found", message: "Task not found" } };
        if (action === "cancel") {
          if (task.status === "succeeded" || task.status === "cancelled")
            return {
              result: {
                ok: false,
                code: "invalid_state",
                message: `Task already ${task.status}`,
              },
            };
          task.status = "cancelled";
          task.finishedAt = now();
        } else {
          if (task.status !== "failed" && task.status !== "cancelled")
            return {
              result: {
                ok: false,
                code: "invalid_state",
                message: "Only failed or cancelled tasks can retry",
              },
            };
          task.status = "queued";
          task.error = undefined;
          task.result = undefined;
          task.finishedAt = undefined;
        }
        return { items, result: { ok: true, task } };
      }),
    /** worker 专用状态迁移；非法迁移保持 no-op 并返回 false。 */
    markRunning: (id: string): Promise<boolean> =>
      repository.update((items) => {
        const task = items.find((x) => x.id === id);
        if (!task || task.status !== "queued") return { result: false };
        task.status = "running";
        task.startedAt = now();
        return { items, result: true };
      }),
    markFinished: (
      id: string,
      status: "succeeded" | "failed",
      output?: string,
    ): Promise<Task | undefined> =>
      repository.update((items) => {
        const task = items.find((x) => x.id === id);
        // 只有 running 状态允许迁移到终态；已被并发 cancel 的任务保持 cancelled。
        if (!task || task.status !== "running") return { result: undefined };
        task.status = status;
        task.finishedAt = now();
        task.result = status === "succeeded" ? output?.slice(0, 4000) : undefined;
        task.error = status === "failed" ? "Task run failed" : undefined;
        return { items, result: task };
      }),
  };
};

export type TaskService = ReturnType<typeof createTaskService>;
