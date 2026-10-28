import { z } from "zod";

/** 消息反馈契约：反馈只属于 spaceId+sessionId+messageId，不进入 PI 历史。 */
export const sessionIdSchema = z.string().min(1).max(128).regex(
  /^[A-Za-z0-9_-]+$/,
  "sessionId must contain only ASCII letters, digits, hyphens, and underscores",
);
export const messageTargetSchema = z.strictObject({
  sessionId: sessionIdSchema.describe("当前空间会话 ID；reset 后旧值返回 409"),
});
export const reactionRequestSchema = z.strictObject({
  sessionId: sessionIdSchema.describe("当前空间会话 ID；reset 后旧值返回 409"),
  reaction: z.enum(["like", "dislike"]).nullable().describe("互斥反应；null 表示撤销"),
});
export const createCommentRequestSchema = z.strictObject({
  sessionId: sessionIdSchema.describe("当前空间会话 ID；reset 后旧值返回 409"),
  text: z.string().trim().min(1).max(4000).describe("评论内容；服务端去除首尾空白，不能为空"),
});
export const updateCommentRequestSchema = createCommentRequestSchema;

export const messageCommentResponse = z.strictObject({
  id: z.string().uuid().describe("服务端生成的评论 ID"),
  text: z.string().min(1).max(4000).describe("当前评论文本"),
  createdAt: z.string().datetime().describe("评论创建时间（ISO 8601）"),
  updatedAt: z.string().datetime().describe("评论最后编辑时间；未编辑等于 createdAt"),
});
export const messageFeedbackResponse = z.strictObject({
  reaction: z.enum(["like", "dislike"]).nullable().describe("当前反应；null 表示未选择或已撤销"),
  comments: z.array(messageCommentResponse).describe("按创建顺序返回的多条评论"),
});
export const messageFeedbackEventsResponse = z.strictObject({
  events: z.array(z.discriminatedUnion("type", [
    z.strictObject({
      id: z.string().uuid(),
      type: z.literal("reaction_changed"),
      messageId: z.string(),
      role: z.enum(["user", "assistant"]),
      from: z.enum(["like", "dislike"]).nullable(),
      to: z.enum(["like", "dislike"]).nullable(),
      at: z.string().datetime(),
    }),
    z.strictObject({
      id: z.string().uuid(),
      type: z.literal("comment_added"),
      messageId: z.string(),
      role: z.enum(["user", "assistant"]),
      commentId: z.string().uuid(),
      text: z.string().min(1).max(4000),
      at: z.string().datetime(),
    }),
    z.strictObject({
      id: z.string().uuid(),
      type: z.literal("comment_edited"),
      messageId: z.string(),
      role: z.enum(["user", "assistant"]),
      commentId: z.string().uuid(),
      fromText: z.string().min(1).max(4000),
      toText: z.string().min(1).max(4000),
      at: z.string().datetime(),
    }),
    z.strictObject({
      id: z.string().uuid(),
      type: z.literal("comment_deleted"),
      messageId: z.string(),
      role: z.enum(["user", "assistant"]),
      commentId: z.string().uuid(),
      text: z.string().min(1).max(4000),
      at: z.string().datetime(),
    }),
  ])).describe("按真实操作顺序保留的原始事件；包含编辑前后文本和删除前文本"),
});

export const messageMetadataResponse = z.strictObject({
  createdAt: z.string().datetime().describe("对应 PI 消息条目的服务端时间（ISO 8601）"),
  source: z.enum(["chat", "job", "notification"]).nullable()
    .describe("可靠执行来源；旧历史没有来源事实时为 null，不按正文猜测"),
  runId: z.string().nullable().describe("生成该消息的 run ID；通知为 null"),
  jobId: z.string().nullable().describe("定时任务来源 ID；仅 source=job 时可能有值"),
  notificationId: z.string().nullable().describe("服务端通知标记；仅 source=notification 时有值"),
  feedbackAvailable: z.boolean().describe("当前消息是否可反馈；正在生成的 run 为 false，历史消息和幂等重放为 true"),
});

export type MessageCommentDto = z.infer<typeof messageCommentResponse>;
export type MessageFeedbackDto = z.infer<typeof messageFeedbackResponse>;
export type MessageFeedbackEventsDto = z.infer<typeof messageFeedbackEventsResponse>;
export type MessageMetadataDto = z.infer<typeof messageMetadataResponse>;
