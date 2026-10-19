/**
 * 人工审批仅授权一次操作，执行事实由真实工具回报；两类状态分别保存。
 * 文件版本、授权期限和取消校验仍由受控工具在提交前执行，查询历史不会恢复授权。
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

export type ActionSubmitOptions = {
  timeoutMs?: number;
  threadId?: string;
  runId?: string;
  activityId?: string;
  toolCallId?: string;
};

export type PendingAction = {
  id: string;
  kind: ActionKind;
  title: string;
  /** 登记时的完整预览，之后不以当前文件或新版本替换。 */
  payload: Record<string, string>;
  status: ActionStatus;
  createdAt: string;
  expiresAt: string;
  threadId?: string;
  runId?: string;
  activityId?: string;
  toolCallId?: string;
  decidedAt?: string;
  /** 未开始/未观察到执行时省略；不得从 approved 推断成功。 */
  execution?: ApprovalExecution;
};

export type ActionDecision = { status: ActionStatus };
export type ApprovalDecisionResult =
  | { ok: true; approval: PendingAction }
  | { ok: false; code: "not_found" | "conflict"; message: string };
export type ApprovalCursor = { decidedAt: string; id: string };
export type ApprovalHistoryQuery = {
  limit: number;
  cursor?: ApprovalCursor;
  threadId?: string;
  activityId?: string;
  status?: SettledActionStatus;
};
export type ApprovalHistoryPage = {
  approvals: PendingAction[];
  hasMore: boolean;
  nextCursor: ApprovalCursor | null;
};

/** 订阅事件在提交成功后产生，不包含SSE编码，不可阻塞业务。 */
export type ApprovalChange = { approval: PendingAction };
export type ActionRepository = {
  read: () => Promise<PendingAction[]>;
  update: <T>(change: (items: PendingAction[]) => { items?: PendingAction[]; result: T }) => Promise<T>;
};
