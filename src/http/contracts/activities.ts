import { z } from "zod";
import {
  activityStatuses,
  type StepKind,
  type StepStatus,
} from "../../features/activities/types.js";
import type { ActivityCursor } from "../../features/activities/query.js";

/**
 * 执行活动（Activity）的 HTTP 契约：只读查询接口的请求/响应 schema 与分页游标编解码。
 *
 * 边界：
 * - 活动记录由主模型通过工具显式登记，不是每轮对话自动生成，也不是后端猜测；
 * - 本模块只定义读取接口，创建/更新/完成活动没有 HTTP 写入口；
 * - 步骤是真实执行事件的脱敏安全投影，不包含模型思维、凭据或原始工具载荷；
 * - 游标是不透明 base64url，只在 HTTP 层编解码，业务层只处理 typed cursor。
 */

// 步骤枚举与 features/activities/types.ts 保持编译期一致；contracts 负责给枚举补文档语义。
const stepStatuses = [
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "interrupted",
] as const satisfies readonly StepStatus[];
const stepKinds = [
  "execution",
  "model",
  "tool",
  "subagent",
  "approval",
  "file_commit",
] as const satisfies readonly StepKind[];

// 编译期防漂移：features/activities/types.ts 新增步骤状态或类型时，下面的 AssertNever
// 会直接编译失败，而不是让契约静默漏掉新值（活动状态由 z.enum(activityStatuses) 自动跟随）。
type AssertNever<T extends never> = T;
type _AllStepStatusesCovered = AssertNever<Exclude<StepStatus, (typeof stepStatuses)[number]>>;
type _AllStepKindsCovered = AssertNever<Exclude<StepKind, (typeof stepKinds)[number]>>;

const activityStatusSchema = z.enum(activityStatuses).describe(
  "活动状态：running=正在执行；waiting_approval=等待人工审批；waiting_user=等待用户补充信息；" +
    "awaiting_continuation=本轮执行已结束但工作尚未完成，等待用户明确要求继续；" +
    "completed=主模型已明确声明完成且结果已交付（不可继续）；failed=执行失败；" +
    "stopped=用户停止；interrupted=服务重启或执行中断。单次工具结束、子代理返回或一轮回复结束都不会自动置为 completed。",
);

const threadIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .describe("会话标识：字母或数字开头，可含 _ -，最长 64；与聊天接口的 threadId 同一字符集");

// 活动时间由服务端 new Date().toISOString() 写入，固定 UTC（Z 后缀）。响应契约据此收紧为
// ISO 8601；features 层仍只保存字符串，不把 Date 对象跨层传递。
const activityTimeSchema = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

// ---------------------------------------------------------------------------
// 响应投影
// ---------------------------------------------------------------------------
export const activityOverview = z
  .object({
    id: z.string().describe("活动唯一 ID；继续同一项工作时保持不变，不新建活动"),
    threadId: threadIdSchema.describe("来源会话；活动随该会话删除而删除"),
    title: z.string().describe("工作标题，登记时由主模型给出"),
    goal: z.string().describe("要达成的目标"),
    deliverable: z.string().describe("完成后交付什么"),
    status: activityStatusSchema,
    progress: z.string().describe("当前关键进展或等待原因；不是聊天文本副本"),
    result: z.string().nullable().describe("最终结果/交付摘要；仅在 completed 时非 null，其余状态为 null"),
    runIds: z.array(z.string()).describe("参与过该活动的执行 run，按首次绑定顺序；继续工作会追加新 run，不新建活动"),
    currentRunId: z.string().nullable().describe("当前正在执行的 run；无执行中 run 时为 null"),
    createdAt: activityTimeSchema,
    updatedAt: activityTimeSchema,
    finishedAt: z.iso.datetime().nullable().describe("进入 completed/failed/stopped/interrupted 的已记录时间；未结束时为 null。崩溃遗留执行无法确定结束时刻时也为 null，不以查询时间伪造。"),
  })
  .describe(
    "活动概览：目标、状态、关键进展、结果与来源会话。由主模型在决定开始推进用户交办的工作时显式登记，" +
      "不是每轮消息自动创建；普通交流、解释、澄清和简单查询通常没有记录。只读投影，客户端不能写入。",
  );

