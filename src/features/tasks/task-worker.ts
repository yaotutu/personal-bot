import { randomUUID } from "node:crypto";
import type { ConversationHub } from "../conversation/conversation-hub.js";
import type { Conversation } from "../conversation/conversation-service.js";
import type { TaskService, TaskControlAction } from "./task-service.js";

export type TaskWorker = {
  kick: () => void;
  control: (id: string, action: TaskControlAction) => ReturnType<TaskService["control"]>;
  cancelByOriginThreadId: (originThreadId: string) => Promise<number>;
  isRunning: () => boolean;
  close: () => Promise<void>;
};

/**
 * 串行 worker 是执行与取消的唯一入口。数据状态迁移仍属于 task service，
 * 每次尝试独占 AbortController 和令牌；取消后立即重试也不会被旧结果覆盖。
 * 通知只是写入来源会话的事实，不再请求模型，主会话忙碌不会丢失结果。
 */
export const createTaskWorker = (
  tasks: Pick<TaskService, "list" | "markRunning" | "markFinished" | "control" | "cancelByOriginThreadId">,
  hub: Pick<ConversationHub, "forThread" | "release" | "hasThread">,
  mainConversation: Pick<Conversation, "notify">,
  timeoutMs = 120_000,
): TaskWorker => {
  let running = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let current: Promise<void> = Promise.resolve();
  let active: { id: string; controller: AbortController } | undefined;

  const runOne = async (taskId: string): Promise<void> => {
    const attemptId = randomUUID();
    const controller = new AbortController();
    active = { id: taskId, controller };
    const threadId = `task-${taskId}`;
    try {
      if (closed || !await tasks.markRunning(taskId, attemptId)) return;
      const task = (await tasks.list()).find((x) => x.id === taskId);
      if (!task || task.status !== "running") return;
      if (controller.signal.aborted || closed) {
        // 正常退出不应遗留 running，启动恢复只用于真正崩溃的旧尝试。
        await tasks.markFinished(taskId, "failed", undefined, attemptId);
        return;
      }
      const thread = await hub.forThread(threadId);
      const outcome = await thread.trigger(task.prompt, `task-${attemptId}`, { signal: controller.signal, timeoutMs });
      const finished = await tasks.markFinished(taskId, outcome.status === "completed" ? "succeeded" : "failed", outcome.text, attemptId);
      if (!finished || closed) return;
      const message = `📋 [任务${finished.status === "succeeded" ? "完成" : "失败"}] ${task.title}` +
        (finished.result ? `\n结果摘要：${finished.result.slice(0, 600)}` : "");
      let destination = mainConversation;
      if (task.originThreadId && task.originThreadId !== "local-main") {
        const exists = await hub.hasThread(task.originThreadId);
        if (exists) {
          destination = await hub.forThread(task.originThreadId);
        }
      }
      // 排队投递不阻塞下一项后台任务；失败仍可在任务详情查看权威结果。
      if (!closed) void destination.notify(message, `task-notify-${attemptId}`).catch(() => undefined);
    } catch {
      // 不重试模型/工具；状态保存失败保留原记录，由启动恢复/人工检查处理。
      await tasks.markFinished(taskId, "failed", undefined, attemptId).catch(() => undefined);
    } finally {
      active = undefined;
      await hub.release(threadId);
    }
  };

  const drain = async (): Promise<void> => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed) {
        const next = (await tasks.list()).find((task) => task.status === "queued");
        if (!next || closed) return;
        await runOne(next.id);
      }
    } finally { running = false; }
  };
  const kick = () => {
    if (!closed) current = current.then(drain, drain).catch(() => undefined);
  };
  return {
    kick,
    control: async (id, action) => {
      const result = await tasks.control(id, action);
      if (result.ok) {
        if (action === "cancel" && active?.id === id) active.controller.abort();
        kick();
      }
      return result;
    },
    cancelByOriginThreadId: async (originThreadId: string) => {
      if (active) {
        const currentTask = (await tasks.list()).find((t) => t.id === active?.id);
        if (currentTask?.originThreadId === originThreadId) {
          active.controller.abort();
        }
      }
      return tasks.cancelByOriginThreadId(originThreadId);
    },
    isRunning: () => running,
    close: () => {
      if (closing) return closing;
      closed = true;
      active?.controller.abort();
      return closing = current;
    },
  };
};
