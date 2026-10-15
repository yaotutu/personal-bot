import type { Job } from "./types.js";

/**
 * 任务服务只依赖这两个存储端口，不知道 JSON 文件或具体数据库的存在。
 * update 的返回值允许只读操作不产生写入，从而保留“未找到任务不改文件”的边界。
 */
export type JobRepository = {
  read: () => Promise<Job[]>;
  update: <T>(
    change: (items: Job[]) => { items?: Job[]; result: T },
  ) => Promise<T>;
};
