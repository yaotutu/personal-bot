import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runRequestSchema, stopRequestSchema } from "../../http/contracts/rest.js";
import type { ConversationHub } from "../../features/conversation/conversation-hub.js";
import { ConversationError } from "../../features/conversation/errors.js";
import { createEventProjector } from "./events.js";
import type { ToolPresentation } from "./tool-presentation.js";

/**
 * 自有 HTTP 输入与 AG-UI 输出之间的薄适配层，不需要 runtime/agent 宿主。
 * 协调器仍独占运行锁；流断开和显式 Stop 都绑定 runId，拒绝迟到取消误伤下一轮。
 */
export const createAgUiRoutes = (hub: ConversationHub, presentation: ToolPresentation) => {
  const app = new Hono();
  app.post("/api/conversation/run", async (c) => {
    const parsed = runRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid conversation request" }, 400);
    const input = parsed.data;
    const conversation = await hub.forThread(input.threadId);
    try { conversation.validate(input); }
    catch (error) {
      if (!(error instanceof ConversationError)) throw error;
      const status = error.code === "SHUTDOWN" || error.code === "MODEL_NOT_CONFIGURED" ? 503
        : error.code === "INVALID_INPUT" || error.code === "UNSUPPORTED_THREAD" ? 400 : 409;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      stream.onAbort(abort);
      if (c.req.raw.signal.aborted) abort();
      // 事件回调保持同步，实际写流串行排队。记录写入失败并取消执行，避免悬挂模型。
      let writes = Promise.resolve();
      const emit = createEventProjector((event) => {
        writes = writes.then(async () => {
          if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) });
        }).catch(abort);
      }, presentation);
      try {
        await conversation.run(input, emit, controller.signal);
      } catch (error) {
        emit({ type: "run_error", code: error instanceof ConversationError ? error.code : "RUN_ERROR",
          message: error instanceof ConversationError ? error.message : "Unable to start conversation" });
      } finally {
        await writes;
        c.req.raw.signal.removeEventListener("abort", abort);
      }
    });
  });
  app.post("/api/conversation/stop", async (c) => {
    const parsed = stopRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid stop request" }, 400);
    const conversation = await hub.forThread(parsed.data.threadId);
    return c.json({ stopped: await conversation.cancel("STOPPED", parsed.data.runId) });
  });
  return app;
};
