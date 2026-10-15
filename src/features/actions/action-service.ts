import { randomUUID } from "node:crypto";
import type {
  ActionDecision,
  ActionKind,
  ActionRepository,
  PendingAction,
} from "./types.js";

/**
 * 审批业务入口：登记、决定、轮询与过期清理。
 * 只保留最近 100 条终态记录（审计用），pending 不受清理影响。
 */
export const createActionService = (repository: ActionRepository) => {
  const now = () => new Date().toISOString();
  return {
    list: (): Promise<PendingAction[]> => repository.read(),
    submit: (kind: ActionKind, title: string, payload: Record<string, string>): Promise<PendingAction> =>
      repository.update((items) => {
        const action: PendingAction = {
          id: randomUUID(),
          kind,
          title,
          payload,
          status: "pending",
          createdAt: now(),
        };
        items.push(action);
        // 只裁剪终态：pending 永不被挤掉。
        const settled = items.filter((x) => x.status !== "pending");
        const pending = items.filter((x) => x.status === "pending");
        return {
          items: [...pending, ...settled.slice(-100)],
          result: action,
        };
      }),
    /** 仅 pending 可被决定；重复决定/未知 id 返回 undefined。 */
    decide: async (
      id: string,
      decision: "approve" | "deny",
    ): Promise<PendingAction | undefined> =>
      repository.update((items) => {
        const action = items.find((x) => x.id === id);
        if (!action || action.status !== "pending") return { result: undefined };
        action.status = decision === "approve" ? "approved" : "denied";
        action.decidedAt = now();
        return { items, result: action };
      }),
    /** 工具侧轮询：pending 超 timeoutMs 标记 expired 并返回 expired。 */
    poll: async (id: string, timeoutMs: number): Promise<ActionDecision> =>
      repository.update(
        (items): { items?: PendingAction[]; result: ActionDecision } => {
        const action = items.find((x) => x.id === id);
        if (!action) return { result: { status: "denied" } };
        if (action.status !== "pending") return { result: { status: action.status } };
        if (Date.now() - Date.parse(action.createdAt) > timeoutMs) {
          action.status = "expired";
          action.decidedAt = now();
          return { items, result: { status: "expired" } };
        }
        return { result: { status: "pending" } };
      }),
  };
};

export type ActionService = ReturnType<typeof createActionService>;
