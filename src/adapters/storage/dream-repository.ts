import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isSpaceId } from "../../features/conversation/validate-input.js";
import {
  defaultDreamState,
  type DreamRepository,
  type DreamState,
} from "../../features/dream/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import {
  threadDreamFile,
  threadDreamPromptFile,
  type DataLayout,
} from "./data-layout.js";
import { InvalidDocumentError, readDreamDocument } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";
import { readProfileFile, writeProfileFile } from "./profile-files.js";
import { readThreadInstructions, writeThreadInstructions } from "./thread-instructions.js";

const readState = async (file: string, spaceId: string): Promise<DreamState> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultDreamState(spaceId);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new InvalidDocumentError("dream");
  }
  return readDreamDocument(value);
};

export type DreamStorage = DreamRepository & {
  readGlobalPrompt: () => Promise<string>;
  writeGlobalPrompt: (content: string) => Promise<void>;
  readSpacePrompt: (spaceId: string) => Promise<string>;
  writeSpacePrompt: (spaceId: string, content: string) => Promise<void>;
  /** 启动时校验所有已有会话的 dream.json，并把崩溃遗留的 running 改为 failed。 */
  reconcileOnStart: () => Promise<void>;
};

export const createDreamRepository = (layout: DataLayout): DreamStorage => {
  const serialized = createSerializedWriter();
  const fileFor = (spaceId: string) => {
    if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
    return threadDreamFile(layout, spaceId);
  };
  const promptFor = (spaceId: string) => {
    if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
    return threadDreamPromptFile(layout, spaceId);
  };

  const read = (spaceId: string) => serialized(() => readState(fileFor(spaceId), spaceId));
  const update = <T>(
    spaceId: string,
    change: (state: DreamState) => { state?: DreamState; result: T },
    options?: { allowCreate?: boolean },
  ): Promise<T> =>
    serialized(async () => {
      const file = fileFor(spaceId);
      const dir = dirname(file);
      if (options?.allowCreate === false && spaceId !== "local-main" && !existsSync(dir)) {
        return change(defaultDreamState(spaceId)).result;
      }
      const state = await readState(file, spaceId);
      const changed = change(state);
      if (changed.state) {
        const validated = readDreamDocument(changed.state);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, validated);
      }
      return changed.result;
    });

  return {
    read,
    update,
    readGlobalPrompt: () => readProfileFile(layout.dreamFile),
    writeGlobalPrompt: async (content) => {
      await writeProfileFile(layout.dreamFile, content);
    },
    readSpacePrompt: (spaceId) => readThreadInstructions(promptFor(spaceId)),
    writeSpacePrompt: async (spaceId, content) => {
      await writeThreadInstructions(promptFor(spaceId), content);
    },
    reconcileOnStart: async () => {
      let entries;
      try {
        entries = await readdir(layout.sessionsDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("task-") || !isSpaceId(entry.name)) {
          continue;
        }
        await update(entry.name, (state) => {
          if (state.lastRun?.status !== "running") return { result: undefined };
          return {
            state: {
              ...state,
              lastRun: {
                ...state.lastRun,
                status: "failed",
                error: "Interrupted by service restart",
              },
            },
            result: undefined,
          };
        });
      }
    },
  };
};
