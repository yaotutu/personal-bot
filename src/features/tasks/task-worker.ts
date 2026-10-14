import type { ConversationHub } from "../conversation/conversation-hub.js";
import type { Conversation } from "../conversation/conversation-service.js";
import type { TaskService } from "./task-service.js";

export type TaskWorker = {
  /** 有排队任务时 kick 一次（创建/重试/启动后调用）；自身幂等。 */
  kick: () => void;
  isRunning: () => boolean;
  close: () => Promise<void>;
};

/**
 * 异步任务 worker：进程内串行执行（单并发，单用户场景足够）。
 * 每个任务在独立 thread（task-<id>）跑一轮完整 pi 会话（含工具调用），
 * 完成后向主会话发一条通知轮（复用 trigger，模型简要总结结果）。
 * 崩溃哲学：执行中的进程崩溃后任务停留在 running——启动时 reconcile
 * 将其标记为 failed（可手动重试），不做断点续跑。
 * 主会话忙时通知轮放弃（结果仍在任务记录与任务 thread 历史里），不阻塞 worker。
 */
export const createTaskWorker = (
  tasks: Pick<TaskService, "list" | "markRunning" | "markFinished">,
  hub: Pick<ConversationHub, "forThread">,
  mainConversation: Pick<Conversation, "isRunning" | "trigger">,
): TaskWorker => {
  let running = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let current: Promise<void> = Promise.resolve();

  /** 启动恢复：把上次进程留下的 running 任务标为 failed（诚实，可重试）。 */
  const reconcile = async () => {
    for (const task of await tasks.list()) {
      if (task.status === "running") {
        // 直接迁移：此时不可能有真实执行（单进程串行），标记失败等待重试。
        await tasks.markFinished(task.id, "failed");
      }
    }
  };

  const notifyMain = async (title: string, status: string, result?: string) => {
    if (mainConversation.isRunning()) return;
    const summary = (result ?? "").slice(0, 600);
    await mainConversation.trigger(
      `📋 [任务${status === "succeeded" ? "完成" : "失败"}] ${title}` +
        (summary ? `\n结果摘要：${summary}` : ""),
      `task-notify-${Date.now()}`,
    );
  };

  const runOne = async (taskId: string): Promise<void> => {
    const claimed = await tasks.markRunning(taskId);
    if (!claimed) return;
    const task = (await tasks.list()).find((x) => x.id === taskId);
    if (!task) return;
    try {
      const thread = await hub.forThread(`task-${taskId}`);
      const outcome = await thread.trigger(task.prompt, `task-${taskId}`);
      if (outcome.status === "completed") {
        await tasks.markFinished(taskId, "succeeded", outcome.text);
        await notifyMain(task.title, "succeeded", outcome.text).catch(() => undefined);
      } else {
        // busy 或执行失败都按失败处理；执行轮的细节在任务 thread 历史里可查。
        await tasks.markFinished(taskId, "failed");
        await notifyMain(task.title, "failed").catch(() => undefined);
      }
    } catch {
      await tasks.markFinished(taskId, "failed").catch(() => undefined);
    }
  };

  const drain = async (): Promise<void> => {
    if (running || closed) return;
    running = true;
    try {
      for (;;) {
        if (closed) return;
        const next = (await tasks.list()).find((task) => task.status === "queued");
        if (!next) return;
        await runOne(next.id);
      }
    } finally {
      running = false;
    }
  };

  return {
    kick: () => {
      if (closed) return;
      current = current.then(drain, drain);
    },
    isRunning: () => running,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = current.catch(() => undefined);
      return closing;
    },
  };
};

/** 组合入口在启动时调用：先恢复遗留状态，再 kick 排队任务。 */
export const startTaskWorker = async (
  worker: TaskWorker,
  reconcile: () => Promise<void>,
) => {
  await reconcile();
  worker.kick();
};
