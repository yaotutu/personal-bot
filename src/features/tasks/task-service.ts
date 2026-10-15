import { randomUUID } from "node:crypto";
import type { Task, TaskRepository } from "./types.js";

/** 队列满是可预期的业务拒绝，HTTP 层可按类型映射，不透出存储/模型诊断。 */
export class TaskQueueFullError extends Error {
  constructor() {
    super("Background task queue is full (maximum 32 queued or running tasks)");
    this.name = "TaskQueueFullError";
  }
}

/** 必须在 repository.update 的串行读改写区间检查，防止并发 create/retry 超额。 */
const assertTaskCapacity = (items: Task[]) => {
  if (items.filter((task) => task.status === "queued" || task.status === "running").length >= 32)
    throw new TaskQueueFullError();
};

export type TaskControlAction = "cancel" | "retry";

/** 异步任务的业务入口：CRUD 与控制；执行由 worker 驱动，不在这里跑模型。 */
export const createTaskService = (repository: TaskRepository) => {
  const now = () => new Date().toISOString();
  return {
    list: (): Promise<Task[]> => repository.read(),
    get: async (id: string): Promise<Task | undefined> =>
      (await repository.read()).find((task) => task.id === id),
    create: (prompt: string, source: Task["source"], title?: string, originThreadId?: string): Promise<Task> =>
      repository.update((items) => {
        assertTaskCapacity(items);
        const task: Task = {
          id: randomUUID(),
          title: (title ?? prompt).slice(0, 80),
          prompt: prompt.trim(),
          status: "queued",
          source,
          originThreadId,
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
          assertTaskCapacity(items);
          task.status = "queued";
          task.attemptId = undefined;
          task.startedAt = undefined;
          task.error = undefined;
          task.result = undefined;
          task.finishedAt = undefined;
        }
        return { items, result: { ok: true, task } };
      }),
    /** worker 专用状态迁移；非法迁移保持 no-op 并返回 false。 */
    markRunning: (id: string, attemptId: string = randomUUID()): Promise<boolean> =>
      repository.update((items) => {
        const task = items.find((x) => x.id === id);
        if (!task || task.status !== "queued") return { result: false };
        task.status = "running";
        task.attemptId = attemptId;
        task.startedAt = now();
        return { items, result: true };
      }),
    markFinished: (
      id: string,
      status: "succeeded" | "failed",
      output?: string,
      attemptId?: string,
    ): Promise<Task | undefined> =>
      repository.update((items) => {
        const task = items.find((x) => x.id === id);
        // 只有 running 状态允许迁移到终态；已被并发 cancel 的任务保持 cancelled。
        if (!task || task.status !== "running" || (attemptId !== undefined && task.attemptId !== attemptId)) return { result: undefined };
        task.status = status;
        task.finishedAt = now();
        task.result = status === "succeeded" ? output?.slice(0, 4000) : undefined;
        task.error = status === "failed" ? "Task run failed" : undefined;
        return { items, result: task };
      }),
  };
};

export type TaskService = ReturnType<typeof createTaskService>;
