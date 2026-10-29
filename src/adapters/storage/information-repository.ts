import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isSpaceId } from "../../features/conversation/space-id.js";
import {
  defaultInformationState,
  type InformationRepository,
  type InformationState,
} from "../../features/information/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { spaceInformationFile, type DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";

const isoTime = z.string().datetime();
const itemSchema = z.strictObject({
  id: z.string().min(1).max(128),
  spaceId: z.string().min(1).max(64),
  source: z.string().min(1).max(128),
  externalId: z.string().min(1).max(256),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(20000),
  receivedAt: isoTime,
  acceptedAt: isoTime,
  status: z.enum(["pending", "processing", "processed", "failed"]),
  runId: z.string().min(1).max(128).optional(),
});
const decisionSchema = z.strictObject({
  itemId: z.string().min(1).max(128),
  decision: z.enum(["silent", "notify"]),
  reason: z.string().min(1).max(1000),
});
const receiptSchema = z.strictObject({
  notificationId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(200),
});
const publicationSchema = z.strictObject({
  notificationId: z.string().min(1).max(200),
  itemIds: z.array(z.string().min(1).max(128)).min(1),
  text: z.string().min(1).max(4000),
  status: z.enum(["pending", "published", "failed"]),
  receipt: receiptSchema.optional(),
  error: z.string().min(1).max(300).optional(),
});
const runSchema = z.strictObject({
  id: z.string().min(1).max(128),
  spaceId: z.string().min(1).max(64),
  itemIds: z.array(z.string().min(1).max(128)).min(1),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: isoTime,
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
  model: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().min(1).max(300).optional(),
  }).optional(),
  decisions: z.array(decisionSchema).optional(),
  publications: z.array(publicationSchema),
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: z.strictObject({
    enabled: z.boolean(),
    batchWindowSeconds: z.number().int().min(0).max(3600),
  }),
  preferences: z.strictObject({ notes: z.string().max(20000) }),
  items: z.array(itemSchema),
  runs: z.array(runSchema),
});

const parseState = (value: unknown, logicalFile: string): InformationState => {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid information document: ${logicalFile}`);
  return parsed.data;
};

const readState = async (file: string, logicalFile: string): Promise<InformationState> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultInformationState();
    throw error;
  }
  try {
    return parseState(JSON.parse(source), logicalFile);
  } catch {
    throw new Error(`Invalid information document: ${logicalFile}`);
  }
};

/** 信息域使用每空间一个文档和一条串行写队列；损坏文件必须阻止启动。 */
export const createInformationRepository = (layout: DataLayout): InformationRepository => {
  const serialized = createSerializedWriter();
  const fileFor = (spaceId: string) => spaceInformationFile(layout, spaceId);
  const logicalFor = (spaceId: string) => `information/${spaceId}.json`;

  const repository: InformationRepository = {
    read: (spaceId) => serialized(() => {
      if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
      return readState(fileFor(spaceId), logicalFor(spaceId));
    }),
    update: (spaceId, change, options) => serialized(async () => {
      if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
      const file = fileFor(spaceId);
      const mayCreate = options?.allowCreate === true;
      if (!mayCreate && !existsSync(file)) {
        // 后台 claim/结果写入不得重建缺失文档；显式初始化只由已验空间入口完成。
        throw new Error(`Information document not found: ${logicalFor(spaceId)}`);
      }
      const state = await readState(file, logicalFor(spaceId));
      const changed = await change(state);
      if (changed.state) {
        const validated = parseState(changed.state, logicalFor(spaceId));
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, validated);
      }
      return changed.result;
    }),
    listSpaceIds: async () => {
      let entries;
      try {
        entries = await readdir(layout.informationDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.replace(/\.json$/, ""))
        .filter(isSpaceId)
        .sort();
    },
    removeSpace: (spaceId) => serialized(async () => {
      if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
      await rm(fileFor(spaceId), { force: true });
    }),
    reconcileOnStart: async () => {
      const spaceIds = await repository.listSpaceIds();
      const now = new Date().toISOString();
      for (const spaceId of spaceIds) {
        await repository.update(spaceId, (state) => {
          let changed = false;
          const runs = state.runs.map((run) => {
            if (run.status !== "running") return run;
            changed = true;
            return {
              ...run,
              status: "failed" as const,
              finishedAt: now,
              model: { status: "failed" as const, error: "Interrupted by service restart" },
              publications: run.publications.map((publication) =>
                publication.status === "pending"
                  ? { ...publication, status: "failed" as const, error: "Interrupted by service restart" }
                  : publication,
              ),
            };
          });
          const failedRunIds = new Set(runs.filter((run) => run.status === "failed").map((run) => run.id));
          const items = state.items.map((item) => {
            if (item.status !== "processing" || !item.runId || !failedRunIds.has(item.runId)) return item;
            changed = true;
            return { ...item, status: "failed" as const };
          });
          const completedRuns = runs.map((run) => {
            if (run.status !== "completed" || !run.publications.some((publication) => publication.status === "pending")) return run;
            changed = true;
            return {
              ...run,
              publications: run.publications.map((publication) =>
                publication.status === "pending"
                  ? { ...publication, status: "failed" as const, error: "Interrupted by service restart" }
                  : publication,
              ),
            };
          });
          if (!changed) return { result: undefined };
          return { state: { ...state, items, runs: completedRuns }, result: undefined };
        });
      }
    },
    validateAll: async () => {
      for (const spaceId of await repository.listSpaceIds()) {
        await readState(fileFor(spaceId), logicalFor(spaceId));
      }
    },
  };
  return repository;
};
