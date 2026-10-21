import type { Conversation } from "../../features/conversation/conversation-service.js";
import type { JobService } from "./job-service.js";

export type Scheduler = {
  start: () => void;
  /** 只读保护控制入口；完整 tick 或已执行结果待补存期间均不可重新安排。 */
  isBusy: () => boolean;
  close: () => Promise<void>;
};

/**
 * 定时任务只依赖 JobService 和 Conversation，不依赖 HTTP。
 *
 * 固定间隔扫描、来源会话忙时跳过；启动时间重算由 JobService 在组合入口完成。
 * 扫描、执行与状态写入在进程内串行；保存失败只补写既有结果，不重试模型执行，
 * 不引入 claim、durable execution 或重试框架。
 */
export const createScheduler = (
  config: { schedulerIntervalMs: number },
  jobs: Pick<JobService, "list" | "markRun">,
  conversation: Pick<Conversation, "isRunning" | "trigger">,
  forSpace?: (spaceId: string) => Promise<Pick<Conversation, "isRunning" | "trigger"> | undefined>,
): Scheduler => {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  // 会话锁只覆盖模型执行，不覆盖扫描或 markRun 落盘。用一个进程内标志
  // 覆盖完整 tick，避免下一次扫描读到尚未推进的任务并重复执行；不增加
  // 队列或跨进程 claim，也不承诺崩溃恢复后的 exactly-once。
  let ticking = false;
  // 对齐 nanobot 的 _store_dirty 安全原则：模型已结束的结果只有保存成功才能
  // 放行后续扫描。串行 tick 保证最多一个待保存结果；仅驻留内存，不保证崩溃恢复。
  let pendingOutcome: {
    id: string;
    status: "completed" | "failed";
    text: string;
    completedAt: Date;
  } | undefined;

  const savePendingOutcome = async () => {
    if (!pendingOutcome) return;
    const { id, status, text, completedAt } = pendingOutcome;
    await jobs.markRun(id, status, text, completedAt);
    // 只有保存成功才清除；异常交给 tick，之后的固定扫描继续保存同一份结果。
    pendingOutcome = undefined;
  };

  const tick = async () => {
    if (closed || ticking) return;
    ticking = true;
    try {
      if (pendingOutcome) {
        // 补写不占用模型，也不能被客户端 busy 阻挡。与 nanobot 一致，补写成功
        // 也结束本轮，下一次普通扫描才恢复派发，失败期间绝不重读到期任务。
        await savePendingOutcome();
        return;
      }
      if (!forSpace && conversation.isRunning()) return;
      const due = (await jobs.list()).filter(
        (job) => job.enabled && Date.now() >= Date.parse(job.nextRunAt),
      );
      for (const job of due) {
        if (closed) break;
        // due 是一次扫描的快照。前一个任务执行期间，用户可能已经取消或
        // 修改了后一个任务；重新读取是为了不执行这份过期快照。
        const current = (await jobs.list()).find((item) => item.id === job.id);
        // 重读存储也是异步边界：等待期间可能已关闭服务或开始客户端轮次。
        // 必须再次检查生命周期与会话锁，不能在 close 之后发出新任务。
        if (closed) break;
        if (
          !current ||
          !current.enabled ||
          !(Date.now() >= Date.parse(current.nextRunAt))
        )
          continue;

        const targetSpaceId = current.originSpaceId ?? current.originThreadId;
        const targetConversation = targetSpaceId && forSpace
          ? await forSpace(targetSpaceId)
          : conversation;

        if (!targetConversation || closed) continue;
        if (forSpace) {
          const latest = (await jobs.list()).find((item) => item.id === current.id);
          const latestSpace = latest?.originSpaceId ?? latest?.originThreadId;
          if (closed || !latest?.enabled || latestSpace !== targetSpaceId ||
            latest.nextRunAt !== current.nextRunAt) continue;
        }
        if (targetConversation.isRunning()) continue;

        const outcome = await targetConversation.trigger(
          `⏰ [定时任务] ${current.prompt}`,
          `job-${current.id}-${Date.now()}`,
          { jobId: current.id, spaceId: targetSpaceId, threadId: targetSpaceId },
        );
        // busy 表示尚未开始执行，不是模型失败；不消耗一次性任务，留到
        // 下次普通扫描。真正已执行的失败仍按原规则 markRun，不自动重跑。
        if (outcome.status === "failed" && outcome.text === "busy") break;
        // 完成时间在模型返回时固定，补写延迟不改变 lastRunAt 或 daily 下一轮。
        pendingOutcome = { id: current.id, ...outcome, completedAt: new Date() };
        await savePendingOutcome();
      }
    } catch {
      // 单次 tick 失败不打断调度；保存失败保留 pendingOutcome，绝不重跑模型。
    } finally {
      ticking = false;
    }
  };

  return {
    start: () => {
      if (timer || closed) return;
      timer = setInterval(() => {
        const work = tick();
        pending.add(work);
        void work.finally(() => pending.delete(work));
      }, config.schedulerIntervalMs);
    },
    isBusy: () => closed || ticking || pendingOutcome !== undefined,
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      // 先同步停表，再等已发出的 tick 完成（包括 markRun 的写入）。取消模型轮
      // 由组合入口负责，不能在这里先等 trigger，否则挂起模型会阻塞服务关闭。
      // 不为尚未保存的结果启动额外补写；在途保存失败也正常退出，避免无限等待。
      closing = Promise.all([...pending]).then(() => undefined);
      return closing;
    },
  };
};
