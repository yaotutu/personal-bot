import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

/**
 * 裸数组 JSON 文档的通用 repository 工厂：读取校验、同实例串行读改写、
 * 原子替换（临时文件 + rename）与"纯查询不落盘"语义收敛在这一处，
 * 各域只提供文档校验函数。五个原模板复制品（goal/task/action/monitor/job）
 * 的不变量自此只有一份实现。
 */
export const createJsonArrayRepository = <T>(
  file: string,
  kind: "jobs" | "tasks" | "goals" | "actions" | "monitors",
  validate: (value: unknown) => T[],
  onCommitted?: () => void,
) => {
  const serialized = createSerializedWriter();
  const read = async (): Promise<T[]> => {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new InvalidDocumentError(kind);
    }
    return validate(value);
  };
  return {
    read,
    update: <R>(change: (items: T[]) => { items?: T[]; result: R }): Promise<R> =>
      serialized(async () => {
        const items = await read();
        const changed = change(items);
        // 未返回 items 表示纯查询或未命中，绝不创建/改写文件。
        if (changed.items !== undefined) {
          await writeJsonDocument(file, changed.items);
          // 同一提交点覆盖 HTTP、工具和调度器；通知失败不能否认已经落盘的结果。
          try { onCommitted?.(); } catch { /* 通知仅用于让客户端重新读取。 */ }
        }
        return changed.result;
      }),
  };
};
