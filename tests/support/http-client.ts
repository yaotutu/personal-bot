import { randomUUID } from "node:crypto";
import { sseEventSchema, type SseEvent } from "../../src/http/contracts/sse-events.js";

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
  const history = (threadId: string) => json(`/api/conversation?threadId=${encodeURIComponent(threadId)}`);
  const startRun = async (content: string, threadId = "local-main") => {
    const current = await history(threadId);
    const runId = randomUUID();
    const response = await request("/api/conversation/run", {
      threadId, runId, expectedRevision: current.revision, message: { id: randomUUID(), content },
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
    return { threadId, runId, events, done, cancel: () => reader.cancel() };
  };
  const run = async (content: string, threadId?: string) => (await startRun(content, threadId)).done;
  return { request, json, history, startRun, run };
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
