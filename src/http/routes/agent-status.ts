import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { agentStatusQuery } from "../contracts/agent-status.js";

/** 结果不明时按同一run身份查询；不调用模型、不建立会话、不与Activity历史维护第二套记录。 */
export const createAgentStatusRoutes = (dependencies: Pick<HttpDependencies, "conversationHub" | "workspaceEvents">) => {
  const app = new Hono();
  app.get("/api/agent/status", async (c) => {
    const parsed = agentStatusQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid execution status query" }, 400);
    const conversation = await dependencies.conversationHub.findThread(parsed.data.threadId);
    const status = conversation?.executionStatus(parsed.data.runId);
    return status ? c.json({ instanceId: dependencies.workspaceEvents.instanceId, status }) : c.json({ error: "Execution status not found" }, 404);
  });
  return app;
};
