import { defaultIdentity } from "../../features/identity/types.js";
import type { MemoryState } from "../../features/memory/types.js";
import type { Job } from "../../features/jobs/types.js";

/** 固定安全文案，不在错误里附带原文、文件路径或用户资料。 */
export class InvalidDocumentError extends Error {
  constructor(kind: "memory" | "jobs" | "tasks" | "goals" | "actions") {
    super(`Invalid ${kind} document; restore a valid backup before writing`);
    this.name = "InvalidDocumentError";
  }
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * 明确承认旧格式：memory 对象 + 可缺省/局部 identity。
 * 条目仍按历史 reader 的 id/text 条件筛选，保留旧 partial entry 的兼容性；
 * 文档根形状/identity 字段损坏则拒绝写入，不能降级为空文档覆盖用户数据。
 * 本轮不写 schemaVersion；任何带版本字段的对象都必须由未来显式 reader 处理。
 */
export const readMemoryDocument = (value: unknown): MemoryState => {
  if (!isObject(value) || "schemaVersion" in value || !Array.isArray(value.memories))
    throw new InvalidDocumentError("memory");
  const identity = value.identity ?? {};
  if (!isObject(identity) ||
    ["name", "tone", "avatar"].some((key) => identity[key] !== undefined && typeof identity[key] !== "string") ||
    (identity.showChatUpdates !== undefined && typeof identity.showChatUpdates !== "boolean"))
    throw new InvalidDocumentError("memory");
  return {
    memories: value.memories.filter((item): item is MemoryState["memories"][number] =>
      isObject(item) && typeof item.id === "string" && typeof item.text === "string",
    ),
    identity: { ...defaultIdentity, ...identity },
  };
};

/** tasks 同为裸数组；状态枚举校验保证 worker 读到合法状态机。 */
export const readTasksDocument = (value: unknown): import("../../features/tasks/types.js").Task[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("tasks");
  const statuses = ["queued", "running", "succeeded", "failed", "cancelled"];
  return value.filter(
    (item): item is import("../../features/tasks/types.js").Task =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.prompt === "string" &&
      typeof item.status === "string" &&
      statuses.includes(item.status),
  );
};

/** jobs 继续写裸数组，不做包裹版本升级；旧条目筛选语义维持 id/prompt。 */
export const readJobsDocument = (value: unknown): Job[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("jobs");
  const jobs = value.filter((item): item is Job =>
    isObject(item) && typeof item.id === "string" && typeof item.prompt === "string",
  );
  // 只校验本轮新增的控制字段；旧 id/prompt 筛选与其他历史字段兼容语义不收紧。
  for (const job of jobs) {
    if (job.controlState !== undefined && !["paused", "cancelled", "retry_pending"].includes(job.controlState))
      throw new InvalidDocumentError("jobs");
    if (job.lastControl !== undefined && (
      !isObject(job.lastControl) ||
      !["pause", "resume", "cancel", "retry"].includes(String(job.lastControl.action)) ||
      typeof job.lastControl.at !== "string" || !Number.isFinite(Date.parse(job.lastControl.at))
    )) throw new InvalidDocumentError("jobs");
  }
  return jobs;
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

/** actions 裸数组；状态机形状校验，payload 保留字符串键值（diff 预览用）。 */
export const readActionsDocument = (
  value: unknown,
): import("../../features/actions/types.js").PendingAction[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("actions");
  const statuses = ["pending", "approved", "denied", "expired"];
  const kinds = ["file_write", "file_edit"];
  const list = value.filter(
    (item): item is import("../../features/actions/types.js").PendingAction =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.kind === "string" &&
      kinds.includes(item.kind) &&
      typeof item.status === "string" &&
      statuses.includes(item.status) &&
      isObject(item.payload),
  );
  if (list.length !== value.length) throw new InvalidDocumentError("actions");
  return list;
};
