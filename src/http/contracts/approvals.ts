import { z } from "zod";
import type {
  PendingAction,
  SettledActionStatus,
} from "../../features/actions/types.js";

/**
 * 审批 HTTP 契约：历史分页、当前 pending、单项详情与人工决定。
 *
 * 边界：
 * - 审批只记录人的决定和工具回报的执行事实，HTTP 不执行任何写操作；
 * - approved 只表示授权一次提交，不等于文件已成功写入，实际结果看 execution；
 * - execution=null 表示尚未观察到执行，不能推断为成功；
 * - 历史游标是不透明 base64url，只在 HTTP 层编解码，业务层只处理 typed cursor。
 */

const actionKindSchema = z
  .enum(["file_write", "file_edit"])
  .describe("审批类型：file_write=写入完整文件；file_edit=替换已有文件中的一段文本。");

const actionStatusSchema = z
  .enum(["pending", "approved", "denied", "expired", "cancelled"])
  .describe(
    "审批状态：pending=等待人工决定；approved=已批准（不代表已成功执行）；denied=已拒绝；" +
      "expired=超过 expiresAt 未决定；cancelled=发起方取消或服务重启撤销。",
  );

// 历史只暴露终态；pending 有独立的当前待审批查询。
const settledStatuses = ["approved", "denied", "expired", "cancelled"] as const;
const settledStatusSchema = z
  .enum(settledStatuses)
  .describe("终态过滤值：approved/denied/expired/cancelled；pending 不是合法历史过滤值。");

const approvalTimeSchema = z
  .iso.datetime()
  .describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

const threadIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .describe("会话标识：字母或数字开头，可含 _ -，最长 64；与聊天接口的 threadId 同一字符集");

const activityIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("发起审批时关联的执行活动 ID；未关联时省略");

// ---------------------------------------------------------------------------
// 响应投影
// ---------------------------------------------------------------------------
export const approvalExecution = z
  .object({
    status: z
      .enum(["running", "succeeded", "failed", "cancelled", "unknown"])
      .describe(
        "执行状态：running=工具已开始提交；succeeded=真实写入成功；failed=提交失败；" +
          "cancelled=执行被取消；unknown=服务重启等导致无法确认结果，需人工核对文件。",
      ),
    startedAt: approvalTimeSchema.describe("工具开始执行提交的时间"),
    finishedAt: approvalTimeSchema
      .nullable()
      .describe("执行结束时间；running 或崩溃中断无法确定结束时刻时为 null，不用查询时间伪造"),
    result: z
      .string()
      .nullable()
      .describe("脱敏后的执行结果摘要；未结束或没有结果时为 null，不包含模型思维、凭据或原始日志"),
  })
  .describe(
    "审批后的真实执行事实，由受控工具回报。整个 execution 为 null 表示尚未观察到执行，" +
      "包括 pending、denied 以及 approved 后尚未开始，不能当作成功。",
  );

export const approval = z
  .object({
    id: z.string().describe("审批唯一 ID"),
    kind: actionKindSchema,
    title: z.string().describe("人类可读摘要，如“写入 notes.md”"),
    payload: z
      .record(z.string(), z.string())
      .describe(
        "登记时固定的完整预览，不截断、不随之后的文件变化更新。file_write 含 path/content/originalContent/baseVersion；" +
          "file_edit 另含 oldText/newText，其中 content 为编辑后的完整内容。",
      ),
    status: actionStatusSchema,
    createdAt: approvalTimeSchema,
    expiresAt: approvalTimeSchema.describe(
      "登记时固定的授权截止时间；过期后不能批准，也不能由客户端延长。",
    ),
    threadId: threadIdSchema
      .optional()
      .describe("发起审批的会话；仅作归属展示与审计，不代替 HTTP 鉴权"),
    runId: z.string().optional().describe("发起审批的运行 ID；未关联时省略"),
    activityId: activityIdSchema.optional(),
    toolCallId: z.string().optional().describe("产生审批的工具调用 ID；未关联时省略"),
    decidedAt: approvalTimeSchema
      .optional()
      .describe("进入终态的时间；pending 时省略"),
    execution: approvalExecution
      .nullable()
      .describe(
        "工具回报的执行事实；null 表示尚未观察到执行（pending、denied，或 approved 后尚未开始），不能视为成功。",
      ),
  })
  .describe(
    "审批完整记录。payload 是登记时的完整预览；execution 只反映工具真实回报，批准本身不等于执行成功。",
  );

export const approvalSummary = approval
  .omit({ payload: true })
  .extend({
    status: settledStatusSchema,
    decidedAt: approvalTimeSchema.describe("进入终态的时间；每条历史记录必须包含"),
  })
  .describe(
    "审批历史摘要：完整记录去掉 payload，保留 execution 与归属字段；文件正文只能从 pending 列表或单项详情读取。",
  );

