/**
 * 审批域：写类操作的人工闸门。工具执行前登记 pending action 并轮询等待
 * 决定（approve → 执行；deny → 受控拒绝；超时 → expired；中止 → cancelled）。
 * 决定只能由人通过 REST 发出；本域不执行任何写操作，只记录决定。
 */
export type ActionKind = "file_write" | "file_edit";
export type ActionStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** 调用方显式传入执行上下文；审批域不依赖会话/工具适配器。 */
export type ActionSubmitOptions = {
  timeoutMs?: number;
  threadId?: string;
  runId?: string;
};

export type PendingAction = {
  id: string;
  kind: ActionKind;
  /** 人类可读的一句话摘要，如 "写入 workspace/notes.md"。 */
  title: string;
  /** 结构化负载：待写入路径/内容或编辑前后文本（用于 Web 展示 diff 预览）。 */
  payload: Record<string, string>;
  status: ActionStatus;
  createdAt: string;
  /** 登记时固定的授权截止时间；不能由轮询方延长。 */
  expiresAt: string;
  /** 仅作审批归属展示/审计，不代替 HTTP 鉴权。 */
  threadId?: string;
  runId?: string;
  decidedAt?: string;
};

/** 决定结果轮询的返回：pending 继续等，其余为终态。 */
export type ActionDecision =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" };

export type ActionRepository = {
  read: () => Promise<PendingAction[]>;
  update: <T>(
    change: (items: PendingAction[]) => { items?: PendingAction[]; result: T },
  ) => Promise<T>;
};
