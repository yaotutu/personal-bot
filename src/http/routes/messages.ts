import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { ConversationError } from "../../features/conversation/errors.js";
import { isSpaceId } from "../../features/conversation/space-id.js";
import { MessageFeedbackDomainError, type MessageFeedbackSession } from "../../features/messages/service.js";
import {
  createCommentRequestSchema,
  messageTargetSchema,
  reactionRequestSchema,
  updateCommentRequestSchema,
} from "../contracts/messages.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

type Failure = {
  status: 400 | 404 | 409 | 503;
  body: { error: string; code: string };
};

const invalidMessageId = (value: string): boolean =>
  !value || value.length > 512 || /[\u0000-\u001f\u007f/\\]/.test(value);

const invalidCommentId = (value: string): boolean =>
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * 消息反馈 HTTP 适配。消息事实和业务规则都在 messages feature；
 * 这里只做协议校验、空间查找和领域错误到状态码的映射。
 */
export const createMessageRoutes = (
  dependencies: Pick<HttpDependencies, "conversationHub">,
) => {
  const { conversationHub } = dependencies;
  const app = new Hono();

  const domainFailure = (error: unknown): Failure | undefined => {
    if (error instanceof ConversationError && error.code === "SPACE_DELETING")
      return { status: 409, body: { error: error.message, code: error.code } };
    if (error instanceof ConversationError && error.code === "SHUTDOWN")
      return { status: 503, body: { error: error.message, code: error.code } };
    if (!(error instanceof MessageFeedbackDomainError)) return undefined;
    if (error.code === "INVALID_INPUT")
      return { status: 400, body: { error: error.message, code: "INVALID_REQUEST" } };
    if (error.code === "SESSION_CONFLICT")
      return { status: 409, body: { error: error.message, code: "SESSION_CONFLICT" } };
    return { status: 404, body: { error: error.message, code: "MESSAGE_NOT_FOUND" } };
  };
  const sessionQuery = (c: Context) => {
    const parsed = messageTargetSchema.safeParse(parseQueryObject(new URL(c.req.url)));
    return parsed.success ? parsed.data : undefined;
  };
  const execute = async (
    c: Context,
    messageId: string,
    action: (messages: MessageFeedbackSession) => Promise<unknown>,
  ): Promise<Response> => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId))
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    if (invalidMessageId(messageId))
      return c.json({ error: "Invalid messageId", code: "INVALID_REQUEST" }, 400);
    try {
      const result = await conversationHub.withExistingSpace(
        spaceId,
        (conversation) => action(conversation.messages),
      );
      if (result === undefined)
        return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
      return c.json(result);
    } catch (error) {
      const failure = domainFailure(error);
      if (failure) return c.json(failure.body, failure.status);
      throw error;
    }
  };

  app.get("/:spaceId/messages/:messageId/feedback", async (c) => {
    const sessionId = sessionQuery(c);
    if (!sessionId) return c.json({ error: "Invalid message feedback query", code: "INVALID_REQUEST" }, 400);
    return execute(c, c.req.param("messageId"), (messages) =>
      messages.get(c.req.param("messageId"), sessionId.sessionId));
  });

  app.get("/:spaceId/messages/:messageId/feedback/events", async (c) => {
    const sessionId = sessionQuery(c);
    if (!sessionId) return c.json({ error: "Invalid message feedback query", code: "INVALID_REQUEST" }, 400);
    return execute(c, c.req.param("messageId"), async (messages) => ({
      events: await messages.events(c.req.param("messageId"), sessionId.sessionId),
    }));
  });

  app.put("/:spaceId/messages/:messageId/feedback/reaction", async (c) => {
    const parsed = reactionRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid reaction request", code: "INVALID_REQUEST" }, 400);
    const body = parsed.data;
    return execute(c, c.req.param("messageId"), (messages) =>
      messages.setReaction(body.sessionId, c.req.param("messageId"), body.reaction));
  });

  app.post("/:spaceId/messages/:messageId/feedback/comments", async (c) => {
    const parsed = createCommentRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid comment request", code: "INVALID_REQUEST" }, 400);
    const body = parsed.data;
    return execute(c, c.req.param("messageId"), (messages) =>
      messages.addComment(body.sessionId, c.req.param("messageId"), body.text));
  });

  app.patch("/:spaceId/messages/:messageId/feedback/comments/:commentId", async (c) => {
    const commentId = c.req.param("commentId");
    if (invalidCommentId(commentId))
      return c.json({ error: "Invalid commentId", code: "INVALID_REQUEST" }, 400);
    const parsed = updateCommentRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid comment request", code: "INVALID_REQUEST" }, 400);
    const body = parsed.data;
    return execute(c, c.req.param("messageId"), (messages) =>
      messages.editComment(body.sessionId, c.req.param("messageId"), commentId, body.text));
  });

  app.delete("/:spaceId/messages/:messageId/feedback/comments/:commentId", async (c) => {
    const commentId = c.req.param("commentId");
    if (invalidCommentId(commentId))
      return c.json({ error: "Invalid commentId", code: "INVALID_REQUEST" }, 400);
    const sessionId = sessionQuery(c);
    if (!sessionId) return c.json({ error: "Invalid message feedback query", code: "INVALID_REQUEST" }, 400);
    return execute(c, c.req.param("messageId"), (messages) =>
      messages.deleteComment(sessionId.sessionId, c.req.param("messageId"), commentId));
  });

  return app;
};
