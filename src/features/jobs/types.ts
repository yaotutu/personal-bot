/**
 * 定时任务的持久化形状。
 *
 * optional 字段保持旧 jobs.json 的兼容性：历史文件可能还没有运行结果字段。
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
  /** 页面控制状态；旧 jobs.json 缺省时沿用 enabled/lastStatus 兼容语义。 */
  controlState?: "paused" | "cancelled" | "retry_pending";
  lastControl?: { action: JobControlAction; at: string };
};
