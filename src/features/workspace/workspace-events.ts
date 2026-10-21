import type { ActivityOverview } from "../activities/types.js";
import type { PendingAction } from "../actions/types.js";
import type { AgentPhase, AgentStatus, StatusRun } from "./agent-status.js";

export const MAX_CURRENT_RUNS = 32;
export const MAX_TRACKED_ACTIVITIES = 64;
export const MAX_STATUS_TOOLS = 64;
export const MAX_STATUS_SUBAGENTS = 64;
/** 活动进入终态的集合：这些状态不再出现在 ready.activities，变化只通过 activity_updated 通知一次。 */
const ACTIVITY_TERMINAL: ReadonlySet<ActivityOverview["status"]> = new Set(["completed", "failed", "stopped", "interrupted"]);
export type WorkspaceUpdate =
  | { event: "agent_status_updated"; status: AgentStatus }
  | { event: "approval_pending" | "approval_updated"; approval: PendingAction }
  | { event: "activity_updated"; activity: ActivityOverview };
type Subscriber = { notify: (event: WorkspaceUpdate) => void; close: () => void };
export class ExecutionCapacityError extends Error {
  constructor() { super("Too many active executions (maximum 32)"); }
}
const copy = <T>(value: T): T => structuredClone(value);
const runKey = (spaceId: string, runId: string) => JSON.stringify([spaceId, runId]);
const labelFor: Record<AgentPhase, string> = {
  preparing: "正在准备执行", waiting_model: "等待模型响应", responding: "正在生成回复",
  executing_tool: "正在执行工具", waiting_subagents: "正在等待子代理", waiting_approval: "等待人工审批", finalizing: "正在保存结果",
};
const toolLabel = (name: string | null) => ({ search_web: "正在搜索资料", web_fetch: "正在读取网页", read: "正在读取文件", write: "正在写入文件", edit: "正在编辑文件", subagent: "正在委派子代理" }[name ?? ""] ?? "正在执行工具");

