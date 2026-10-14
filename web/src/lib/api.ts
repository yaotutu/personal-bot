/**
 * 服务端 API 客户端：类型来自服务端契约模块（编译期对齐）。
 * token 持久化在 localStorage；401 时清除并要求重新登录。
 */

// 契约类型只做类型引用（import type），不把服务端模块打进 Web 产物。
type ContractModule = typeof import("../../../src/http/contracts/index.js");

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
