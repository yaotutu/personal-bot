import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isSpaceId } from "../../features/conversation/space-id.js";
import type {
  MessageFeedbackDocument,
  MessageFeedbackRepository,
} from "../../features/messages/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { messageFeedbackFile, type DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";

const isoTime = z.string().datetime();
const reactionEvent = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("reaction_changed"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  from: z.enum(["like", "dislike"]).nullable(),
  to: z.enum(["like", "dislike"]).nullable(),
  at: isoTime,
});
const commentAdded = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_added"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  at: isoTime,
});
const commentEdited = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_edited"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  fromText: z.string().min(1).max(4000),
  toText: z.string().min(1).max(4000),
  at: isoTime,
});
const commentDeleted = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_deleted"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  at: isoTime,
});
const documentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  events: z.array(z.discriminatedUnion("type", [reactionEvent, commentAdded, commentEdited, commentDeleted])),
});

const emptyFeedbackDocument = (): MessageFeedbackDocument => ({ schemaVersion: 1, events: [] });

const parseDocument = (value: unknown, logicalFile: string): MessageFeedbackDocument => {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid message feedback document: ${logicalFile}`);
  return parsed.data;
};

const readDocument = async (file: string, logicalFile: string): Promise<MessageFeedbackDocument> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFeedbackDocument();
    throw error;
  }
  try {
    return parseDocument(JSON.parse(source), logicalFile);
  } catch {
    throw new Error(`Invalid message feedback document: ${logicalFile}`);
  }
};

/** 每个反馈文件独立原子写入；一个全局串行队列足够单进程单用户使用。 */
export const createMessageFeedbackRepository = (layout: DataLayout): MessageFeedbackRepository => {
  const serialized = createSerializedWriter();
  const fileFor = (spaceId: string, sessionId: string) => {
    if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
    return messageFeedbackFile(layout, spaceId, sessionId);
  };
  const logicalFile = (spaceId: string, sessionId: string) => `messages/${spaceId}/${sessionId}.json`;
  return {
    read: (spaceId, sessionId) => serialized(() =>
      readDocument(fileFor(spaceId, sessionId), logicalFile(spaceId, sessionId))),
    update: (spaceId, sessionId, change) => serialized(async () => {
      const file = fileFor(spaceId, sessionId);
      const document = await readDocument(file, logicalFile(spaceId, sessionId));
      const changed = change(document);
      if (changed.document) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, parseDocument(changed.document, logicalFile(spaceId, sessionId)));
      }
      return changed.result;
    }),
    removeSpace: (spaceId) => serialized(async () => {
      if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
      await rm(join(layout.messageFeedbackDir, spaceId), { recursive: true, force: true });
    }),
    validateAll: async () => {
      let spaces;
      try {
        spaces = await readdir(layout.messageFeedbackDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const space of spaces) {
        if (!space.isDirectory() || !isSpaceId(space.name)) throw new Error("Invalid message feedback layout");
        const files = await readdir(join(layout.messageFeedbackDir, space.name), { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".json")) throw new Error("Invalid message feedback layout");
          await readDocument(
            join(layout.messageFeedbackDir, space.name, file.name),
            `messages/${space.name}/${file.name}`,
          );
        }
      }
    },
  };
};
