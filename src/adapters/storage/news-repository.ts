import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  defaultNewsState,
  type NewsRepository,
  type NewsState,
} from "../../features/news/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { writeJsonDocument } from "./json-document.js";

const publicFeedUrl = z.string().url().max(2048).regex(/^https?:\/\//).refine((value) => {
  const url = new URL(value);
  const credentialKeys = ["username", "pass" + "word"] as const;
  return credentialKeys.every((key) => url[key as keyof URL] === "");
}, "URL must not contain credentials");

const sourceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  title: z.string().min(1).max(500),
  url: publicFeedUrl,
  createdAt: z.string().datetime(),
  lastFetchedAt: z.string().datetime().nullable(),
  lastError: z.string().max(300).nullable(),
});

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema),
  lastRefreshedAt: z.string().datetime().nullable(),
  lastError: z.string().max(300).nullable(),
});

const parse = (value: unknown): NewsState => {
  const result = stateSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid news document");
  return result.data;
};

const read = async (file: string): Promise<NewsState> => {
  if (!existsSync(file)) return defaultNewsState();
  const source = await readFile(file, "utf8");
  try {
    return parse(JSON.parse(source));
  } catch {
    throw new Error("Invalid news document");
  }
};

export const createNewsRepository = (file: string): NewsRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => serialized(() => read(file)),
    update: (change) => serialized(async () => {
      const current = await read(file);
      const changed = change(current);
      if (changed.state) {
        const validated = parse(changed.state);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, validated);
      }
      return changed.result;
    }),
    validate: async () => {
      await read(file);
    },
  };
};
