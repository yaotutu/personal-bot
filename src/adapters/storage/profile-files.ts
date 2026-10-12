import { readFile } from "node:fs/promises";

/**
 * SOUL/USER 是自由文本输入，不和 memory.json 身份设置混合写入。
 * 保留原行为：缺失/读取失败忽略，内容去掉首尾空白，每轮由 prompt adapter 重读。
 */
export const readProfileFile = async (file: string): Promise<string> => {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
};
