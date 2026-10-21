import { randomUUID } from "node:crypto";
import { sseEventSchema, type SseEvent } from "../../src/http/contracts/sse-events.js";
import {
  workspaceEvents,
  type ReadyEventDto,
} from "../../src/http/contracts/workspace-events.js";

/** 测试客户端也遵循真实协议：增量输入、首终态、SSE跨chunk分帧与有界等待。 */
export const createTestClient = (baseUrl: () => string, token: string, timeoutMs = 45_000) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(baseUrl() + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const json = async (path: string, body?: unknown, method?: string) => {
    const response = await request(path, body, method);
    if (!response.ok) throw new Error(`Test request ${method ?? (body === undefined ? "GET" : "POST")} ${path} returned ${response.status}`);
    return response.json();
  };
  /**
   * 只连接通知流并读取首帧 ready：新协议没有 GET pending，待审批集合由 ready 完整给出。
   * 读到 ready 后立即取消这条通知流；聊天 run 使用独立连接，绝不受这里取消影响。
   */
  const subscribeEvents = async () => {
    // 通知流不套用单次请求超时：调用方显式 close，避免长连接被 45s 超时误断。
    const controller = new AbortController();
    const response = await fetch(baseUrl() + "/api/events", {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (response.status !== 200 || !response.body)
      throw new Error(`Event stream returned ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<{ event: string; data: unknown } | null> => {
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          let event = "";
          const data: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          // 注释心跳不是业务帧，继续等待下一条。
          if (event) return { event, data: JSON.parse(data.join("\n")) };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    const close = async () => {
      if (controller.signal.aborted) return;
      controller.abort();
      await reader.cancel().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* 已结束的流不重复释放。 */ }
    };
    return { response, next, close };
  };
  const readReady = async (): Promise<ReadyEventDto> => {
    const stream = await subscribeEvents();
    try {
      const frame = await stream.next();
      if (!frame || frame.event !== "ready") throw new Error("Event stream did not start with ready");
      return workspaceEvents.ready.parse(frame.data);
    } finally { await stream.close(); }
  };
  /** 上层仍按“当前待审批集合”使用；实现改为短接 SSE ready，不再请求已下线的 GET pending。 */
  const pending = async () => (await readReady()).pendingApprovals;
  /** 审批完整视图（含不可变 preview 与 revision）。 */
  const approval = (id: string) => json(`/api/approvals/${encodeURIComponent(id)}`);
  /** 终态审批历史分页 {approvals,hasMore,nextCursor}；pending 不在此列表。 */
  const approvalPage = (query = "") => json(`/api/approvals${query}`);
  /** 决定返回 Response，调用方自行断言 200/409；409 响应体携带当前审批视图。 */
  const decideApproval = (id: string, decision: "approve" | "deny") =>
    request(`/api/approvals/${encodeURIComponent(id)}/decision`, { decision });
  const history = (spaceId = "local-main") => json(`/api/conversation?spaceId=${encodeURIComponent(spaceId)}`);
  const startRun = async (content: string, spaceId = "local-main") => {
    const current = await history(spaceId);
    const runId = randomUUID();
    const response = await request("/api/conversation/run", {
      spaceId, runId, expectedRevision: current.revision, message: { id: randomUUID(), content },
    });
    if (response.status !== 200 || !response.body) throw new Error(`Run returned ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    const done = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith("data:")) events.push(sseEventSchema.parse(JSON.parse(line.slice(5).trim())));
            }
          }
        }
        if (!events.some((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")) throw new Error("Run stream ended without a terminal event");
        return events;
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    })();
    // 等待审批/fixture时先接住错误，最终仍由调用方await done断言，不吞失败。
    void done.catch(() => undefined);
    return { spaceId, threadId: spaceId, runId, events, done, cancel: () => reader.cancel() };
  };
  const run = async (content: string, spaceId?: string) => (await startRun(content, spaceId)).done;
  return {
    request, json, history, startRun, run,
    // 通知流与审批新协议 helper；pending 保留“当前待审批集合”语义，内部走 ready。
    subscribeEvents, readReady, pending, approval, approvalPage, decideApproval,
  };
};

export const waitForTest = async <T>(check: () => T | Promise<T>, description: string, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
