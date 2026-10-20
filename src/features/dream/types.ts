/**
 * Dream 后台记忆整理的业务类型。
 * 会话级状态存放在 sessions/<threadId>/dream.json，随会话目录一起删除；
 * 全局提示词与会话补充提示词是独立的纯文本文件，不在此处建模。
 */

/** 整理结果：failed 表示没有任何写入，partial 表示部分目标已写入后失败。 */
export type DreamRunStatus = "running" | "completed" | "failed" | "partial";

/** 整理后实际写入的目标，不含正文，避免报告里再复制一份用户隐私。 */
export type DreamTarget = "user" | "soul" | "instructions" | "memory";

/**
 * 模型拿不准归属或无权直接写入的建议，等待用户在页面上选择。
 * 非主会话想写全局 USER/SOUL 时只会生成这种条目，不会直接落盘。
 */
export type DreamPending = {
  id: string;
  /** 建议写入的内容（纯文本）。 */
  text: string;
  /** 模型建议的归属；用户可改选。 */
  suggestedTarget: DreamTarget;
  /** 为什么没有直接写入。 */
  reason: "ambiguous" | "global_from_session" | "no_purpose";
  createdAt: string;
};

export type DreamRun = {
  /** 本次整理开始时间。 */
  at: string;
  status: DreamRunStatus;
  /** 已实际写入的目标，partial/completed 时才有内容。 */
  changed: DreamTarget[];
  /** 本次读到的待整理消息条数，便于核对。 */
  processed: number;
  /** 受控错误文案；不含模型/文件原文。 */
  error?: string;
};

export type DreamState = {
  /** 是否开启；缺省文件时主会话为 true，其他会话为 false。 */
  enabled: boolean;
  /** true=全局提示词 + 会话补充叠加；false=只用会话自己的。 */
  inheritGlobalPrompt: boolean;
  /** 已整理到的消息 ID；undefined 表示从头开始。仅在整轮成功后推进。 */
  cursor?: string;
  /** 最近一次运行；只保留一次，不堆积历史。 */
  lastRun?: DreamRun;
  /** 待用户决定的条目，用户处理后移除。 */
  pending: DreamPending[];
};

export const defaultDreamState = (threadId: string): DreamState => ({
  enabled: threadId === "local-main",
  inheritGlobalPrompt: true,
  pending: [],
});

/** 单个会话 Dream 状态的存取端口；实现负责串行读改写与损坏文件报错。 */
export type DreamRepository = {
  read: (threadId: string) => Promise<DreamState>;
  update: <T>(
    threadId: string,
    change: (state: DreamState) => { state?: DreamState; result: T },
    options?: { allowCreate?: boolean },
  ) => Promise<T>;
};

/** 供整理轮读取的单条历史消息；只含可信的用户/助手文本，不含工具日志。 */
export type DreamMessage = { id: string; role: "user" | "assistant"; text: string };

/** 一次整理要读的窗口：游标之前的重叠上下文 + 游标之后的待整理消息。 */
export type DreamWindow = {
  /** pi 压缩摘要（若有），仅供理解。 */
  summary?: string;
  /** 游标之前的最近消息，仅供理解，不从中提取。 */
  context: DreamMessage[];
  /** 游标之后的新消息，只从这里提取。 */
  fresh: DreamMessage[];
  /** 推进游标时使用的最后一条待整理消息 ID。 */
  lastId?: string;
};
