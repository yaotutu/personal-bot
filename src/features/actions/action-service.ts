import { randomUUID } from "node:crypto";
import type { ActionDecision, ActionKind, ActionRepository, ActionSubmitOptions, PendingAction } from "./types.js";

/** 审批只记录人的决定，不执行副作用；所有状态迁移共用 repository 的串行更新。 */
export const createActionService = (repository: ActionRepository) => {
  /** 截止时间无效时失败关闭，不能变成永久授权。 */
  const hasExpired = (action: PendingAction) =>
    !Number.isFinite(Date.parse(action.expiresAt)) || Date.now() >= Date.parse(action.expiresAt);
  const settle = (action: PendingAction, status: PendingAction["status"]) => {
    action.status = status;
    action.decidedAt = new Date().toISOString();
  };
  return {
    list: (): Promise<PendingAction[]> => repository.read(),
    /** 截止时间在登记时固定；工具显式传入配置值，直接调用使用默认五分钟。 */
    submit: (
      kind: ActionKind,
      title: string,
      payload: Record<string, string>,
      options: ActionSubmitOptions = {},
    ): Promise<PendingAction> => {
      const timeoutMs = options.timeoutMs ?? 300_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return Promise.reject(new Error("Approval timeout must be positive and finite"));
      return repository.update((items) => {
        const createdAt = Date.now();
        const action: PendingAction = {
          id: randomUUID(), kind, title, payload, status: "pending",
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + timeoutMs).toISOString(),
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
          ...(options.runId === undefined ? {} : { runId: options.runId }),
        };
        const all = [...items, action];
        return {
          items: [...all.filter((x) => x.status === "pending"), ...all.filter((x) => x.status !== "pending").slice(-100)],
          result: action,
        };
      });
    },
    /** 决定与过期检查在同一个更新中，避免无人轮询时仍能批准已经过期的请求。 */
    decide: (id: string, decision: "approve" | "deny"): Promise<PendingAction | undefined> =>
      repository.update((items) => {
        const action = items.find((x) => x.id === id);
        if (!action || action.status !== "pending") return { result: undefined };
        if (hasExpired(action)) {
          settle(action, "expired");
          return { items, result: undefined };
        }
        settle(action, decision === "approve" ? "approved" : "denied");
        return { items, result: action };
      }),
    /** 取消仅撤销尚未决定的授权；重复取消不改变终态，也不伪造人的批准/拒绝。 */
    cancel: (id: string): Promise<void> => repository.update((items) => {
      const action = items.find((x) => x.id === id);
      if (!action || action.status !== "pending") return { result: undefined };
      settle(action, "cancelled");
      return { items, result: undefined };
    }),
    /** 启动时等待本操作完成后再接收工具调用；仅撤销旧进程 pending，不改审计终态。 */
    cancelPending: (): Promise<void> => repository.update((items) => {
      const pending = items.filter((action) => action.status === "pending");
      pending.forEach((action) => settle(action, "cancelled"));
      return pending.length ? { items, result: undefined } : { result: undefined };
    }),
    /** 有效期只能由登记时持久化的 expiresAt 决定，轮询不能延长授权。 */
    poll: (id: string): Promise<ActionDecision> =>
      repository.update((items): { items?: PendingAction[]; result: ActionDecision } => {
        const action = items.find((x) => x.id === id);
        if (!action) return { result: { status: "denied" } };
        if (action.status === "pending" && hasExpired(action)) {
          settle(action, "expired");
          return { items, result: { status: "expired" } };
        }
        return { result: { status: action.status } };
      }),
  };
};

export type ActionService = ReturnType<typeof createActionService>;
