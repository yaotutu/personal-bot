// 服务端契约类型（仅 import type，不进入打包产物）：字段变化即编译报错。
import type {
  ActionDto,
  AgentSnapshotDto,
  ChatMessageDto,
  ConversationSnapshotDto,
  GoalDto,
  MemoryDto,
  MonitorDto,
  TaskDto,
  ThreadDto,
} from "../../../src/http/contracts/responses.js";
import type { RunRequestDto } from "../../../src/http/contracts/rest.js";
import { sseEventSchema, type SseEvent } from "../../../src/http/contracts/sse-events.js";
export type { SseEvent };

export type { TaskDto, MemoryDto, MonitorDto, GoalDto, ActionDto, ThreadDto };
export type IdentityDto = NonNullable<AgentSnapshotDto["identity"]>;
export type MilestoneDto = GoalDto["milestones"][number];
/**
 * 服务端 API 客户端：类型来自服务端契约模块（编译期对齐）。
 * token 持久化在 localStorage；401 时清除并要求重新登录。
 */

export type ApiMessage = ChatMessageDto;
const BASE = "";
const tokenKey = "personal-bot-token";
export const getToken = () => localStorage.getItem(tokenKey);
// 认证状态只有 token 这一份事实；React 订阅它，401 与跨标签退出都能立即回到登录。
const authListeners = new Set<() => void>();
const publishAuth = () => { for (const listener of authListeners) listener(); };
export const subscribeAuth = (listener: () => void) => {
  authListeners.add(listener);
  const changed = (event: StorageEvent) => { if (event.key === tokenKey || event.key === null) listener(); };
  window.addEventListener("storage", changed);
  return () => { authListeners.delete(listener); window.removeEventListener("storage", changed); };
};
const setToken = (value: string | null) => {
  if (value === null) localStorage.removeItem(tokenKey);
  else localStorage.setItem(tokenKey, value);
  publishAuth();
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async (path: string, init?: RequestInit, authenticated = true): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(BASE + path, { ...init, headers });
  if (authenticated && response.status === 401) {
    setToken(null);
    throw new ApiError(401, "登录已过期，请重新输入访问密钥");
  }
  return response;
};

export const login = async (accessKey?: string): Promise<boolean> => {
  const response = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ accessKey: accessKey?.trim() || undefined }),
  }, false);
  if (!response.ok) return false;
  const data = (await response.json()) as { token: string };
  setToken(data.token);
  return true;
};
export const isLoggedIn = () => Boolean(getToken());

export const listThreads = async (): Promise<ThreadDto[]> => {
  const response = await request("/api/threads");
  if (!response.ok) throw new ApiError(response.status, "无法加载会话列表");
  return ((await response.json()) as { threads: ThreadDto[] }).threads;
};

export const loadHistory = async (
  threadId: string,
  signal?: AbortSignal,
): Promise<ConversationSnapshotDto> => {
  const response = await request(`/api/conversation?threadId=${encodeURIComponent(threadId)}`, { signal });
  if (!response.ok) throw new ApiError(response.status, "无法加载历史");
  return response.json();
};

/** 输入和事件均来自服务端契约，不再维护独立字段副本。 */
export type RunRequest = RunRequestDto;

/**
 * 发起一轮对话并流式消费 AG-UI 事件。
 * fetch POST + ReadableStream 手工解析 SSE（EventSource 不支持 POST）。
 */
