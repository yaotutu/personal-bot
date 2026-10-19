import { randomUUID } from "node:crypto";
import type {
  ActionDecision,
  ActionKind,
  ActionRepository,
  ActionSubmitOptions,
  PendingAction,
  ApprovalChange,
  ApprovalDecisionResult,
  ApprovalExecutionStatus,
  ApprovalHistoryPage,
  ApprovalHistoryQuery,
  SettledActionStatus,
} from "./types.js";

type ApprovalUpdate<T> = {
  items?: PendingAction[];
  result: T;
  changed?: PendingAction[];
};

/** 审批决定和工具执行共用同一写队列；订阅只观察提交后的副本，不拥有执行权限。 */
export const createActionService = (repository: ActionRepository, onChanged?: (change: ApprovalChange) => void) => {
  const listeners = new Set<(change: ApprovalChange) => void>();
  const hasExpired = (action: PendingAction) => {
    const deadline = Date.parse(action.expiresAt);
    return !Number.isFinite(deadline) || Date.now() >= deadline;
  };
  const settle = (action: PendingAction, status: SettledActionStatus) => {
    action.status = status;
    action.decidedAt = new Date().toISOString();
  };
  const notify = (approval: PendingAction) => {
    for (const listener of [...listeners, ...(onChanged ? [onChanged] : [])]) {
      try { listener({ approval: structuredClone(approval) }); }
      catch { /* 展示通知失败不能回滚已提交的决定或副作用。 */ }
    }
  };
  const update = <T>(change: (items: PendingAction[]) => ApprovalUpdate<T>): Promise<T> =>
    repository.update((items) => {
      const next = change(items);
      return {
        items: next.items,
        result: { value: next.result, changed: next.changed?.map((item) => structuredClone(item)) ?? [] },
      };
    }).then(({ value, changed }) => {
      changed.forEach(notify);
      return value;
    });

  return {
    list: (): Promise<PendingAction[]> => repository.read(),
    /** 显式对齐过期状态，不增加后台计时器，也不清理历史或预览。 */
    reconcileExpired: (): Promise<void> => update((items) => {
      const expired = items.filter((item) => item.status === "pending" && hasExpired(item));
      expired.forEach((item) => settle(item, "expired"));
      return { ...(expired.length ? { items, changed: expired } : {}), result: undefined };
    }),
    listPending: (): Promise<PendingAction[]> => repository.read()
      .then((items) => items.filter((item) => item.status === "pending" && !hasExpired(item))),
    get: (id: string): Promise<PendingAction | undefined> => repository.read()
      .then((items) => items.find((item) => item.id === id)),
    history: async (query: ApprovalHistoryQuery): Promise<ApprovalHistoryPage> => {
      // 决定时间是分页排序的权威字段；损坏记录不能用申请时间补齐，伪造其处理时刻。
      const records = (await repository.read()).filter((item) => item.status !== "pending").map((item) => {
        if (!item.decidedAt || !Number.isFinite(Date.parse(item.decidedAt)))
          throw new Error("Invalid approval decision time");
        return { ...item, decidedAt: item.decidedAt };
      });
      const sorted = records.filter((item) =>
        (!query.status || item.status === query.status) &&
        (!query.threadId || item.threadId === query.threadId) &&
        (!query.activityId || item.activityId === query.activityId))
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.id.localeCompare(a.id));
      const { cursor } = query;
      const candidates = cursor ? sorted.filter((item) => item.decidedAt < cursor.decidedAt ||
        (item.decidedAt === cursor.decidedAt && item.id < cursor.id)) : sorted;
      const approvals = candidates.slice(0, query.limit);
      const hasMore = candidates.length > approvals.length;
      const last = approvals.at(-1);
      return { approvals, hasMore, nextCursor: hasMore && last ? { decidedAt: last.decidedAt, id: last.id } : null };
    },
    subscribe: (listener: (change: ApprovalChange) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    submit: (kind: ActionKind, title: string, payload: Record<string, string>, options: ActionSubmitOptions = {}): Promise<PendingAction> => {
      const timeoutMs = options.timeoutMs ?? 300_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return Promise.reject(new Error("Approval timeout must be positive and finite"));
      return update((items) => {
        const createdAt = Date.now();
        const action: PendingAction = {
          id: randomUUID(), kind, title, payload: { ...payload }, status: "pending",
          createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + timeoutMs).toISOString(),
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
          ...(options.runId === undefined ? {} : { runId: options.runId }),
          ...(options.activityId === undefined ? {} : { activityId: options.activityId }),
          ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
        };
        // 历史和完整预览长期保留，不能通过条数上限静默裁剪。
        return { items: [...items, action], result: action, changed: [action] };
      });
    },
    decide: (id: string, decision: "approve" | "deny"): Promise<ApprovalDecisionResult> => update<ApprovalDecisionResult>((items) => {
      const approval = items.find((item) => item.id === id);
      if (!approval) return { result: { ok: false, code: "not_found", message: "Approval not found" } };
      const desired = decision === "approve" ? "approved" : "denied";
      // 同决定重发只返回已有记录，不能重新放行、延长期限或重执行。
      if (approval.status === desired) return { result: { ok: true, approval } };
      if (approval.status !== "pending") return { result: { ok: false, code: "conflict", message: "Approval already settled" } };
      if (hasExpired(approval)) {
        settle(approval, "expired");
        return { items, changed: [approval], result: { ok: false, code: "conflict", message: "Approval expired" } };
      }
      settle(approval, desired);
      return { items, changed: [approval], result: { ok: true, approval } };
    }),
    cancel: (id: string): Promise<void> => update((items) => {
      const action = items.find((item) => item.id === id);
      if (!action || action.status !== "pending") return { result: undefined };
      settle(action, "cancelled");
      return { items, result: undefined, changed: [action] };
    }),
    /** 仅撤销旧进程授权和标记无法确定的在途提交，不重跑文件操作或推断成功/失败。 */
    cancelPending: (): Promise<void> => update((items) => {
      const changed: PendingAction[] = [];
      for (const action of items) {
        if (action.status === "pending") {
          settle(action, "cancelled");
          changed.push(action);
        } else if (action.execution?.status === "running") {
          action.execution = {
            ...action.execution, status: "unknown", finishedAt: null,
            result: "Execution was interrupted; verify the current file before repeating",
          };
          changed.push(action);
        }
      }
      return { ...(changed.length ? { items, changed } : {}), result: undefined };
    }),
    poll: (id: string): Promise<ActionDecision> => update((items) => {
      const action = items.find((item) => item.id === id);
      if (!action) return { result: { status: "denied" } };
      if (action.status === "pending" && hasExpired(action)) {
        settle(action, "expired");
        return { items, changed: [action], result: { status: "expired" } };
      }
      return { result: { status: action.status } };
    }),
    markExecuting: (id: string): Promise<boolean> => update((items) => {
      const action = items.find((item) => item.id === id);
      if (!action || action.status !== "approved" || action.execution || hasExpired(action)) return { result: false };
      action.execution = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null };
      return { items, result: true, changed: [action] };
    }),
    finishExecution: (id: string, status: Exclude<ApprovalExecutionStatus, "running">, result: string): Promise<void> => update((items) => {
      const action = items.find((item) => item.id === id);
      if (!action || action.status !== "approved" || action.execution?.status !== "running") return { result: undefined };
      action.execution = { ...action.execution, status, finishedAt: new Date().toISOString(), result };
      return { items, result: undefined, changed: [action] };
    }),
  };
};

export type ActionService = ReturnType<typeof createActionService>;
