import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { defaultIdentity } from "../../features/identity/types.js";
import type { MemoryRepository, MemoryState } from "../../features/memory/types.js";

import { readMemoryDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

const emptyState = (): MemoryState => ({
  memories: [],
  identity: { ...defaultIdentity },
});

/** 只有缺失文件可以初始化；权限、JSON/形状损坏都阻止后续读改写。 */
const readState = async (file: string): Promise<MemoryState> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new InvalidDocumentError("memory"); }
  return readMemoryDocument(value);
};

/**
 * memory 与 identity 共用这一份 repository 和 writer，保证两个入口并发修改时
 * 不会各自先读到旧文件再互相覆盖；磁盘格式仍然保持 memory.json 原样。
 */
export const createMemoryRepository = (file: string, onCommitted?: () => void): MemoryRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readState(file),
    update: (change) =>
      serialized(async () => {
        const state = await readState(file);
        const changed = change(state);
        if (changed.state) {
          await writeJsonDocument(file, changed.state);
          // memory 与 identity 的通知和写锁一样共用；通知错误不回滚已落盘的数据。
          try { onCommitted?.(); } catch { /* 客户端重连后会重新同步。 */ }
        }
        return changed.result;
      }),
  };
};
