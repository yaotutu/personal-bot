import { z } from "zod";

/**
 * 审批（Approval）HTTP/SSE 契约：完整审批视图、历史摘要、终态投影、决定请求与分页。
 *
 * 边界：
 * - 审批记录只表达“人是否授权这一次操作”，不执行写操作，也不代表执行成功；
 *   实际结果以真实工具执行与 Activity 步骤为准。
 * - 预览内容在登记时固定，之后不读取当前文件替换；完整预览不截断。
 * - revision 用于版本校验：创建时为 1，进入终态时 +1；重复决定不推进版本。
 * - 待审批集合通过 SSE 直接推送；历史列表只返回已处理/失效审批的摘要，不含正文。
 * - HTTP 审批对象不带 instanceId：审批记录与 revision 跨进程持久，不随实例重启重置。
 */

/** 单项审批按 UTF-8 JSON 编码后的最大字节数（含完整预览正文）。 */
export const MAX_APPROVAL_BYTES = 1_500_000;
/** 同时存在的 pending 审批最大数量。 */
export const MAX_PENDING_APPROVALS = 32;
/** 所有 pending 审批按 UTF-8 JSON 编码后的累计最大字节数。 */
export const MAX_PENDING_APPROVAL_BYTES = 6_000_000;

const isoTime = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

const nullableThreadId = z
  .string()
  .min(1)
  .max(64)
  .nullable()
  .describe("会话标识；与当前审批无关时为 null，不推断当前上下文");

const nullableRunId = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .describe("发起审批的运行 ID；无法归属到具体运行时为 null");