export const approvalsResponse = z
  .object({
    approvals: z
      .array(approvalSummary)
      .describe("本页终态审批摘要，按 decidedAt 降序、同一时间按 id 降序"),
    hasMore: z.boolean().describe("是否还有下一页；true 时 nextCursor 非 null"),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "下一页游标，不透明 base64url；只能原样回传给 GET /api/approvals 的 cursor 参数。" +
          "它绑定生成时的 status/threadId/activityId 过滤条件，改变过滤后必须从第一页重新开始。没有更多时为 null。",
      ),
  })
  .describe("审批历史分页结果，只含终态记录，不含 pending。");

export const pendingApprovalsResponse = z
  .object({
    approvals: z
      .array(approval)
      .describe("当前仍可决定的 pending 审批，含完整 payload；已过期项不会返回"),
  })
  .describe(
    "当前待审批集合，供审批横幅和 SSE ready 后初始化；不是历史列表。",
  );

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------
export const approvalDecisionSchema = z
  .strictObject({
    decision: z
      .enum(["approve", "deny"])
      .describe("approve=批准一次挂起操作；deny=拒绝并把受控拒绝返回给模型"),
  })
  .describe("审批决定请求体；不接受额外字段，非法 body 返回 400。");

// ---------------------------------------------------------------------------
// 历史查询
// ---------------------------------------------------------------------------
/**
 * limit 走 query string，只接受十进制整数文本：拒绝空串、正负号、小数、指数与空白，
 * 再交给数字 schema 做 1–100 范围校验。用 preprocess 是为了让自动生成的
 * OpenAPI 仍把它呈现为 integer（带 default/minimum/maximum），而不是字符串。
 */
const limitSchema = z
  .preprocess(
    (value) =>
      typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : value,
    z.number().int().min(1).max(100).default(20),
  )
  .describe("每页数量，默认 20，范围 1–100；非十进制整数、越界、空值或额外参数返回 400。");

export const approvalsQuerySchema = z
  .strictObject({
    limit: limitSchema,
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        "上一页返回的 nextCursor，原样回传；首屏省略。不透明 base64url，内含上一页最后一项的 " +
          "decidedAt/id 与生成时的 status/threadId/activityId 过滤绑定。结构非法、时间非法、非规范编码或过滤条件不一致返回 400。",
      ),
    threadId: threadIdSchema
      .optional()
      .describe("只返回该来源会话发起的审批；省略表示不按会话过滤"),
    activityId: activityIdSchema
      .optional()
      .describe("只返回该执行活动关联的审批；省略表示不按活动过滤"),
    status: settledStatusSchema
      .optional()
      .describe("只返回该终态；省略表示全部终态。传 pending 返回 400。"),
  })
  .describe(
    "审批历史查询参数。不接受未声明参数；非法参数、重复参数或非法游标一律 400。",
  );

/**
 * 游标内部结构：严格对象，多字段/少字段都视为非法；时间必须是合法的 ISO 8601 UTC。
 * 游标带过滤条件，路由在解码后还要校验与本次 query 一致，避免跨过滤条件翻页。
 */
export const approvalCursorPayloadSchema = z
  .strictObject({
    decidedAt: z.iso.datetime(),
    id: z.string().min(1).max(200),
    threadId: threadIdSchema.optional(),
    activityId: activityIdSchema.optional(),
    status: settledStatusSchema.optional(),
  })
  .describe("审批分页游标结构（不透明字符串解码后的内容，不对客户端暴露为独立接口）");

// 游标过滤条件由 HTTP 层绑定，编码实现不进入 Web 共享契约。
export type ApprovalFilter = {
  threadId?: string;
  activityId?: string;
  status?: SettledActionStatus;
};

// ---------------------------------------------------------------------------
// DTO 与 presenter
// ---------------------------------------------------------------------------
export type ApprovalDto = z.infer<typeof approval>;
export type ApprovalSummaryDto = z.infer<typeof approvalSummary>;
export type ApprovalsPageDto = z.infer<typeof approvalsResponse>;
export type PendingApprovalsDto = z.infer<typeof pendingApprovalsResponse>;
export type ApprovalsQueryDto = z.infer<typeof approvalsQuerySchema>;
export type ApprovalCursorPayloadDto = z.infer<typeof approvalCursorPayloadSchema>;

/** 完整投影：execution 字段始终存在，未观察到执行时为 null。 */
export const presentApproval = (record: PendingAction): ApprovalDto => ({
  ...record,
  execution: record.execution ?? null,
});

/** 历史摘要：完整投影去掉 payload，正文只能从 pending 或单项详情取得。 */
export const presentApprovalSummary = (
  record: PendingAction,
): ApprovalSummaryDto => {
  if (record.status === "pending" || !record.decidedAt) throw new Error("Approval history requires a settled record");
  const { payload: _payload, ...summary } = presentApproval(record);
  return { ...summary, status: record.status, decidedAt: record.decidedAt };
};
