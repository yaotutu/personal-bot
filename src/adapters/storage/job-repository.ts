import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { JobRepository } from "../../features/jobs/ports.js";
import type { Job } from "../../features/jobs/types.js";
import { readJobsDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

/** 旧裸数组显式读取；损坏文件绝不默认为空列表再被后续修改覆盖。 */
const readJobs = async (file: string): Promise<Job[]> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new InvalidDocumentError("jobs"); }
  return readJobsDocument(value);
};

/**
 * 创建 JSON 文件 repository。
 * 一个实例内所有 update 共用同一队列，保证完整的读改写不会互相覆盖；
 * 写入同目录临时文件后 rename；不做跨进程锁或格式版本升级。
 */
export const createJobRepository = (file: string): JobRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readJobs(file),
    update: <T>(
      change: (jobs: Job[]) => { jobs?: Job[]; result: T },
    ): Promise<T> =>
      serialized(async () => {
        const jobs = await readJobs(file);
        const changed = change(jobs);
        // 未返回 jobs 表示纯查询或未找到目标，必须避免创建/改写文件。
        if (changed.jobs !== undefined) await writeJsonDocument(file, changed.jobs);
        return changed.result;
      }),
  };
};
