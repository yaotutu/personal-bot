import { randomUUID } from "node:crypto";
import {
  ApprovalCapacityError,
  MAX_APPROVAL_BYTES,
  MAX_PENDING_APPROVALS,
  MAX_PENDING_APPROVAL_BYTES,
  type ActionDecision,
  type ActionKind,
  type ActionRepository,
  type ActionResolution,
  type ActionServiceOptions,
  type ActionSubmitOptions,
  type PendingAction,
  type ApprovalChange,
  type ApprovalExecutionStatus,
  type ApprovalHistoryPage,
  type ApprovalHistoryQuery,
} from "./types.js";

// 容量常量与错误以 types.ts 为唯一来源；这里转出便于工具层从 service 模块直接捕获。
export {
  ApprovalCapacityError,
  MAX_APPROVAL_BYTES,
  MAX_PENDING_APPROVALS,
  MAX_PENDING_APPROVAL_BYTES,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const cloneAction = (action: PendingAction): PendingAction => structuredClone(action);

/**
 * 审批只记录人的决定，不执行副作用；所有状态迁移共用 repository 的串行更新。
 *
 * 通知契约：`onChange` 只在 repository 成功提交之后调用，并且收到 action 的深拷贝。
 * 回调本身（包括返回 rejected Promise）不会回滚、阻塞或改变已经提交的结果；读取类
 * 方法不会触发通知，重复的相同决定也不会重复通知。
 */
export const createActionService = (
  repository: ActionRepository,
  serviceOptions: ActionServiceOptions = {},
) => {
  const listeners = new Set<(change: ApprovalChange) => void>();
  /** 截止时间无效时失败关闭，不能变成永久授权。 */
  const hasExpired = (action: PendingAction) =>
    !Number.isFinite(Date.parse(action.expiresAt)) || Date.now() >= Date.parse(action.expiresAt);

  /**
   * 终态迁移只允许从 pending 发生：固定记录结束时间并推进 revision。
   * decidedAt 仅表示人的决定，expired/cancelled 不写入，避免伪装成人工操作。
   */
  const settle = (action: PendingAction, status: Exclude<PendingAction["status"], "pending">) => {
    const at = new Date().toISOString();
    action.status = status;
    action.resolvedAt = at;
    action.revision += 1;
    if (status === "approved" || status === "denied") action.decidedAt = at;
  };

  /** 提交点之后同步分发拷贝；任何回调异常都只影响该次通知，不影响业务结果。 */
  const notify = (actions: PendingAction[]) => {
    for (const action of actions) {
      const callbacks = [
        ...(serviceOptions.onChange ? [() => serviceOptions.onChange!(cloneAction(action))] : []),
        ...[...listeners].map((listener) => () => listener({ approval: cloneAction(action) })),
      ];
      for (const callback of callbacks) {
        try {
          const result: unknown = callback();
          if (result !== null && typeof result === "object" && "then" in result)
            void Promise.resolve(result).catch(() => undefined);
        } catch { /* 通知失败不能否认已经落盘的状态，也不重试或补发。 */ }
      }
    }
  };

  /**
   * 决定与过期检查在同一个更新中，避免无人轮询时仍能批准已经过期的请求。
   * 返回结构化结果供 HTTP 层区分 not_found / conflict；相同决定的重复调用是幂等的。
   */
  const resolveDecision = async (
    id: string,
    decision: "approve" | "deny",
  ): Promise<ActionResolution> => {
    let changed: PendingAction | undefined;
    const result = await repository.update((items): { items?: PendingAction[]; result: ActionResolution } => {
      const action = items.find((item) => item.id === id);
      if (!action) return { result: { ok: false, code: "not_found" } };
      if (action.status === "pending") {
        if (hasExpired(action)) {
          // 首次检查即过期：先持久化 expired，再以冲突返回；不能只返回内存中的过期判断。
          settle(action, "expired");
          changed = action;
          return { items, result: { ok: false, code: "conflict", action } };
        }
        settle(action, decision === "approve" ? "approved" : "denied");
        changed = action;
        return { items, result: { ok: true, action } };
      }
      // 同一决定的幂等重放返回原对象，不推进 revision，也不再次通知。
      const same = (decision === "approve" && action.status === "approved") ||
        (decision === "deny" && action.status === "denied");
      if (same) return { result: { ok: true, action } };
      return { result: { ok: false, code: "conflict", action } };
    });
    if (changed) notify([changed]);
    return result;
  };

  return {
    /**
     * 提交前按 UTF-8 JSON 编码整个 action，检查单项、pending 数量和 pending 累计字节。
     * 容量不足时只抛固定安全文案的 ApprovalCapacityError，且不写任何内容。
     */
    submit: async (
      kind: ActionKind,
      title: string,
      payload: Record<string, string>,
      options: ActionSubmitOptions = {},
    ): Promise<PendingAction> => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Approval timeout must be positive and finite");
      const action = await repository.update((items) => {
        const createdAt = Date.now();
        const next: PendingAction = {
          id: randomUUID(),
          kind,
          title,
          // 复制字符串键值，避免调用方之后修改传入对象影响本次记录。
          payload: { ...payload },
          status: "pending",
          revision: 1,
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + timeoutMs).toISOString(),
          resolvedAt: null,
          decidedAt: null,
          spaceId: options.spaceId ?? null,
          runId: options.runId ?? null,
          toolCallId: options.toolCallId ?? null,
          subagentId: options.subagentId ?? null,
          workspaceSpaceId: options.workspaceSpaceId ?? null,
          activityId: options.activityId ?? null,
        };
        const bytes = utf8Bytes(JSON.stringify(next));
        if (bytes > MAX_APPROVAL_BYTES) throw new ApprovalCapacityError();
        // 累计配额按持久化状态为 pending 的记录计算；过期记录由 expirePending/poll
        // 迁移为 expired 后自然释放容量。
        const pending = items.filter((item) => item.status === "pending");
        if (pending.length >= MAX_PENDING_APPROVALS) throw new ApprovalCapacityError();
        const pendingBytes = pending.reduce(
          (total, item) => total + utf8Bytes(JSON.stringify(item)),
          0,
        );
        if (pendingBytes + bytes > MAX_PENDING_APPROVAL_BYTES) throw new ApprovalCapacityError();
        // 历史不截断：pending 与全部终态记录长期保留，排序按创建顺序追加。
        return { items: [...items, next], result: next };
      });
      notify([action]);
      return action;
    },

    /** 兼容旧调用方：相同决定返回原对象，其他终态/不存在返回 undefined。 */
    decide: async (id: string, decision: "approve" | "deny"): Promise<PendingAction | undefined> => {
      const result = await resolveDecision(id, decision);
      return result.ok ? result.action : undefined;
    },

    /** HTTP 决定入口：区分 not_found / conflict，并保留幂等重放的原对象。 */
    resolveDecision,

    /** 取消仅撤销尚未决定的授权；重复取消不改变终态，也不伪造人的批准/拒绝。 */
    cancel: async (id: string): Promise<void> => {
      const changed = await repository.update((items) => {
        const action = items.find((item) => item.id === id);
        if (!action || action.status !== "pending") return { result: undefined };
        settle(action, "cancelled");
        return { items, result: action };
      });
      if (changed) notify([changed]);
    },

    /** 空间重置或删除时批量取消归属该空间的待审批项，返回实际被取消的审批 ID 列表。 */
    cancelBySpaceId: async (spaceId: string): Promise<string[]> => {
      const changed = await repository.update((items) => {
        const updated: PendingAction[] = [];
        for (const action of items) {
          const actionSpaceId = action.spaceId;
          const workspaceSpaceId = action.workspaceSpaceId;
          if (
            action.status === "pending" &&
            (actionSpaceId === spaceId || workspaceSpaceId === spaceId)
          ) {
            settle(action, "cancelled");
            updated.push(action);
          }
        }
        return updated.length ? { items, result: updated } : { result: updated };
      });
      notify(changed);
      return changed.map((item) => item.id);
    },

    /** 启动撤销旧 pending，并将遗留在途提交标记为 unknown；不补跑文件操作。 */
    cancelPending: async (): Promise<void> => {
      const changed = await repository.update((items) => {
        const updated: PendingAction[] = [];
        for (const action of items) {
          if (action.status === "pending") {
            settle(action, "cancelled");
            updated.push(action);
          } else if (action.execution?.status === "running") {
            action.execution = { ...action.execution, status: "unknown", finishedAt: null, result: "Execution was interrupted; verify the current file before repeating" };
            action.revision++;
            updated.push(action);
          }
        }
        return updated.length ? { items, result: updated } : { result: updated };
      });
      notify(changed);
    },

    /**
     * 由主 Agent 的定时器显式调用：把已超过 expiresAt 的 pending 持久化为 expired。
     * 读取路径（snapshotPending/get/history）保持纯查询，不在 read 中隐式写盘。
     */
    expirePending: async (): Promise<number> => {
      const changed = await repository.update((items) => {
        const expired = items.filter((action) => action.status === "pending" && hasExpired(action));
        if (!expired.length) return { result: [] as PendingAction[] };
        expired.forEach((action) => settle(action, "expired"));
        return { items, result: expired };
      });
      notify(changed);
      return changed.length;
    },

    /** 有效期只能由登记时持久化的 expiresAt 决定，轮询不能延长授权。 */
    poll: async (id: string): Promise<ActionDecision> => {
      let changed: PendingAction | undefined;
      const result = await repository.update((items): { items?: PendingAction[]; result: ActionDecision } => {
        const action = items.find((item) => item.id === id);
        if (!action) return { result: { status: "denied" } };
        if (action.status === "pending" && hasExpired(action)) {
          settle(action, "expired");
          changed = action;
          return { items, result: { status: "expired" } };
        }
        return { result: { status: action.status } };
      });
      if (changed) notify([changed]);
      return result;
    },

    /** 当前可审批集合：纯读取，过滤已过期项；过期持久化交给 expirePending。 */
    snapshotPending: async (): Promise<PendingAction[]> => {
      const items = await repository.read();
      return items.filter((action) => action.status === "pending" && !hasExpired(action));
    },

    /** 单条读取（含终态），纯查询。 */
    get: async (id: string): Promise<PendingAction | undefined> =>
      (await repository.read()).find((action) => action.id === id),

    page: async (query: ApprovalHistoryQuery): Promise<ApprovalHistoryPage> => {
      const records = (await repository.read()).filter((action) => action.status !== "pending").map((action) => {
        if (!action.resolvedAt || !Number.isFinite(Date.parse(action.resolvedAt)))
          throw new Error("Invalid approval resolution time");
        return { ...action, resolvedAt: action.resolvedAt };
      });
      const sorted = records.filter((action) =>
        (!query.status || action.status === query.status) &&
        (!query.spaceId || action.spaceId === query.spaceId) &&
        (!query.activityId || action.activityId === query.activityId))
        .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt) || b.id.localeCompare(a.id));
      const { cursor } = query;
      const candidates = cursor ? sorted.filter((action) => action.resolvedAt < cursor.resolvedAt ||
        (action.resolvedAt === cursor.resolvedAt && action.id < cursor.id)) : sorted;
      const approvals = candidates.slice(0, query.limit);
      const hasMore = candidates.length > approvals.length;
      const last = approvals.at(-1);
      return { approvals, hasMore, nextCursor: hasMore && last ? { resolvedAt: last.resolvedAt, id: last.id } : null };
    },

    subscribe: (listener: (change: ApprovalChange) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    /** 原子认领本次授权；先记录执行开始，再允许受控工具提交文件。 */
    markExecuting: async (id: string): Promise<boolean> => {
      const changed = await repository.update((items) => {
        const action = items.find((item) => item.id === id);
        if (!action || action.status !== "approved" || action.execution || hasExpired(action)) return { result: undefined };
        action.execution = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null };
        action.revision++;
        return { items, result: action };
      });
      if (changed) notify([changed]);
      return changed !== undefined;
    },

    /** 回执推进 revision 供 SSE 去重，不改人的决定或审批处理时间。 */
    finishExecution: async (id: string, status: Exclude<ApprovalExecutionStatus, "running">, result: string): Promise<void> => {
      const changed = await repository.update((items) => {
        const action = items.find((item) => item.id === id);
        if (!action || action.status !== "approved" || action.execution?.status !== "running") return { result: undefined };
        action.execution = { ...action.execution, status, finishedAt: status === "unknown" ? null : new Date().toISOString(), result };
        action.revision++;
        return { items, result: action };
      });
      if (changed) notify([changed]);
    },

    /** 完整历史，按落盘顺序返回；不截断、不修改。 */
    history: (): Promise<PendingAction[]> => repository.read(),

    /** 兼容既有调用方；语义与 history 相同。 */
    list: (): Promise<PendingAction[]> => repository.read(),
  };
};

export type ActionService = ReturnType<typeof createActionService>;
