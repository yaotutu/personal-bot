import { Hono } from "hono";
import type { WorkspaceEvents, WorkspaceUpdate } from "../../features/workspace/workspace-events.js";

const encoder = new TextEncoder();
const frame = (event: "ready" | WorkspaceUpdate) => encoder.encode(`event: ${event}\ndata: {}\n\n`);
const keepAlive = encoder.encode(": keep-alive\n\n");

/**
 * 只通知前台客户端重新读取事实，不复用聊天 SSE 的“断连取消运行”语义。
 * 每条连接最多排队一帧，另外用两个失效标记合并背压期间的重复变更，
 * 因而慢手机既不拖住业务写入，也不会积累无界的 Promise 或消息数组。
 */
export const createWorkspaceEventRoutes = (events: WorkspaceEvents) => {
  const app = new Hono();
  app.get("/api/events", (c) => {
    const signal = c.req.raw.signal;
    let flush = () => {};
    let disconnect = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        let ready = true;
        let heartbeat = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let unsubscribe = () => {};
        const pending = new Set<WorkspaceUpdate>();
        disconnect = () => {
          if (ended) return;
          ended = true;
          clearInterval(timer);
          unsubscribe();
          pending.clear();
          signal.removeEventListener("abort", disconnect);
          try { controller.close(); } catch { /* 消费端可能已经取消了流。 */ }
        };
        flush = () => {
          if (ended || (controller.desiredSize ?? 0) <= 0) return;
          if (ready) {
            ready = false;
            controller.enqueue(frame("ready"));
          } else if (pending.size) {
            const event = pending.values().next().value!;
            pending.delete(event);
            controller.enqueue(frame(event));
          } else if (heartbeat) {
            heartbeat = false;
            controller.enqueue(keepAlive);
          }
        };
        // 必须先订阅后 ready；客户端在 ready 后读取快照，避免先读后订阅的漏通知窗口。
        unsubscribe = events.subscribe({
          notify: (event) => { pending.add(event); flush(); },
          close: disconnect,
        });
        if (ended) return;
        signal.addEventListener("abort", disconnect, { once: true });
        if (signal.aborted) { disconnect(); return; }
        timer = setInterval(() => { heartbeat = true; flush(); }, 30_000);
        timer.unref();
        flush();
      },
      pull() { flush(); },
      cancel() { disconnect(); },
    }, { highWaterMark: 1 });
    return c.body(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
  });
  return app;
};
