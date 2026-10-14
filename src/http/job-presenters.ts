import type { Job } from "../features/jobs/types.js";

const latestDate = (...values: (string | undefined)[]) =>
  values.filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

const presentJobStatus = (job: Job) => {
  if (job.controlState === "paused") return "paused";
  if (job.controlState === "cancelled") return "cancelled";
  if (job.controlState === "retry_pending") return "queued";
  if (job.enabled) return job.lastStatus === "failed" ? "failed" : "scheduled";
  if (!job.daily && job.lastStatus)
    return job.lastStatus === "completed" ? "succeeded" : "failed";
  return "cancelled";
};

/** OpenMuse task DTO；展示只投影 jobs，不拥有执行或持久化状态。 */
export const presentJob = (job: Job) => ({
  id: job.id,
  title: job.prompt.slice(0, 80),
  prompt: job.prompt,
  kind: "monitor" as const,
  status: presentJobStatus(job),
  plan: [], evidence: [], input: {}, state: {},
  createdAt: job.createdAt,
  updatedAt: latestDate(job.createdAt, job.lastRunAt, job.lastControl?.at) ?? job.createdAt,
  nextRunAt: job.enabled ? job.nextRunAt : undefined,
  attempts: 0, artifactIds: [], result: job.lastResult,
  error: job.lastStatus === "failed" ? "Last run failed" : null,
});

/**
 * 当前 JSON 只保存最近一次运行，不伪造多次执行步骤。
 * 每个事件 ID 由 job + 事实类型 + 时间组成，重启/刷新保持稳定。
 */
export const presentJobDetail = (job: Job) => {
  const controlTitles: Record<Job["lastControl"] extends { action: infer A } | undefined ? A & string : never, string> = { pause: "Task paused", resume: "Task resumed", cancel: "Task cancelled", retry: "Retry requested" };
  const events = [
    {
      id: `${job.id}:created`, taskId: job.id, date: job.createdAt,
      kind: "status" as const, title: "Task created", detail: "Scheduled task created.",
    },
    ...(job.lastControl ? [{
      id: `${job.id}:control:${job.lastControl.at}`, taskId: job.id,
      date: job.lastControl.at, kind: "status" as const,
      title: controlTitles[job.lastControl.action], detail: `Latest control: ${job.lastControl.action}. Pause/cancel affect future scheduling only.`,
    }] : []),
    ...(job.lastRunAt ? [{
      id: `${job.id}:run:${job.lastRunAt}`, taskId: job.id, date: job.lastRunAt,
      kind: job.lastStatus === "completed" ? "result" as const : job.lastStatus === "failed" ? "error" as const : "observation" as const,
      title: job.lastStatus === "completed" ? "Latest run succeeded" : job.lastStatus === "failed" ? "Latest run failed" : "Latest recorded run",
      detail: job.lastResult ?? "No execution result was recorded.",
    }] : []),
  ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { task: presentJob(job), events, artifacts: [], files: [], browsers: [] };
};

export type PresentedJobDetail = ReturnType<typeof presentJobDetail>;
