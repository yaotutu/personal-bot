import { z } from "zod";
import { ACTIVITY_ENTRY_TYPE, activityStatuses, type ActivityEntry, type ActivityHistory } from "../../features/activities/types.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const date = z.string().datetime();
const overview = z.object({
  id: z.string().uuid(), spaceId: z.string().optional(), threadId: z.string().optional(),
  title: z.string().max(160), goal: z.string().max(2000), deliverable: z.string().max(2000),
  status: z.enum(activityStatuses), progress: z.string().max(2000), result: z.string().max(2000).nullable(),
  runIds: z.array(z.string()), currentRunId: z.string().nullable(), createdAt: date, updatedAt: date, finishedAt: date.nullable(),
}).refine((data) => Boolean(data.spaceId || data.threadId), "spaceId or threadId required");
const step = z.object({
  id: z.string(), runId: z.string(), parentId: z.string().nullable(), kind: z.enum(["execution", "model", "tool", "subagent", "approval", "file_commit"]),
  title: z.string().max(240), status: z.enum(["running", "succeeded", "failed", "denied", "cancelled", "expired", "interrupted"]),
  startedAt: date, finishedAt: date.nullable(), result: z.string().max(2000).nullable(),
}).strict();
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("overview"), activity: overview }).strict(),
  z.object({ kind: z.literal("step"), activityId: z.string().uuid(), step }).strict(),
]);

/** 复用当前会话唯一 manager，不能从查询接口另开 writer；坏活动条目必须报错。 */
export const createActivityHistory = (manager: SessionManager): ActivityHistory => ({
  read: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ACTIVITY_ENTRY_TYPE).map((entry) => {
    const parsed = entrySchema.safeParse(entry.type === "custom" ? entry.data : undefined);
    if (!parsed.success) throw new Error("Invalid activity history; restore a valid backup before writing");
    return parsed.data as ActivityEntry;
  }),
  append: (entry) => {
    const checked = entrySchema.safeParse(entry);
    if (!checked.success) throw new Error("Invalid activity record");
    const checkpoint = manager.getLeafId();
    try { manager.appendCustomEntry(ACTIVITY_ENTRY_TYPE, checked.data); }
    catch (error) {
      if (checkpoint) manager.branch(checkpoint); else manager.resetLeaf();
      throw error;
    }
  },
});
