import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// P4 定时任务：单文件 JSON 存储 + 纯函数式 nextRun 计算。
// 设计哲学（用户定论）：崩了重跑就行——重启后到点任务自然被扫到并补跑，
// 不做断点续跑；状态诚实（completed/failed/nextRunAt）。
export type Job = {
  id: string;
  /** 到点后作为用户消息发给模型的内容。 */
  prompt: string;
  /** true = 每天 at(HH:mm 本地)；false = at 为一次性 ISO 时间。 */
  daily: boolean;
  at: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: "completed" | "failed";
  lastResult?: string;
};

async function load(dataDir: string): Promise<Job[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "jobs.json"), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter(
          (x: unknown): x is Job =>
            x !== null &&
            typeof x === "object" &&
            typeof (x as Job).id === "string" &&
            typeof (x as Job).prompt === "string",
        )
      : [];
  } catch {
    return [];
  }
}
async function save(dataDir: string, jobs: Job[]) {
  await writeFile(join(dataDir, "jobs.json"), JSON.stringify(jobs, null, 2) + "\n", {
    mode: 0o600,
  });
}
/** 计算参考时间之后的下一次运行时刻（本地时区）。 */
export function nextRunAfter(daily: boolean, at: string, after: Date): string {
  if (!daily) return new Date(at).toISOString();
  const [h, m] = at.split(":").map(Number);
  const next = new Date(after);
  next.setHours(h || 0, m || 0, 0, 0);
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export async function createJobStore(dataDir: string) {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    list: load.bind(null, dataDir),
    add: (prompt: string, daily: boolean, at: string): Promise<Job> =>
      serialized(async () => {
        const jobs = await load(dataDir);
        const job: Job = {
          id: randomUUID(),
          prompt: prompt.trim(),
          daily,
          at,
          enabled: true,
          createdAt: new Date().toISOString(),
          nextRunAt: nextRunAfter(daily, at, new Date()),
        };
        jobs.push(job);
        await save(dataDir, jobs);
        return job;
      }),
    cancel: (id: string): Promise<boolean> =>
      serialized(async () => {
        const jobs = await load(dataDir);
        const job = jobs.find((x) => x.id === id);
        if (!job) return false;
        job.enabled = false;
        await save(dataDir, jobs);
        return true;
      }),
    /** 一次运行结束：daily 推进下一轮；一次性任务关闭。 */
    markRun: (
      id: string,
      status: "completed" | "failed",
      result: string,
    ): Promise<Job | undefined> =>
      serialized(async () => {
        const jobs = await load(dataDir);
        const job = jobs.find((x) => x.id === id);
        if (!job) return undefined;
        job.lastRunAt = new Date().toISOString();
        job.lastStatus = status;
        job.lastResult = result.slice(0, 2000);
        if (job.daily) job.nextRunAt = nextRunAfter(true, job.at, new Date());
        else job.enabled = false;
        await save(dataDir, jobs);
        return job;
      }),
  };
}
export type JobStore = Awaited<ReturnType<typeof createJobStore>>;
