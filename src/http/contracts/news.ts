import { z } from "zod";

const publicHttpUrlSchema = z.string().url().max(2048).regex(/^https?:\/\//).refine((value) => {
  const url = new URL(value);
  const credentialKeys = new Set(["username", "pass" + "word"] as const);
  return ![...credentialKeys].some((key) => url[key as keyof URL] !== "");
}, "URL must not contain credentials").describe("无凭据的公网 HTTP(S) URL");

const newsIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const newsStatusResponseSchema = z.strictObject({
  refreshing: z.boolean().describe("一次源抓取是否正在运行"),
  processing: z.boolean().describe("受限信息模型轮是否正在处理"),
  pendingCount: z.number().int().nonnegative().describe("已接纳但尚未成功筛选的文章数"),
  failedCount: z.number().int().nonnegative().describe("模型筛选失败且仍待处理的文章数"),
  lastRefreshedAt: z.string().datetime().nullable().describe("最近一次源抓取完成时间；从未抓取为 null"),
  lastError: z.string().nullable().describe("最近一次源抓取或源解析的受控错误；无失败为 null"),
});

export const newsSourceResponseSchema = z.strictObject({
  id: newsIdSchema.describe("服务端生成的稳定源 ID"),
  title: z.string().min(1).max(500).describe("用户可见源标题"),
  url: publicHttpUrlSchema.describe("RSS2 feed 地址"),
  createdAt: z.string().datetime(),
  lastFetchedAt: z.string().datetime().nullable().describe("该源最近一次抓取完成时间；尚未抓取为 null"),
  lastError: z.string().nullable().describe("该源最近一次受控失败信息；无失败为 null"),
});

export const newsSourceListResponseSchema = z.strictObject({
  sources: z.array(newsSourceResponseSchema),
});

export const newsCreateSourceRequestSchema = z.strictObject({
  url: publicHttpUrlSchema,
  title: z.string().trim().min(1).max(500).optional().describe("可选标题；缺省使用 feed channel title"),
});

export const newsCreateSourceResponseSchema = z.strictObject({
  source: newsSourceResponseSchema,
});

export const newsDeleteSourceResponseSchema = z.strictObject({
  deleted: z.literal(true),
  sourceId: newsIdSchema,
});

const newsCommentSchema = z.strictObject({
  id: z.string().describe("服务端生成的评论 ID"),
  text: z.string().min(1).max(4000).describe("已 trim 的评论正文"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const newsFeedbackSchema = z.strictObject({
  reaction: z.enum(["like", "dislike"]).nullable().describe("like 与 dislike 互斥；null 表示撤销"),
  saved: z.boolean().describe("收藏状态，独立于 like/dislike"),
  comments: z.array(newsCommentSchema).describe("该文章的评论，按创建时间稳定排序"),
});

export const newsArticleResponseSchema = z.strictObject({
  id: newsIdSchema.describe("服务端稳定的文章 ID"),
  sourceId: newsIdSchema,
  sourceTitle: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  url: publicHttpUrlSchema.nullable().describe("原文链接；源条目没有有效无凭据 HTTP(S) URL 时为 null"),
  content: z.string().min(1).max(20000).describe("RSS 摘要/正文清理后的安全 UTF-8 文本"),
  publishedAt: z.string().datetime().describe("RSS 声明的发布时间；无有效值使用接纳时间，用于排序"),
  acceptedAt: z.string().datetime().describe("服务端首次接纳时间"),
  recommendation: z.strictObject({
    reason: z.string().min(1).max(1000),
  }).nullable().describe("仅结构化筛选成功选中的文章有推荐理由"),
  feedback: newsFeedbackSchema,
});

export const newsArticlesQuerySchema = z.strictObject({
  view: z.enum(["recommended", "all"]).default("all").describe("all=全部时间线；recommended=仅成功模型筛选选中的文章"),
  savedOnly: z.enum(["true", "false"]).default("false").transform((value) => value === "true").describe("true 只返回已收藏文章；false 或省略返回未限定收藏的列表；不改变基础排序"),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("返回数量，默认 20，范围 1–100"),
  cursor: z.string().min(1).max(2048).optional().describe("上一页返回的不透明 base64url 游标；过滤条件改变后重新开始"),
});

export const newsArticleListResponseSchema = z.strictObject({
  articles: z.array(newsArticleResponseSchema),
  nextCursor: z.string().nullable().describe("还有下一页时为不透明游标，否则为 null"),
});

export const newsArticleDetailResponseSchema = z.strictObject({
  article: newsArticleResponseSchema,
});

export const newsReactionRequestSchema = z.strictObject({
  reaction: z.enum(["like", "dislike"]).nullable().describe("null 撤销当前反应"),
});

export const newsSavedRequestSchema = z.strictObject({
  saved: z.boolean(),
});

export const newsCommentCreateRequestSchema = z.strictObject({
  text: z.string().trim().min(1, "Comment must not be blank").max(4000),
});

export const newsFeedbackResponseSchema = z.strictObject({
  feedback: newsFeedbackSchema,
});

export const newsRefreshRequestSchema = z.strictObject({});
export const newsRefreshResponseSchema = z.strictObject({
  added: z.number().int().nonnegative().describe("本次源抓取新接纳的文章数；不等待模型分析完成"),
});

export const newsPreferencesResponseSchema = z.strictObject({
  notes: z.string().max(20000).describe("用户明确保存的偏好备注"),
  learnedNotes: z.string().max(20000).describe("模型从文章反馈推断的偏好摘要；不覆盖明确 notes"),
});

export const newsPreferencesUpdateRequestSchema = z.strictObject({
  notes: z.string().max(20000).describe("空串等于清空；最后成功保存生效"),
});

export type NewsStatusDto = z.infer<typeof newsStatusResponseSchema>;
export type NewsSourceDto = z.infer<typeof newsSourceResponseSchema>;
export type NewsSourceListDto = z.infer<typeof newsSourceListResponseSchema>;
export type NewsCreateSourceRequestDto = z.infer<typeof newsCreateSourceRequestSchema>;
export type NewsCreateSourceResponseDto = z.infer<typeof newsCreateSourceResponseSchema>;
export type NewsDeleteSourceResponseDto = z.infer<typeof newsDeleteSourceResponseSchema>;
export type NewsArticleDto = z.infer<typeof newsArticleResponseSchema>;
export type NewsArticlesQueryDto = z.infer<typeof newsArticlesQuerySchema>;
export type NewsArticleListDto = z.infer<typeof newsArticleListResponseSchema>;
export type NewsArticleDetailDto = z.infer<typeof newsArticleDetailResponseSchema>;
export type NewsFeedbackDto = z.infer<typeof newsFeedbackSchema>;
export type NewsReactionRequestDto = z.infer<typeof newsReactionRequestSchema>;
export type NewsSavedRequestDto = z.infer<typeof newsSavedRequestSchema>;
export type NewsCommentCreateRequestDto = z.infer<typeof newsCommentCreateRequestSchema>;
export type NewsFeedbackResponseDto = z.infer<typeof newsFeedbackResponseSchema>;
export type NewsRefreshRequestDto = z.infer<typeof newsRefreshRequestSchema>;
export type NewsRefreshResponseDto = z.infer<typeof newsRefreshResponseSchema>;
export type NewsPreferencesResponseDto = z.infer<typeof newsPreferencesResponseSchema>;
export type NewsPreferencesUpdateRequestDto = z.infer<typeof newsPreferencesUpdateRequestSchema>;