const nullableRef = (label: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .describe(`${label}；未提供时为 null，不根据其他字段推断`);

export const approvalStatuses = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;

export const terminalApprovalStatuses = [
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;

export const approvalKinds = ["file_write", "file_edit"] as const;

// ---------------------------------------------------------------------------
// 完整审批视图
// ---------------------------------------------------------------------------
export const approvalPreview = z
  .strictObject({
    scope: z
      .enum(["thread", "shared"])
      .describe(
        "文件作用域：thread=当前会话私有工作区；shared=显式 shared/... 共享区。" +
          "scope=thread 时 ownerThreadId 指向文件归属的工作区会话；子代理/子会话发起的审批" +
          "仍归属其 ownerThreadId，而不是子会话自身。",
      ),
    ownerThreadId: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .describe(
        "文件归属的工作区会话 ID。scope=thread 时必填，并覆盖 child/subagent 的真实归属；" +
          "scope=shared 时为 null。",
      ),
    path: z
      .string()
      .min(1)
      .describe("相对工作区路径；不返回服务端绝对路径，也不包含父目录穿越"),
    before: z
      .string()
      .describe("审批登记时的完整原文；新建文件为空串。内容固定，不随后续文件变化替换，不截断"),
    after: z
      .string()
      .describe("审批通过后计划写入的完整内容；不截断，不能只展示摘要或差异片段"),
    beforeExists: z
      .boolean()
      .describe("登记时目标文件是否已存在；false 表示新建，不能据此推断最终落盘结果"),
  })
  .describe(
    "审批的完整、不可变预览。用于让用户看到本次将写入/替换的全部文本；" +
      "不读取当前文件内容替代历史预览，也不做截断。",
  );

export const approvalView = z
  .strictObject({
    id: z.string().min(1).describe("审批唯一 ID；同一审批在所有查询与事件中保持不变"),
    revision: z
      .number()
      .int()
      .min(1)
      .describe(
        "审批版本：创建时为 1，进入终态时 +1。内容字段不可变；" +
          "客户端按 (id, revision) 判断是否已应用最新状态，重复决定不推进版本。",
      ),
    threadId: nullableThreadId,
    runId: nullableRunId,
    toolCallId: nullableRef("发起审批的工具调用 ID"),
    subagentId: nullableRef("发起审批的子代理 ID"),
    workspaceThreadId: nullableRef("文件归属的工作区会话 ID"),
    activityId: nullableRef("关联的 Activity ID"),
    kind: z
      .enum(approvalKinds)
      .describe("file_write=新建/覆盖文件；file_edit=替换文件中的一段精确文本"),
    title: z
      .string()
      .min(1)
      .describe("人类可读的一句话摘要，如“写入 notes.md”；不包含凭据或原始工具参数"),
    status: z
      .enum(approvalStatuses)
      .describe(
        "pending=等待人的决定；approved=人已授权（不代表执行成功）；denied=人拒绝执行；" +
          "expired=超过 expiresAt 自动失效；cancelled=运行取消、断流或服务停止导致撤销。" +
          "expired/cancelled 不是人的决定，decidedAt 保持 null。",
      ),
    preview: approvalPreview,
    createdAt: isoTime.describe("审批登记时间"),
    expiresAt: isoTime.describe("授权截止时间；登记时固定，不能由轮询或客户端延长"),
    resolvedAt: isoTime
      .nullable()
      .describe("进入终态的时间；pending 为 null。expired/cancelled 也以该时间作为结束时间"),
    decidedAt: isoTime
      .nullable()
      .describe("人工 approve/deny 的时间；expired、cancelled 或仍 pending 时为 null，不伪装成人的决定"),
  })
  .describe(
    "完整审批视图：包含不可变预览全文，供用户作决定或重新查看历史。GET /api/approvals/:id 返回此形状。" +
      "单项按 UTF-8 JSON 不超过 1.5MB；所有 pending 累计不超过 6MB 且最多 32 项；" +
      "超限时服务端拒绝登记，不截断预览。HTTP 对象不带 instanceId，revision 跨进程持久。",
  );

/** 历史列表摘要：保留身份、状态与时间，省略完整预览正文。 */
export const approvalSummary = approvalView
  .omit({ preview: true })
  .describe(
    "审批历史摘要：与完整视图相同，但省略 preview，不返回文件正文。列表只包含已处理/失效审批，" +
      "当前 pending 由 SSE 推送，不混入历史列表。",
  );

/**
 * 审批终态投影：用于 approval_updated 事件。保留身份关联、revision、终态与时间，
 * 去掉 title/kind/preview，避免重复推送大正文；客户端需要完整内容时按 id 查询详情。
 */
export const approvalResolution = approvalView
  .omit({ preview: true, title: true, kind: true })
  .extend({
    status: z
      .enum(terminalApprovalStatuses)
      .describe("终态：approved/denied/expired/cancelled；该事件不会携带 pending"),
  })
  .describe(
    "审批进入终态时的轻量投影：保留 id、revision、会话/运行/工具/子代理/工作区/活动关联、" +
      "终态与 createdAt/expiresAt/resolvedAt/decidedAt；不包含 title、kind 和预览全文。" +
      "收到后按 (id, revision) 更新本地状态；未知 id 或需要完整内容时读取 GET /api/approvals/:id。",
  );

// ---------------------------------------------------------------------------
// 决定与查询
// ---------------------------------------------------------------------------
export const approvalDecisionRequest = z
  .strictObject({
    decision: z
      .enum(["approve", "deny"])
      .describe(
        "approve=授权执行预览中绑定的这一次操作，不代表执行成功；deny=不执行本次操作，" +
          "由模型决定后续处理，不自动把整项 Activity 标为失败。",
      ),
  })
  .describe(
    "POST /api/approvals/:id/decision 的请求体。只接受 approve/deny；未声明字段返回 400。" +
      "只有 pending 可决定；未知 id 返回 404，已处于其他终态返回 409。" +
      "相同决定的重复提交幂等返回原审批，不再次执行，也不推进 revision。",
  );

/**
 * 历史列表只返回已处理/失效审批；pending 通过 SSE 同步。
 * limit 使用 coerce 是为了让 query string 的 "20" 进入文档时仍呈现为 integer。
 */
export const approvalListQuery = z
  .strictObject({
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "上一页返回的 nextCursor，原样回传；首屏省略。不透明字符串，结构非法返回 400。" +
          "游标只用于分页，不代表授权仍然有效。",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("每页数量，默认 20，范围 1–100；非整数、越界或空值返回 400。"),
  })
  .describe(
    "GET /api/approvals 查询参数。只接受 cursor/limit，不接受未声明参数；" +
      "列表只包含已处理/失效审批，按最近处理时间倒序分页，不混入 pending。",
  );

export const approvalPage = z
  .strictObject({
    approvals: z
      .array(approvalSummary)
      .describe("本页审批摘要，按最近处理时间倒序；同一时间按 id 倒序"),
    hasMore: z.boolean().describe("是否还有下一页；true 时 nextCursor 非 null"),
    nextCursor: z
      .string()
      .nullable()
      .describe("下一页游标，不透明字符串；只能原样回传给 GET /api/approvals 的 cursor。没有更多时为 null"),
  })
  .describe(
    "审批历史分页结果。分页不冻结，但历史记录内容与预览在登记后不可变；" +
      "已处理/失效审批长期保留，不按时间或数量静默裁剪。",
  );

export type ApprovalPreviewDto = z.infer<typeof approvalPreview>;
export type ApprovalViewDto = z.infer<typeof approvalView>;
export type ApprovalSummaryDto = z.infer<typeof approvalSummary>;
export type ApprovalResolutionDto = z.infer<typeof approvalResolution>;
export type ApprovalDecisionRequestDto = z.infer<typeof approvalDecisionRequest>;
export type ApprovalListQueryDto = z.infer<typeof approvalListQuery>;
export type ApprovalPageDto = z.infer<typeof approvalPage>;
