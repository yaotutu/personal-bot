import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 同目录临时文件写完后再替换目标；不承担重试、fsync 或跨进程锁职责。 */
export const writeJsonDocument = async (file: string, value: unknown): Promise<void> => {
  // 先在内存完成序列化，循环引用、BigInt 或 toJSON 抛错时不触碰任何文件。
  const serialized = JSON.stringify(value, null, 2);
  // undefined、函数及返回 undefined 的 toJSON 不能生成合法 JSON，同样禁止落盘。
  if (serialized === undefined) throw new TypeError("Document cannot be serialized as JSON");
  const document = serialized + "\n";
  // UUID 隔离每次写入；同目录保证 rename 不需要跨文件系统移动。
  const temporaryFile = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let temporaryFileWritten = false;

  try {
    // 排他创建避免覆盖同名文件，新文件权限仅允许当前用户读写。
    await writeFile(temporaryFile, document, { mode: 0o600, flag: "wx" });
    temporaryFileWritten = true;
    await rename(temporaryFile, file);
  } catch (error) {
    // 仅写入尚未完成时的 EEXIST 表示排他创建被拒绝，不能删除不属于本次的文件。
    // 写入完成后的 rename 即使报 EEXIST，也必须清理本次创建的临时文件。
    // 其他失败需尝试清理（包括 writeFile 可能留下的半写文件），清理错误不覆盖原错误。
    if (temporaryFileWritten || !(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      await unlink(temporaryFile).catch(() => {});
    }
    throw error;
  }
};