export const activityStep = z
  .object({
    id: z.string().describe("步骤 ID，运行内稳定"),
    runId: z.string().describe("产生该步骤的执行 run"),
    parentId: z.string().nullable().describe("父步骤 ID；顶层执行步骤为 null"),
    kind: z.enum(stepKinds).describe(
      "步骤类型：execution=该次运行的整体执行；model=模型调用；tool=工具调用；subagent=子代理；" +
        "approval=人工审批；file_commit=实际文件提交。",
    ),
    title: z.string().describe("步骤的人类可读摘要；不包含原始工具参数全文"),
    status: z.enum(stepStatuses).describe(
      "步骤状态：running=进行中；succeeded=成功；failed=失败；denied=审批拒绝；cancelled=取消；" +
        "expired=审批过期；interrupted=执行中断。失败、拒绝、取消与中断如实保留，不伪装成功。",
    ),
    startedAt: activityTimeSchema,
    finishedAt: z.iso.datetime().nullable().describe("结束时间；仍在运行时为 null。崩溃中断且没有可信结束时刻时也为 null；继续原活动保留旧中断步骤，不将其恢复为 running。"),
    result: z.string().nullable().describe("脱敏后的结果摘要；不包含模型内部思维、凭据、原始工具载荷或未脱敏日志"),
  })
  .describe(
    "逐步明细中的一步：来自真实执行事件（工具、模型、子代理、审批与文件提交）的安全投影，" +
      "由服务端记录，不允许模型事后编造。",
  );

export const activitiesResponse = z
  .object({
    activities: z.array(activityOverview).describe("本页活动概览，按 createdAt 降序、同一时间按 id 降序"),
    hasMore: z.boolean().describe("是否还有下一页；true 时 nextCursor 非 null"),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "下一页游标，不透明 base64url；只能原样回传给 GET /api/activities 的 cursor 参数。" +
          "它绑定本次 threadId/status 过滤条件，改变过滤后必须从第一页重新开始。没有更多时为 null。",
      ),
  })
  .describe(
    "活动分页结果。分页不冻结：每次请求都读取当前投影，执行中的状态与步骤会更新；" +
      "期间新增的活动只可能出现在第一页，已读页不保证与首次读取一致。",
  );

export const activityDetailResponse = z
  .object({
    activity: activityOverview,
    steps: z
      .array(activityStep)
      .describe("该活动的全部步骤，按真实执行顺序返回；包含失败、拒绝、取消、过期与中断"),
  })
  .describe(
    "活动详情：概览＋逐步明细。只读；活动不存在或所属会话已删除时返回 404。" +
      "步骤是真实执行事件的安全投影，不开放模型思维、凭据或原始工具参数。",
  );

// ---------------------------------------------------------------------------
// 列表查询
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

export const activitiesQuerySchema = z
  .strictObject({
    limit: limitSchema,
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        "上一页返回的 nextCursor，原样回传；首屏省略。不透明 base64url，内含上一页最后一项的 " +
          "createdAt/id 与生成时的 threadId/status 过滤绑定。结构非法、时间非法或过滤条件与本次不一致返回 400。",
      ),
    threadId: threadIdSchema.optional().describe("只返回该来源会话的活动；省略表示不按会话过滤"),
    status: activityStatusSchema.optional().describe("只返回该状态的活动；省略表示不按状态过滤"),
  })
  .describe(
    "活动列表查询参数。不接受未声明参数；非法参数、重复参数或非法游标一律 400。",
  );

/**
 * 游标内部结构：严格对象，多字段/少字段都视为非法；时间必须是合法的 ISO 8601 UTC。
 * 游标带过滤条件，路由在解码后还要校验与本次 query 一致，避免跨过滤条件翻页。
 */
export const activityCursorPayloadSchema = z
  .strictObject({
    createdAt: z.iso.datetime(),
    id: z.string().min(1).max(200),
    threadId: threadIdSchema.optional(),
    status: activityStatusSchema.optional(),
  })
  .describe("活动分页游标结构（不透明字符串解码后的内容，不对客户端暴露为独立接口）");

// 自有 Web 与服务端共享的 DTO 类型，避免客户端手抄字段。
export type ActivityOverviewDto = z.infer<typeof activityOverview>;
export type ActivityStepDto = z.infer<typeof activityStep>;
export type ActivitiesPageDto = z.infer<typeof activitiesResponse>;
export type ActivityDetailDto = z.infer<typeof activityDetailResponse>;
export type ActivitiesQueryDto = z.infer<typeof activitiesQuerySchema>;
export type ActivityCursorPayloadDto = z.infer<typeof activityCursorPayloadSchema>;
