import { Hono } from "hono";
import { RunAgentInputSchema } from "@ag-ui/core";
import type { ConversationHub } from "../../features/conversation/conversation-hub.js";
import { PiAgent } from "./agent.js";
import { createRunner } from "./runner.js";
import type { ToolPresentation } from "./tool-presentation.js";

/** 只开放当前 runtime 的 info/run/stop，不提供重连或任意 runtime operation。 */
export const createAgUiRoutes = async (conversationHub: ConversationHub, presentation: ToolPresentation) => {
  // 必须在动态导入 runtime 前关闭全局 telemetry；未构造 Intelligence 或网络搜索。
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  process.env.DO_NOT_TRACK = "1";
  const { CopilotRuntime, createCopilotHonoHandler } = await import(
    "@copilotkit/runtime/v2"
  );
  const runtime = new CopilotRuntime({
    agents: ({ request }) => ({
      default: new PiAgent(conversationHub, request.signal, presentation),
    }),
    runner: createRunner(conversationHub),
  });
  const handler = createCopilotHonoHandler({
    runtime,
    basePath: "/api/copilotkit",
  });
  const app = new Hono();
  app.all("/api/copilotkit/*", async (c) => {
    const path = c.req.path;
    // stop 路径携带 threadId 段；形态校验交给 runner（非法 id 返回 false 而非 404）。
    const stopMatch = path.match(/^\/api\/copilotkit\/agent\/default\/stop\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
    const allowed =
      (c.req.method === "GET" && path === "/api/copilotkit/info") ||
      (c.req.method === "POST" &&
        (path === "/api/copilotkit/agent/default/run" || stopMatch));
    if (!allowed)
      return c.json(
        { error: "Runtime operation is not available in text-only mode" },
        501,
      );
    if (path.endsWith("/run")) {
      // SDK 自带验证，但错误日志可能打印请求内容；宿主先验证并返回清晰 JSON。
      const parsed = RunAgentInputSchema.safeParse(
        await c.req.raw
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (!parsed.success || parsed.data.messages.length > 1000)
        return c.json({ error: "Invalid AG-UI run request" }, 400);
    }
    return handler.fetch(c.req.raw);
  });
  return app;
};
