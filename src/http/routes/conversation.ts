import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";

/** 会话历史（threadId 查询参数选择，缺省主会话）。历史只读，回写端点已移除。 */
export const createConversationRoutes = (
  dependencies: Pick<HttpDependencies, "conversationHub">,
) => {
  const { conversationHub } = dependencies;
  const app = new Hono();
  app.get("/api/conversation", async (c) => {
    const threadId = c.req.query("threadId") || "local-main";
    try {
      const conversation = await conversationHub.forThread(threadId);
      return c.json({ messages: conversation.history() });
    } catch {
      return c.json({ error: "Invalid threadId" }, 400);
    }
  });
  return app;
};
