import type { MemoryState } from "../../features/memory/types.js";
import type { Job } from "../../features/jobs/types.js";

/** 固定安全文案，不在错误里附带原文、文件路径或用户资料。 */
export class InvalidDocumentError extends Error {
  constructor(kind: "memory" | "jobs" | "goals" | "actions" | "monitors" | "skills-overrides" | "dream") {
    super(`Invalid ${kind} document; restore a valid backup before writing`);
    this.name = "InvalidDocumentError";
  }
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 日期字段在存储边界校验，防止无效值进入调度和状态展示。 */
const isDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalDate = (value: unknown) => value === undefined || isDate(value);

/**
 * 已存在的 memory 文档必须完整满足当前域类型；缺省只由 repository 在文件不存在时生成。
 * 任一坏条目都拒绝整个文档，禁止读改写时静默过滤并丢失原始数据。
 */
export const readMemoryDocument = (value: unknown): MemoryState => {
  if (!isObject(value) || "schemaVersion" in value || !Array.isArray(value.memories))
    throw new InvalidDocumentError("memory");
  const identity = value.identity;
  if (!isObject(identity) ||
    ["name", "tone", "avatar"].some((key) => typeof identity[key] !== "string") ||
    typeof identity.showChatUpdates !== "boolean")
    throw new InvalidDocumentError("memory");
  if (!value.memories.every((item) =>
    isObject(item) && typeof item.id === "string" && typeof item.text === "string" &&
    typeof item.source === "string" && isDate(item.createdAt) && isDate(item.updatedAt)))
    throw new InvalidDocumentError("memory");
  return value as unknown as MemoryState;
};

/** jobs 保持裸数组；不接纳缺字段记录，避免调度器读到非法时间或控制状态。 */
export const readJobsDocument = (value: unknown): Job[] => {
  if (!Array.isArray(value) || !value.every((item) =>
    isObject(item) && typeof item.id === "string" && typeof item.prompt === "string" &&
    typeof item.daily === "boolean" && typeof item.at === "string" &&
    (item.daily ? /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.at) : isDate(item.at)) &&
    typeof item.enabled === "boolean" && isDate(item.createdAt) && optionalDate(item.updatedAt) && isDate(item.nextRunAt) &&
    optionalDate(item.lastRunAt) && optionalString(item.lastResult) &&
    (item.lastStatus === undefined || (typeof item.lastStatus === "string" && ["completed", "failed"].includes(item.lastStatus))) &&
    (item.controlState === undefined || (typeof item.controlState === "string" && ["paused", "cancelled", "retry_pending"].includes(item.controlState))) &&
    (item.lastControl === undefined || (isObject(item.lastControl) &&
      typeof item.lastControl.action === "string" && ["pause", "resume", "cancel", "retry"].includes(item.lastControl.action) &&
      isDate(item.lastControl.at)))))
    throw new InvalidDocumentError("jobs");
  return value;
};

/** goals 裸数组；状态与里程碑形状校验，损坏文档整体抛错不静默清空。 */
export const readGoalsDocument = (
  value: unknown,
): import("../../features/goals/types.js").Goal[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("goals");
  const statuses = ["active", "paused", "completed", "archived"];
  const goals = value.filter(
    (item): item is import("../../features/goals/types.js").Goal =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.status === "string" &&
      statuses.includes(item.status) &&
      Array.isArray(item.milestones) &&
      item.milestones.every(
        (m) => isObject(m) && typeof m.id === "string" && typeof m.title === "string" && typeof m.done === "boolean",
      ),
  );
  if (goals.length !== value.length) throw new InvalidDocumentError("goals");
  return goals;
};

/**
 * actions 裸数组；状态机形状校验，payload 保留字符串键值（diff 预览用）。
 *
 * 当前 reader 只接受包含全部现行持久字段的记录：revision 必须为正整数，终态必须
 * 有 resolvedAt，且只有人工 approved/denied 才允许 decidedAt。缺少新字段或状态与
 * 时间字段矛盾的旧记录整体拒绝，不补默认值、不静默过滤，也不做隐式迁移。
 */
