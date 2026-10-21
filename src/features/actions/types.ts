/**
 * 审批域：写类操作的人工闸门。工具执行前登记 pending action 并轮询等待
 * 决定（approve → 执行；deny → 受控拒绝；超时 → expired；中止 → cancelled）。
 * 决定只能由人通过 REST 发出；本域不执行文件写入，记录人的决定与工具回报的执行事实。
 *
 * 记录一旦创建，内容字段（kind/title/payload/归属/期限）不可变；状态迁移只通过
 * repository 的串行 update 完成，终态迁移与执行回执都递增 revision。这样 SSE 消费者
 * 可以用 (id, revision) 判断自己看到的是否仍是同一份内容。
 */
export type ActionKind = "file_write" | "file_edit";
export type ActionStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type SettledActionStatus = Exclude<ActionStatus, "pending">;
export type ApprovalExecutionStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type ApprovalExecution = {
  status: ApprovalExecutionStatus;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
};
export type ApprovalChange = { approval: PendingAction };
export type ApprovalCursor = { resolvedAt: string; id: string };
export type ApprovalHistoryQuery = {
  limit: number;
  cursor?: ApprovalCursor;
  spaceId?: string;
  activityId?: string;
  status?: SettledActionStatus;
};
export type ApprovalHistoryPage = {
  approvals: PendingAction[];
  hasMore: boolean;
  nextCursor: ApprovalCursor | null;
};

/** 提交前对 pending 队列的硬容量限制；超限由 ApprovalCapacityError 受控拒绝。 */
export const MAX_PENDING_APPROVALS = 32;
/** 单个 action 按 UTF-8 JSON 编码后的最大字节数（含完整预览正文）。 */
export const MAX_APPROVAL_BYTES = 1_500_000;
/** 所有 pending action 按 UTF-8 JSON 编码后的累计最大字节数。 */
export const MAX_PENDING_APPROVAL_BYTES = 6_000_000;

/**
 * 容量拒绝使用固定安全文案：不包含路径、正文、标题或任何调用方输入，
 * 可安全透传到模型上下文、HTTP 响应和日志。
 */
export class ApprovalCapacityError extends Error {
  constructor() {
    super("Approval capacity exceeded; the request was not recorded.");
    this.name = "ApprovalCapacityError";
  }
}

/** 调用方显式传入执行上下文；审批域不依赖会话/工具适配器。 */
export type ActionSubmitOptions = {
  timeoutMs?: number;
  /** 未提供时持久化为 null，不推断当前空间/运行。 */
  spaceId?: string | null;
  runId?: string | null;
  /** 以下字段只用于审计/展示关联；未提供时持久化为 null，不推断当前上下文。 */
  toolCallId?: string | null;
  subagentId?: string | null;
  workspaceSpaceId?: string | null;
  activityId?: string | null;
};

export type PendingAction = {
  id: string;
  kind: ActionKind;
  /** 人类可读的一句话摘要，如 "写入 workspace/notes.md"。 */
  title: string;
  /** 结构化负载：待写入路径/内容或编辑前后文本（用于 Web 展示 diff 预览）。 */
  payload: Record<string, string>;
  status: ActionStatus;
  /** 创建时为 1；终态迁移与执行回执各 +1，幂等重放不推进版本。 */
  revision: number;
  createdAt: string;
  /** 登记时固定的授权截止时间；不能由轮询方延长。 */
  expiresAt: string;
  /** 终态时间；pending 为 null。expired/cancelled 也以该时间作为结束时间。 */
  resolvedAt: string | null;
  /** 仅人工 approve/deny 写入；expired/cancelled 保持 null，不能伪装成人的决定。 */
  decidedAt: string | null;
  /** 仅作审批归属展示/审计，不代替 HTTP 鉴权；未提供上下文时为 null。 */
  spaceId?: string | null;
  runId: string | null;
  toolCallId: string | null;
  subagentId: string | null;
  workspaceSpaceId?: string | null;
  activityId: string | null;
  /** 执行事实独立于人的决定；未观察到执行时省略，不从 approved 推断成功。 */
  execution?: ApprovalExecution;
};

/** 决定结果轮询的返回：pending 继续等，其余为终态。 */
export type ActionDecision =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" };

/**
 * HTTP 决定入口的结构化结果：not_found 表示 ID 不存在；conflict 表示记录已处于
 * 其他终态或首次检查即已过期（过期会先持久化 expired 再返回冲突）。重复相同决定
 * 幂等返回 ok + 原 action。
 */
export type ActionResolution = {
  ok: boolean;
  code?: "not_found" | "conflict";
  action?: PendingAction;
};

/**
 * onChange 在成功落盘后同步收到 action 的深拷贝；回调失败或返回 rejected Promise
 * 都不会影响已提交状态，也不会阻塞调用方拿到结果。
 */
export type ActionServiceOptions = {
  onChange?: (action: PendingAction) => void;
};

export type ActionRepository = {
  read: () => Promise<PendingAction[]>;
  update: <T>(
    change: (items: PendingAction[]) => { items?: PendingAction[]; result: T },
  ) => Promise<T>;
};