export const runConversation = async (
  input: RunRequest,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await request("/api/conversation/run", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => undefined);
    throw new ApiError(response.status, failure?.error ?? `请求失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  // 除了取消 fetch，也显式取消 reader：终止悬挂读取，并丢弃已缓冲但尚未派发的帧。
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 以空行分帧；逐帧解析 data: 行。
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          let event: SseEvent;
          try {
            event = sseEventSchema.parse(JSON.parse(payload));
          } catch {
            throw new Error("服务端返回了不符合契约的聊天事件，请刷新后重试");
          }
          signal?.throwIfAborted();
          if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") terminal = true;
          onEvent(event);
        }
      }
    }
    if (!terminal) throw new Error("聊天连接提前结束，请刷新确认结果后重试");
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    // 无论正常结束、主动取消还是回调抛错，都释放前台流及其 reader 锁。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// ---------------------------------------------------------------------------
// 任务（定时任务投影）、记忆、身份与 SOUL/USER 管理
// ---------------------------------------------------------------------------

export const getAgentSnapshot = async (signal?: AbortSignal): Promise<AgentSnapshotDto> => {
  const response = await request("/api/agent", { signal });
  if (!response.ok) throw new ApiError(response.status, "无法加载工作区");
  return response.json();
};

// 后台任务域（task）已下线：此接口只保留定时任务（job）的控制。
// 历史 `target: "task"` 路径不再适用，请求里 target 只能取字面量 "job"。
export const controlTask = async (
  id: string,
  action: "pause" | "resume" | "cancel" | "retry",
): Promise<{ ok: boolean; error?: string }> => {
  const response = await request(`/api/agent/tasks/${id}/control`, {
    method: "POST",
    body: JSON.stringify({ action, target: "job" }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? `操作失败 (${response.status})` };
  }
  return { ok: true };
};

export const addMemory = async (text: string): Promise<MemoryDto> => {
  const response = await request("/api/agent/memories", {
    method: "POST",
    body: JSON.stringify({ text, source: "Web UI" }),
  });
  if (!response.ok) throw new ApiError(response.status, "保存失败");
  return response.json();
};

export const editMemory = async (id: string, text: string): Promise<MemoryDto> => {
  const response = await request(`/api/agent/memories/${id}`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new ApiError(response.status, "保存失败");
  return response.json();
};

export const forgetMemory = async (id: string): Promise<void> => {
  const response = await request(`/api/agent/memories/${id}/forget`, {
    method: "POST",
    body: "{}",
  });
  if (!response.ok) throw new ApiError(response.status, "删除失败");
};

export const saveIdentity = async (patch: IdentityDto): Promise<IdentityDto> => {
  const response = await request("/api/agent/identity", {
    method: "POST",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new ApiError(response.status, "保存失败");
  return response.json();
};

export const getProfile = async (): Promise<{ soul: string; user: string }> => {
  const response = await request("/api/profile");
  if (!response.ok) throw new ApiError(response.status, "无法加载人设文件");
  return response.json();
};

export const saveProfile = async (patch: {
  soul?: string;
  user?: string;
}): Promise<{ soul: string; user: string }> => {
  const response = await request("/api/profile", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new ApiError(response.status, "保存失败");
  return response.json();
};

// ---------------------------------------------------------------------------
// 目标与里程碑
// ---------------------------------------------------------------------------
export const listGoals = async (): Promise<GoalDto[]> => {
  const snapshot = await getAgentSnapshot();
  return snapshot.goals;
};

export const createGoal = async (input: {
  title: string;
  description?: string;
  category?: string;
  milestones?: string[];
}): Promise<GoalDto> => {
  const response = await request("/api/agent/goals", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(response.status, "创建失败");
  return response.json();
};

export const setGoalStatus = async (
  id: string,
  status: GoalDto["status"],
): Promise<GoalDto> => {
  const response = await request(`/api/agent/goals/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new ApiError(response.status, "操作失败");
  return response.json();
};

export const toggleGoalMilestone = async (
  goalId: string,
  milestoneId: string,
): Promise<GoalDto> => {
  const response = await request(
    `/api/agent/goals/${goalId}/milestones/${milestoneId}/toggle`,
    { method: "POST", body: "{}" },
  );
  if (!response.ok) throw new ApiError(response.status, "操作失败");
  return response.json();
};

export const removeGoal = async (id: string): Promise<void> => {
  const response = await request(`/api/agent/goals/${id}/remove`, {
    method: "POST",
    body: "{}",
  });
  if (!response.ok) throw new ApiError(response.status, "删除失败");
};

// ---------------------------------------------------------------------------
// 审批闸门（写操作的人工批准）
// ---------------------------------------------------------------------------
export const decideAction = async (
  id: string,
  decision: "approve" | "deny",
  signal?: AbortSignal,
): Promise<boolean> => {
  const response = await request(`/api/actions/${id}/decide`, {
    method: "POST",
    body: JSON.stringify({ decision }),
    signal,
  });
  if (!response.ok) throw new ApiError(response.status, `审批失败 (${response.status})，请刷新确认操作状态`);
  return true;
};

// ---------------------------------------------------------------------------
// 网页监控
// ---------------------------------------------------------------------------
export const listMonitors = async (): Promise<MonitorDto[]> => {
  const snapshot = await getAgentSnapshot();
  return snapshot.monitors;
};

export const createMonitor = async (input: {
  url: string;
  condition: "change" | "contains";
  value?: string;
  title?: string;
  intervalMinutes?: number;
}): Promise<MonitorDto> => {
  const response = await request("/api/agent/monitors", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(response.status, "创建失败");
  return response.json();
};

export const controlMonitor = async (
  id: string,
  action: "pause" | "resume" | "stop",
): Promise<MonitorDto> => {
  const response = await request(`/api/agent/monitors/${id}/control`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new ApiError(response.status, "操作失败");
  return response.json();
};

/** 审批高频查询仅访问审批域；完整正文只随当前 pending 返回。 */
export const listPendingActions = async (signal?: AbortSignal): Promise<ActionDto[]> => {
  const response = await request("/api/actions/pending", { signal });
  if (!response.ok) throw new ApiError(response.status, "无法加载待审批操作");
  return (await response.json()).actions;
};

/** 显式停止必须等待服务端完成取消，随后读取的 revision 才是稳定终态。 */
export const stopConversation = async (threadId: string, runId: string, signal?: AbortSignal): Promise<void> => {
  const response = await request("/api/conversation/stop", { method: "POST", signal, body: JSON.stringify({ threadId, runId }) });
  if (!response.ok) throw new ApiError(response.status, "停止失败，请重试");
};
