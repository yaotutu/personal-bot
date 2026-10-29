import { z } from "zod";

export const informationSourceSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_-]{0,127}$/,
  "source must be an ASCII identifier",
);
export const informationExternalIdSchema = z.string().trim().min(1).max(256);
export const informationSettingsRequestSchema = z.strictObject({
  enabled: z.boolean().describe("是否允许新接入并调度后台处理"),
  batchWindowSeconds: z.number().int().min(0).max(3600)
    .describe("首条待处理信息到期后的聚合窗口秒数；0 表示下一轮调度立即处理"),
});
export const informationPreferencesRequestSchema = z.strictObject({
  notes: z.string().max(20000).describe("当前空间的显式偏好备注；空串等于清空，最后保存生效"),
});
export const informationIngestRequestSchema = z.strictObject({
  items: z.array(z.strictObject({
    source: informationSourceSchema.describe("通用来源标识；仅 ASCII identifier，不含短信供应商专有命名"),
    externalId: informationExternalIdSchema.describe("来源内稳定 ID；同一空间内 source+externalId 是幂等键"),
    content: z.string().min(1).max(20000).refine((value) => value.trim().length > 0).describe("原始信息正文；仅拒绝全空白，不 trim、不裁剪、不改写"),
    title: z.string().min(1).max(500).refine((value) => value.trim().length > 0).optional().describe("可选原始标题；仅拒绝全空白并按原文保存，不 trim"),
    receivedAt: z.string().datetime().optional().describe("来源时间；省略时使用服务端接纳时间"),
  })).min(1).max(50).describe("本批最多 50 条；整批校验通过后才提交"),
});
export const informationRunRequestSchema = z.strictObject({});
export const informationStatusSchema = z.enum(["pending", "processing", "processed", "failed"]);
export const informationRunStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const listQueryBase = {
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("返回数量，默认 20，范围 1–100"),
  cursor: z.string().min(1).max(1024).optional().describe("上一页返回的不透明 base64url 游标；过滤条件改变后必须重新开始"),
};
export const informationItemsQuerySchema = z.strictObject({
  ...listQueryBase,
  status: informationStatusSchema.optional().describe("只返回该状态；省略返回全部"),
});
export const informationRunsQuerySchema = z.strictObject({
  ...listQueryBase,
  status: informationRunStatusSchema.optional().describe("只返回该状态；省略返回全部"),
});
const receiptSchema = z.strictObject({
  notificationId: z.string().describe("服务端稳定通知 ID"),
  sessionId: z.string().describe("发布所在 PI 会话 ID"),
  messageId: z.string().describe("权威聊天历史中的通知消息 ID"),
});
const publicationSchema = z.strictObject({
  notificationId: z.string(),
  itemIds: z.array(z.string()),
  text: z.string(),
  status: z.enum(["pending", "published", "failed"]),
  receipt: receiptSchema.optional(),
  error: z.string().optional(),
});
const decisionSchema = z.strictObject({
  itemId: z.string(),
  decision: z.enum(["silent", "notify"]),
  reason: z.string(),
});
export const informationItemResponse = z.strictObject({
  id: z.string(),
  spaceId: z.string(),
  source: z.string(),
  externalId: z.string(),
  title: z.string().optional(),
  content: z.string(),
  receivedAt: z.string().datetime(),
  acceptedAt: z.string().datetime(),
  status: informationStatusSchema,
  runId: z.string().optional(),
});
export const informationRunResponse = z.strictObject({
  id: z.string(),
  spaceId: z.string(),
  itemIds: z.array(z.string()),
  status: informationRunStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  model: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().optional(),
  }).optional(),
  decisions: z.array(decisionSchema).optional(),
  publications: z.array(publicationSchema),
});
export const informationSettingsResponse = z.strictObject({
  enabled: z.boolean(),
  batchWindowSeconds: z.number().int().min(0).max(3600),
});
export const informationFeedbackExampleResponse = z.strictObject({
  runId: z.string(),
  notificationId: z.string(),
  text: z.string(),
  reaction: z.enum(["like", "dislike"]).nullable(),
  comments: z.array(z.string()),
  commentsTruncated: z.boolean(),
  items: z.array(z.strictObject({
    id: z.string(),
    source: z.string(),
    title: z.string().optional(),
    content: z.string(),
    contentTruncated: z.boolean(),
  })),
});
export const informationPreferencesResponse = z.strictObject({
  notes: z.string(),
  feedbackExamples: z.array(informationFeedbackExampleResponse).describe("当前会话仍可投影的最新反馈例证；回撤/编辑/删除后不保留旧结论"),
});
export const informationIngestResponse = z.strictObject({
  items: z.array(informationItemResponse).describe("本批新建或幂等回读的条目；同 key 同内容重复提交只返回一次"),
});
export const informationItemsResponse = z.strictObject({
  items: z.array(informationItemResponse),
  nextCursor: z.string().optional(),
});
export const informationItemDetailResponse = z.strictObject({
  item: informationItemResponse,
  runs: z.array(informationRunResponse),
});
export const informationRunsResponse = z.strictObject({
  runs: z.array(informationRunResponse),
  nextCursor: z.string().optional(),
});
export const informationRunDetailResponse = z.strictObject({
  run: informationRunResponse,
  items: z.array(informationItemResponse),
});
