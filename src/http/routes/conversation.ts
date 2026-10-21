import { ConversationError } from "../../features/conversation/errors.js";
import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";

/** 会话历史（spaceId 查询参数选择，缺省主空间）。历史只读，回写端点已移除。 */
export const createConversationRoutes = (
  dependencies: Pick<HttpDependencies, "conversationHub">,
) => {
  const { conversationHub } = dependencies;
  const app = new Hono();
  app.get("/api/conversation", async (c) => {
    const spaceId = c.req.query("spaceId") || c.req.query("threadId") || "local-main";
    try {
      const conversation = await conversationHub.findSpace(spaceId);
      return c.json(conversation?.snapshot() ?? { messages: [], revision: "empty" });
    } catch (error) {
      if (error instanceof ConversationError && (error.code === "UNSUPPORTED_SPACE" || error.code === "UNSUPPORTED_THREAD"))
        return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
      throw error;
    }
  });
  return app;
};
