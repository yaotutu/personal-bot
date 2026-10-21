/**
 * 监控域：周期抓取一个网页并按内容变化或关键词命中通知。
 * 检查与通知由 monitor-scheduler 驱动；域本身只维护状态与去重语义：
 * change 只在内容指纹变化时通知；contains 只在"未命中→命中"时通知。
 */
export type MonitorCondition = "change" | "contains";

export type Monitor = {
  id: string;
  title: string;
  url: string;
  condition: MonitorCondition;
  /** contains 条件的关键词。 */
  value?: string;
  /** 检查间隔（分钟），最小 5。 */
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  createdAt: string;
  lastCheckedAt?: string;
  /** change：内容指纹；contains：上次是否命中。 */
  lastFingerprint?: string;
  lastMatched?: boolean;
  lastNotifiedAt?: string;
  originSpaceId?: string;
  /** 已观察到的变化与通知投递分开，投递失败时下次扫描仅补通知。 */
  pendingNotification?: { id: string; summary: string };
  checks: number;
  error?: string;
};

/** 一次检查的输入输出；抓取由 scheduler 注入（复用 web 服务的安全边界）。 */
export type MonitorCheckOutcome =
  | { kind: "silent" }
  | { kind: "notified"; summary: string }
  | { kind: "error"; message: string };

export type MonitorRepository = {
  read: () => Promise<Monitor[]>;
  update: <T>(change: (items: Monitor[]) => { items?: Monitor[]; result: T }) => Promise<T>;
};