/** 只保留当前运行的展示投影，不拥有执行锁，不写活动历史或事件重放日志。 */
export const createWorkspaceEvents = () => {
  const instanceId = crypto.randomUUID();
  const subscribers = new Set<Subscriber>();
  const active = new Map<string, AgentStatus>();
  const approvals = new Map<string, PendingAction>();
  const activities = new Map<string, ActivityOverview>();
  let closed = false;
  const disconnect = (subscriber: Subscriber) => {
    subscribers.delete(subscriber);
    try { subscriber.close(); } catch { /* 网络订阅不改变业务执行结果。 */ }
  };
  const publish = (event: WorkspaceUpdate) => {
    if (closed) return;
    for (const subscriber of [...subscribers]) {
      try { subscriber.notify(copy(event)); } catch { disconnect(subscriber); }
    }
  };
  const liveRuns = new Map<string, { refreshApprovals: () => void }>();
  return {
    instanceId,
    current: (): AgentStatus[] => [...active.values()].map(copy),
    pending: (): PendingAction[] => [...approvals.values()].filter((item) => Date.parse(item.expiresAt) > Date.now()).map(copy),
    activities: (): (ActivityOverview & { instanceId: string })[] => [...activities.values()].map((act) => ({ ...copy(act), instanceId })),
    subscribe: (subscriber: Subscriber): (() => void) => {
      if (closed) { disconnect(subscriber); return () => {}; }
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    seedApprovals: (items: PendingAction[]) => {
      approvals.clear();
      for (const item of items) if (item.status === "pending") approvals.set(item.id, copy(item));
    },
    approvalChanged: (item: PendingAction) => {
      if (closed) return;
      if (item.status === "pending") approvals.set(item.id, copy(item));
      else approvals.delete(item.id);
      publish({ event: item.status === "pending" ? "approval_pending" : "approval_updated", approval: item });
      const targetSpace = item.spaceId ?? item.threadId;
      if (targetSpace && item.runId) liveRuns.get(runKey(targetSpace, item.runId))?.refreshApprovals();
    },
    /**
     * 活动概览投影推送：由会话服务在活动状态变化时调用。
     * 非终态活动保留在内存集合中供 ready 同步；终态只发布一次变化并从集合移除，
     * 不做历史重放或第二份活动存储（权威记录仍是各空间 JSONL 的 custom entries）。
     */
    activityChanged: (overview: ActivityOverview) => {
      if (closed) return;
      if (ACTIVITY_TERMINAL.has(overview.status)) activities.delete(overview.id);
      else {
        // 容量防御：集合只服务展示同步，超限宁可断流让客户端重连 ready，也不无限增长。
        if (!activities.has(overview.id) && activities.size >= MAX_TRACKED_ACTIVITIES) return;
        activities.set(overview.id, copy(overview));
      }
      publish({ event: "activity_updated", activity: overview });
    },
    beginRun: (input: { spaceId?: string; threadId?: string; runId: string; source: "chat" | "job"; jobId?: string | null; title?: string; initialRevision?: number; onChange?: (status: AgentStatus) => void }): StatusRun => {
      if (closed) throw new Error("Service is closing");
      if (active.size >= MAX_CURRENT_RUNS) throw new ExecutionCapacityError();
      const spaceId = input.spaceId ?? input.threadId ?? "local-main";
      const key = runKey(spaceId, input.runId);
      if (active.has(key)) throw new Error("Execution already active");
      const now = new Date().toISOString();
      let ended = false;
      let parentPhase: AgentPhase = "preparing";
      let state: AgentStatus = {
        activityId: null, spaceId, threadId: spaceId, runId: input.runId, source: input.source, jobId: input.jobId ?? null,
        revision: input.initialRevision ?? 1, title: (input.title || "正在处理请求").slice(0, 500), status: "running", phase: "preparing", label: labelFor.preparing,
        tools: [], subagents: [], pendingApprovalIds: [], startedAt: now, updatedAt: now, endedAt: null,
      };
      const notify = (increment = true) => {
        if (increment) state.revision++;
        state.updatedAt = new Date().toISOString();
        if (!ended) active.set(key, copy(state));
        // 展示通知错误不能中断模型或已完成的工具；持久终态由协调器另行提交。
        try { input.onChange?.(copy(state)); } catch { /* 观察出口不拥有运行生命周期。 */ }
        publish({ event: "agent_status_updated", status: state });
      };
      const refresh = () => {
        if (ended) return;
        const waiting = [...approvals.values()].filter((item) => (item.spaceId ?? item.threadId) === state.spaceId && item.runId === state.runId && Date.parse(item.expiresAt) > Date.now());
        state.pendingApprovalIds = waiting.map((item) => item.id);
        for (const tool of state.tools) tool.status = waiting.some((item) => item.toolCallId === tool.toolCallId && item.subagentId === tool.subagentId) ? "waiting_approval" : "running";
        for (const child of state.subagents) if (child.status === "running" && waiting.some((item) => item.subagentId === child.id)) { child.phase = "waiting_approval"; child.label = labelFor.waiting_approval; }
        state.phase = waiting.length ? "waiting_approval"
          : state.subagents.some((item) => item.status === "running" || item.status === "queued") ? "waiting_subagents"
          : state.tools.some((item) => item.subagentId === null) ? "executing_tool" : parentPhase;
        state.label = state.phase === "executing_tool" ? state.tools.find((item) => item.subagentId === null)?.label ?? labelFor.executing_tool : labelFor[state.phase];
        notify();
      };
      active.set(key, copy(state));
      liveRuns.set(key, { refreshApprovals: refresh });
      notify(false);
      return {
        snapshot: () => copy(state),
        activity: (overview) => {
          if (ended || overview.currentRunId !== state.runId) return;
          state.activityId = overview.id;
          state.title = overview.title.slice(0, 500);
          refresh();
        },
        observe: (event) => {
          if (ended) return;
          const stamp = new Date().toISOString();
          if (event.kind === "model") {
            const phase = event.phase === "start" ? "waiting_model" : event.phase === "responding" ? "responding" : "waiting_model";
            if (event.subagentId) {
              const child = state.subagents.find((item) => item.id === event.subagentId);
              if (child && child.status === "running") { child.phase = phase; child.label = labelFor[phase]; child.updatedAt = stamp; }
            } else {
              if (parentPhase === phase && event.phase === "responding") return;
              parentPhase = phase;
            }
          } else if (event.kind === "tool") {
            const index = state.tools.findIndex((item) => item.toolCallId === event.toolCallId && item.subagentId === event.subagentId);
            if (event.phase === "start") {
              if (index < 0) {
                if (state.tools.length >= MAX_STATUS_TOOLS) throw new ExecutionCapacityError();
                state.tools.push({ toolCallId: event.toolCallId, subagentId: event.subagentId, name: event.name, label: toolLabel(event.name), status: "running" });
              }
            } else if (index >= 0) state.tools.splice(index, 1);
            if (event.subagentId) {
              const child = state.subagents.find((item) => item.id === event.subagentId);
              if (child && child.status === "running") { child.phase = event.phase === "start" ? "executing_tool" : "waiting_model"; child.label = event.phase === "start" ? toolLabel(event.name) : labelFor.waiting_model; child.updatedAt = stamp; }
            }
          } else {
            let child = state.subagents.find((item) => item.id === event.id);
            if (!child) {
              if (state.subagents.length >= MAX_STATUS_SUBAGENTS) throw new ExecutionCapacityError();
              child = { id: event.id, role: event.role.slice(0, 64), status: "queued", phase: null, label: "等待子代理执行名额", startedAt: null, updatedAt: stamp, endedAt: null };
              state.subagents.push(child);
            }
            if (event.phase === "start") { child.status = "running"; child.phase = "preparing"; child.label = labelFor.preparing; child.startedAt = stamp; }
            if (event.phase === "end") { child.status = event.outcome ?? "failed"; child.phase = null; child.endedAt = stamp; child.label = child.status === "succeeded" ? "子代理已完成" : child.status === "cancelled" ? "子代理已停止" : "子代理失败"; }
            child.updatedAt = stamp;
          }
          refresh();
        },
        finalizing: () => { if (!ended) { parentPhase = "finalizing"; refresh(); } },
        finish: (outcome) => {
          if (ended) return copy(state);
          ended = true;
          state.status = outcome; state.phase = null; state.label = outcome === "succeeded" ? "执行完成" : outcome === "cancelled" ? "执行已停止" : "执行失败";
          state.tools = []; state.pendingApprovalIds = [];
          const stamp = new Date().toISOString();
          for (const child of state.subagents) if (child.status === "queued" || child.status === "running") {
            child.status = outcome === "cancelled" ? "cancelled" : "failed"; child.phase = null; child.updatedAt = stamp; child.endedAt = stamp; child.label = "子代理执行结束";
          }
          state.endedAt = stamp;
          active.delete(key); liveRuns.delete(key);
          notify();
          return copy(state);
        },
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const subscriber of [...subscribers]) disconnect(subscriber);
    },
  };
};
export type WorkspaceEvents = ReturnType<typeof createWorkspaceEvents>;
