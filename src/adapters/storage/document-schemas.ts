import type { MemoryState } from "../../features/memory/types.js";
import type { Job } from "../../features/jobs/types.js";

/** 固定安全文案，不在错误里附带原文、文件路径或用户资料。 */
export class InvalidDocumentError extends Error {
  constructor(kind: "memory" | "jobs" | "goals" | "actions" | "monitors" | "skills-overrides") {
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
    typeof item.enabled === "boolean" && isDate(item.createdAt) && isDate(item.nextRunAt) &&
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

/** actions 保留裸数组和完整字符串预览；决定与执行分别校验，不能补造缺失的决定时间。 */
export const readActionsDocument = (
  value: unknown,
): import("../../features/actions/types.js").PendingAction[] => {
  const statuses = ["pending", "approved", "denied", "expired", "cancelled"];
  const kinds = ["file_write", "file_edit"];
  const executionStatuses = ["running", "succeeded", "failed", "cancelled", "unknown"];
  const isApprovalTime = (time: unknown): time is string => isDate(time) && new Date(time).toISOString() === time;
  if (!Array.isArray(value) || !value.every((item) => {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || typeof item.title !== "string" ||
      typeof item.kind !== "string" || !kinds.includes(item.kind) ||
      typeof item.status !== "string" || !statuses.includes(item.status) ||
      !isObject(item.payload) || !Object.values(item.payload).every((text) => typeof text === "string") ||
      !isApprovalTime(item.createdAt) || !isApprovalTime(item.expiresAt) ||
      (item.status === "pending" ? item.decidedAt !== undefined : !isApprovalTime(item.decidedAt)) ||
      ![item.threadId, item.runId, item.activityId, item.toolCallId].every(optionalString)) return false;
    if (item.execution === undefined) return true;
    const execution = item.execution;
    if (item.status !== "approved" || !isObject(execution) ||
      typeof execution.status !== "string" || !executionStatuses.includes(execution.status) ||
      !isApprovalTime(execution.startedAt) ||
      !(execution.result === null || typeof execution.result === "string")) return false;
    if (execution.status === "running") return execution.finishedAt === null && execution.result === null;
    return execution.status === "unknown"
      ? execution.finishedAt === null || isApprovalTime(execution.finishedAt)
      : isApprovalTime(execution.finishedAt);
  })) throw new InvalidDocumentError("actions");
  return value;
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
