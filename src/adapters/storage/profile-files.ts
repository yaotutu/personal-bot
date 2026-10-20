import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createSerializedWriter } from "../../shared/serialized-writer.js";

const serialized = createSerializedWriter();

/**
 * SOUL/USER/DREAM 是自由文本输入，不和 memory.json 身份设置混合写入。
 * 仅文件缺失视为空；权限等其他读取失败必须抛出，避免模型或 Dream 把
 * “读不到”误当成“内容为空”并在其上继续写入。每轮由 prompt adapter 重读。
 */
export const readProfileFile = async (file: string): Promise<string> => {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

/**
 * 保存自由文本：HTTP 与 Dream 共用同一个串行写队列与原子替换。
 * 传入 expected 时在队列内比对读取时的内容，已被用户修改则放弃写入并返回 false。
 */
export const writeProfileFile = (
  file: string,
  content: string,
  expected?: string,
): Promise<boolean> =>
  serialized(async () => {
    if (expected !== undefined && (await readProfileFile(file)) !== expected.trim()) {
      return false;
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content.trim() + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(temporary).catch(() => undefined);
      }
      throw error;
    }
  });
