import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createSerializedWriter } from "../../shared/serialized-writer.js";

const serialized = createSerializedWriter();

/** 指令缺失表示未设置；其他读取失败必须可见，不能让模型误以为原规则为空。 */
export const readThreadInstructions = async (file: string): Promise<string> => {
  try { return (await readFile(file, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

/**
 * 对话、HTTP 与 Dream 共用写入队列和原子替换；空串是显式清空，不是无参数 set 的默认动作。
 * 传入 expected 时在队列内比对读取时的内容，已被用户修改则放弃写入并返回 false。
 */
export const writeThreadInstructions = (
  file: string,
  content: string,
  expected?: string,
): Promise<boolean> => serialized(async () => {
  if (expected !== undefined && (await readThreadInstructions(file)) !== expected.trim()) {
    return false;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content.trim() + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(temporary).catch(() => undefined);
    throw error;
  }
});