export const readActionsDocument = (
  value: unknown,
): import("../../features/actions/types.js").PendingAction[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("actions");
  const statuses = ["pending", "approved", "denied", "expired", "cancelled"];
  const kinds = ["file_write", "file_edit"];
  const actionTime = (time: unknown): time is string => isDate(time) && new Date(time).toISOString() === time;
  // 归属字段统一为 string|null；缺省同样视为损坏记录，不补默认值。
  const nullableContext = (field: unknown) => field === null || typeof field === "string";
  const isPayload = (field: unknown) =>
    isObject(field) && Object.values(field).every((entry) => typeof entry === "string");
  const validExecution = (item: Record<string, unknown>) => {
    if (item.execution === undefined) return true;
    const execution = item.execution;
    if (item.status !== "approved" || !isObject(execution) ||
      typeof execution.status !== "string" || !["running", "succeeded", "failed", "cancelled", "unknown"].includes(execution.status) ||
      !actionTime(execution.startedAt) || !(execution.result === null || typeof execution.result === "string")) return false;
    if (execution.status === "running") return execution.finishedAt === null && execution.result === null;
    return execution.status === "unknown" ? execution.finishedAt === null : actionTime(execution.finishedAt);
  };
  const isStateConsistent = (item: Record<string, unknown>) => {
    const terminal = item.status !== "pending";
    if (!terminal) return item.resolvedAt === null && item.decidedAt === null;
    if (!actionTime(item.resolvedAt)) return false;
    // 只有人的批准/拒绝记录 decidedAt；过期和撤销保持 null。
    return item.status === "approved" || item.status === "denied"
      ? actionTime(item.decidedAt)
      : item.decidedAt === null;
  };
  const list = value.filter(
    (item): item is import("../../features/actions/types.js").PendingAction =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.kind === "string" &&
      kinds.includes(item.kind) &&
      typeof item.status === "string" &&
      statuses.includes(item.status) &&
      isPayload(item.payload) &&
      typeof item.revision === "number" &&
      Number.isInteger(item.revision) &&
      item.revision >= 1 &&
      actionTime(item.createdAt) &&
      actionTime(item.expiresAt) &&
      Object.hasOwn(item, "spaceId") && nullableContext(item.spaceId) &&
      nullableContext(item.runId) &&
      nullableContext(item.toolCallId) &&
      nullableContext(item.subagentId) &&
      (Object.hasOwn(item, "workspaceSpaceId") ? nullableContext(item.workspaceSpaceId) : (Object.hasOwn(item, "workspaceThreadId") && nullableContext(item.workspaceThreadId))) &&
      nullableContext(item.activityId) &&
      isStateConsistent(item) && validExecution(item),
  );
  if (list.length !== value.length) throw new InvalidDocumentError("actions");
  return list;
};

/** monitors 裸数组；条件/状态形状校验。 */
export const readMonitorsDocument = (
  value: unknown,
): import("../../features/monitors/types.js").Monitor[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("monitors");
  const statuses = ["active", "paused", "stopped"];
  const conditions = ["change", "contains"];
  const list = value.filter(
    (item): item is import("../../features/monitors/types.js").Monitor =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.url === "string" &&
      typeof item.condition === "string" &&
      conditions.includes(item.condition) &&
      typeof item.intervalMinutes === "number" &&
      typeof item.status === "string" &&
      statuses.includes(item.status) &&
      typeof item.checks === "number",
  );
  if (list.length !== value.length) throw new InvalidDocumentError("monitors");
  return list;
};

/**
 * 会话级 Dream 状态文档（sessions/<threadId>/dream.json）。
 * 仅缺失文件由 repository 给出默认值；坏条目、schemaVersion 或未知字段一律拒绝。
 */
export const readDreamDocument = (
  value: unknown,
): import("../../features/dream/types.js").DreamState => {
  const targets = ["user", "soul", "instructions", "memory"];
  const runStatuses = ["running", "completed", "failed", "partial"];
  const reasons = ["ambiguous", "global_from_session", "no_purpose"];
  const allowedRoot = new Set(["enabled", "inheritGlobalPrompt", "cursor", "lastRun", "pending"]);
  if (
    !isObject(value) ||
    "schemaVersion" in value ||
    Object.keys(value).some((key) => !allowedRoot.has(key)) ||
    typeof value.enabled !== "boolean" ||
    typeof value.inheritGlobalPrompt !== "boolean" ||
    !(value.cursor === undefined || (typeof value.cursor === "string" && value.cursor.length > 0)) ||
    !Array.isArray(value.pending)
  ) {
    throw new InvalidDocumentError("dream");
  }
  if (value.lastRun !== undefined) {
    const run = value.lastRun;
    const allowedRun = new Set(["at", "status", "changed", "processed", "error"]);
    if (
      !isObject(run) ||
      Object.keys(run).some((key) => !allowedRun.has(key)) ||
      !isDate(run.at) ||
      typeof run.status !== "string" ||
      !runStatuses.includes(run.status) ||
      !Array.isArray(run.changed) ||
      !run.changed.every((item) => typeof item === "string" && targets.includes(item)) ||
      typeof run.processed !== "number" ||
      !Number.isInteger(run.processed) ||
      run.processed < 0 ||
      !optionalString(run.error)
    ) {
      throw new InvalidDocumentError("dream");
    }
  }
  const allowedPending = new Set(["id", "text", "suggestedTarget", "reason", "createdAt"]);
  if (
    !value.pending.every(
      (item) =>
        isObject(item) &&
        Object.keys(item).every((key) => allowedPending.has(key)) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.text === "string" &&
        item.text.length > 0 &&
        typeof item.suggestedTarget === "string" &&
        targets.includes(item.suggestedTarget) &&
        typeof item.reason === "string" &&
        reasons.includes(item.reason) &&
        isDate(item.createdAt),
    )
  ) {
    throw new InvalidDocumentError("dream");
  }
  return value as unknown as import("../../features/dream/types.js").DreamState;
};
