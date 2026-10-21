/**
 * 定时任务的持久化形状。
 *
 * 执行前没有结果字段；控制前没有页面控制状态，各字段记录实际发生的事实。
 */
export type JobControlAction = "pause" | "resume" | "cancel" | "retry";

export type JobControlResult =
  | { ok: true; job: Job }
  | { ok: false; code: "not_found" | "conflict"; message: string };

export type Job = {
  id: string;
  /** 到点后作为用户消息发给模型的内容。 */
  prompt: string;
  /** true = 每天 at(HH:mm 本地)；false = at 为一次性 ISO 时间。 */
  daily: boolean;
  at: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: "completed" | "failed";
  lastResult?: string;
  /** 显式页面控制状态；未发生人工控制时由调度状态和执行结果展示。 */
  controlState?: "paused" | "cancelled" | "retry_pending";
  lastControl?: { action: JobControlAction; at: string };
  /** 创建该任务的空间 ID；触发时将消息写入此空间当前绑定的会话。 */
  originSpaceId?: string;
};
