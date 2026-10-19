import { Hono } from "hono";
import type { WorkspaceEvents, WorkspaceUpdate } from "../../features/workspace/workspace-events.js";
import { presentApproval, presentApprovalResolution } from "../approval-presenters.js";

const encoder = new TextEncoder();
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_READY_BYTES = 12 * 1024 * 1024;
const MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const MAX_BUFFER_EVENTS = 128;
const MAX_CONNECTIONS = 8;
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const heartbeat = encoder.encode(": keep-alive\n\n");

/** 订阅与ready快照同步建立，只有进程内当前状态，不依赖磁盘异步快照或事件重放。 */
export const createWorkspaceEventRoutes = (events: WorkspaceEvents) => {
  const app = new Hono();
  let connections = 0;
  app.get("/api/events", (c) => {
    if (connections >= MAX_CONNECTIONS) return c.json({ error: "Too many event connections" }, 429);
    connections++;
    const signal = c.req.raw.signal;
    let flush = () => {};
    let disconnect = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        let initialized = false;
        let heartbeatDue = false;
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setInterval> | undefined;
        let queuedBytes = 0;
        const queue: { key: string; bytes: Uint8Array }[] = [];
        disconnect = () => {
          if (ended) return;
          ended = true;
          connections--;
          clearInterval(timer);
          unsubscribe();
          signal.removeEventListener("abort", disconnect);
          queue.length = 0;
          queuedBytes = 0;
          try { controller.close(); } catch { /* 消费端可能已经取消。 */ }
        };
        flush = () => {
          if (!initialized || ended || (controller.desiredSize ?? 0) <= 0) return;
          const next = queue.shift();
          if (next) { queuedBytes -= next.bytes.byteLength; controller.enqueue(next.bytes); }
          else if (heartbeatDue) { heartbeatDue = false; controller.enqueue(heartbeat); }
        };
        const notify = (event: WorkspaceUpdate) => {
          if (ended) return;
          const data = event.event === "agent_status_updated" ? event.status
            : event.event === "approval_pending" ? presentApproval(event.approval) : presentApprovalResolution(event.approval);
          const bytes = frame(event.event, { instanceId: events.instanceId, ...data });
          if (bytes.byteLength > MAX_EVENT_BYTES) { disconnect(); return; }
          const key = event.event === "agent_status_updated" ? `run:${event.status.threadId}:${event.status.runId}` : "";
          const existing = key ? queue.find((item) => item.key === key) : undefined;
          if (existing) { queuedBytes -= existing.bytes.byteLength; existing.bytes = bytes; }
          else queue.push({ key, bytes });
          queuedBytes += bytes.byteLength;
          // 只合并可覆盖的运行快照；审批新增/终态不静默丢弃，背压超限断流让ready重新同步。
          if (queue.length > MAX_BUFFER_EVENTS || queuedBytes > MAX_BUFFER_BYTES) { disconnect(); return; }
          flush();
        };
        // 从订阅到取得快照期间没有await，单进程内变更无法落入未覆盖窗口。
        unsubscribe = events.subscribe({ notify, close: disconnect });
        if (ended) return;
        const ready = frame("ready", {
          instanceId: events.instanceId, serverTime: new Date().toISOString(),
          agentStatuses: events.current(), pendingApprovals: events.pending().map(presentApproval),
        });
        if (ready.byteLength > MAX_READY_BYTES) { disconnect(); return; }
        queue.unshift({ key: "ready", bytes: ready });
        queuedBytes += ready.byteLength;
        initialized = true;
        signal.addEventListener("abort", disconnect, { once: true });
        if (signal.aborted) { disconnect(); return; }
        timer = setInterval(() => { heartbeatDue = true; flush(); }, 30_000);
        timer.unref();
        flush();
      },
      pull() { flush(); },
      cancel() { disconnect(); },
    }, { highWaterMark: 1 });
    return c.body(body, 200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    });
  });
  return app;
};
