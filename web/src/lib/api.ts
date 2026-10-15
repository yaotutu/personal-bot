/**
 * 服务端 API 客户端：类型来自服务端契约模块（编译期对齐）。
 * token 持久化在 localStorage；401 时清除并要求重新登录。
 */

export type ApiMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  toolCalls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  toolCallId?: string;
};

const BASE = "";

const tokenKey = "personal-bot-token";
export const getToken = () => localStorage.getItem(tokenKey);
const setToken = (value: string | null) =>
  value === null ? localStorage.removeItem(tokenKey) : localStorage.setItem(tokenKey, value);

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(BASE + path, { ...init, headers });
  if (response.status === 401) {
    setToken(null);
    throw new ApiError(401, "登录已过期，请重新输入访问密钥");
  }
  return response;
};

export const login = async (accessKey?: string): Promise<boolean> => {
  const response = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ accessKey: accessKey?.trim() || undefined }),
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { token: string };
  setToken(data.token);
  return true;
};
export const isLoggedIn = () => Boolean(getToken());

export const listThreads = async (): Promise<{ id: string; updatedAt: string }[]> => {
  const response = await request("/api/threads");
  if (!response.ok) throw new ApiError(response.status, "无法加载会话列表");
  return ((await response.json()) as { threads: { id: string; updatedAt: string }[] }).threads;
};

export const loadHistory = async (threadId: string): Promise<ApiMessage[]> => {
  const response = await request(`/api/conversation?threadId=${encodeURIComponent(threadId)}`);
  if (!response.ok) throw new ApiError(response.status, "无法加载历史");
  return ((await response.json()) as { messages: ApiMessage[] }).messages;
};

/** AG-UI run 请求体；消息只需携带用户序列，服务端校验 canonical 历史。 */
export type RunRequest = {
  threadId: string;
  runId: string;
  messages: ApiMessage[];
};

/** SSE 流事件（与服务端 contracts/events.ts 的子集对齐；passthrough 字段按需读）。 */
export type SseEvent = {
  type: string;
  messageId?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  content?: string;
  role?: string;
  code?: string;
  message?: string;
  messages?: ApiMessage[];
};

/**
 * 发起一轮对话并流式消费 AG-UI 事件。
 * fetch POST + ReadableStream 手工解析 SSE（EventSource 不支持 POST）。
 */
export const runConversation = async (
  input: RunRequest,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await request("/api/copilotkit/agent/default/run", {
    method: "POST",
    body: JSON.stringify({ ...input, state: {}, tools: [], context: [], forwardedProps: {} }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, `请求失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
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
        try {
          onEvent(JSON.parse(payload) as SseEvent);
        } catch {
          // 非 JSON 帧忽略；协议错误由 RUN_ERROR 事件表达。
        }
      }
    }
  }
};

export const stopConversation = async (threadId: string): Promise<boolean> => {
  const response = await request(
    `/api/copilotkit/agent/default/stop/${encodeURIComponent(threadId)}`,
    { method: "POST", body: "{}" },
  );
  if (!response.ok) return false;
  return ((await response.json()) as { stopped: boolean }).stopped;
};


// ---------------------------------------------------------------------------
// 任务（定时任务投影）、记忆、身份与 SOUL/USER 管理
// ---------------------------------------------------------------------------
export type TaskView = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  nextRunAt?: string;
  result?: string;
  error?: string | null;
  updatedAt: string;
};

export type MemoryRecord = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type IdentityRecord = {
  name: string;
  tone: string;
  avatar?: string;
  showChatUpdates?: boolean;
};

export const getAgentSnapshot = async (): Promise<{
  tasks: TaskView[];
  memories: MemoryRecord[];
  identity: IdentityRecord;
}> => {
  const response = await request("/api/agent");
  if (!response.ok) throw new ApiError(response.status, "无法加载工作区");
  return response.json();
};

export const createTask = async (prompt: string, title?: string): Promise<TaskView> => {
  const response = await request("/api/agent/tasks", {
    method: "POST",
    body: JSON.stringify({ prompt, title }),
  });
  if (!response.ok) throw new ApiError(response.status, "创建失败");
  return response.json();
};

export const controlTask = async (
  id: string,
  action: "pause" | "resume" | "cancel" | "retry",
  target?: "job" | "task",
): Promise<{ ok: boolean; error?: string }> => {
  const response = await request(`/api/agent/tasks/${id}/control`, {
    method: "POST",
    body: JSON.stringify({ action, target }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? `操作失败 (${response.status})` };
  }
  return { ok: true };
};

export const addMemory = async (text: string): Promise<MemoryRecord> => {
  const response = await request("/api/agent/memories", {
    method: "POST",
    body: JSON.stringify({ text, source: "Web UI" }),
  });
  if (!response.ok) throw new ApiError(response.status, "保存失败");
  return response.json();
};

export const editMemory = async (id: string, text: string): Promise<MemoryRecord> => {
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

export const saveIdentity = async (patch: IdentityRecord): Promise<IdentityRecord> => {
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
export type MilestoneView = { id: string; title: string; done: boolean };
export type GoalView = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed" | "archived";
  milestones: MilestoneView[];
  createdAt: string;
  updatedAt: string;
};

export const listGoals = async (): Promise<GoalView[]> => {
  const snapshot = await getAgentSnapshot();
  return (snapshot as unknown as { goals: GoalView[] }).goals ?? [];
};

export const createGoal = async (input: {
  title: string;
  description?: string;
  category?: string;
  milestones?: string[];
}): Promise<GoalView> => {
  const response = await request("/api/agent/goals", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(response.status, "创建失败");
  return response.json();
};

export const setGoalStatus = async (
  id: string,
  status: GoalView["status"],
): Promise<GoalView> => {
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
): Promise<GoalView> => {
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
export type PendingActionView = {
  id: string;
  kind: "file_write" | "file_edit";
  title: string;
  payload: Record<string, string>;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
};

export const decideAction = async (
  id: string,
  decision: "approve" | "deny",
): Promise<boolean> => {
  const response = await request(`/api/actions/${id}/decide`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  return response.ok;
};

// ---------------------------------------------------------------------------
// 网页监控
// ---------------------------------------------------------------------------
export type MonitorView = {
  id: string;
  title: string;
  url: string;
  condition: "change" | "contains";
  value?: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  checks: number;
  error?: string;
  lastCheckedAt?: string;
};

export const listMonitors = async (): Promise<MonitorView[]> => {
  const snapshot = await getAgentSnapshot();
  return (snapshot as unknown as { monitors: MonitorView[] }).monitors ?? [];
};

export const createMonitor = async (input: {
  url: string;
  condition: "change" | "contains";
  value?: string;
  title?: string;
  intervalMinutes?: number;
}): Promise<MonitorView> => {
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
): Promise<MonitorView> => {
  const response = await request(`/api/agent/monitors/${id}/control`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new ApiError(response.status, "操作失败");
  return response.json();
};
