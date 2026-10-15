import type { Job } from "../features/jobs/types.js";
import type { Task } from "../features/tasks/types.js";
import type { TaskDto, TaskDetailDto, RunEventDto } from "./contracts/responses.js";

const latestDate = (...values: (string | undefined)[]) =>
  values.filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

const presentJobStatus = (job: Job): TaskDto["status"] => {
  if (job.controlState === "paused") return "paused";
  if (job.controlState === "cancelled") return "cancelled";
  if (job.controlState === "retry_pending") return "queued";
  if (job.enabled) return job.lastStatus === "failed" ? "failed" : "scheduled";
  if (!job.daily && job.lastStatus)
    return job.lastStatus === "completed" ? "succeeded" : "failed";
  return "cancelled";
};

/** 定时任务 DTO：只投影 jobs 已记录的事实，不拥有执行或持久化状态。 */
export const presentJob = (job: Job): TaskDto => ({
  id: job.id,
  title: job.prompt.slice(0, 80),
  prompt: job.prompt,
  kind: "job" as const,
  status: presentJobStatus(job),
  createdAt: job.createdAt,
  updatedAt: latestDate(job.createdAt, job.lastRunAt, job.lastControl?.at) ?? job.createdAt,
  nextRunAt: job.enabled ? job.nextRunAt : undefined,
  result: job.lastResult,
  error: job.lastStatus === "failed" ? "Last run failed" : null,
});

/**
 * 当前 JSON 只保存最近一次运行，不伪造多次执行步骤。
 * 每个事件 ID 由 job + 事实类型 + 时间组成，重启/刷新保持稳定。
 */
export const presentJobDetail = (job: Job): TaskDetailDto => {
  const controlTitles: Record<Job["lastControl"] extends { action: infer A } | undefined ? A & string : never, string> = { pause: "Task paused", resume: "Task resumed", cancel: "Task cancelled", retry: "Retry requested" };
  const events: RunEventDto[] = [
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
  return { task: presentJob(job), events };
};


/** 异步任务投影：与定时任务共用 Task DTO，kind 区分来源。 */
export const presentAsyncTask = (task: Task): TaskDto => ({
  id: task.id,
  title: task.title,
  prompt: task.prompt,
  kind: "task" as const,
  status: task.status,
  createdAt: task.createdAt,
  updatedAt: task.finishedAt ?? task.startedAt ?? task.createdAt,
  result: task.result,
  error: task.error ?? null,
});

/**
 * 异步详情只展示记录中存在的创建/开始/终态事实，不虚构完整执行步骤或重试次数。
 * 事件 ID 由任务、事实类型和时间组成，重复刷新稳定；完整工具历史仍以 pi thread 为准。
 */
export const presentAsyncTaskDetail = (task: Task): TaskDetailDto => {
  const events: RunEventDto[] = [
    {
      id: `${task.id}:created`, taskId: task.id, date: task.createdAt,
      kind: "status", title: "Task created", detail: "Background task created.",
    },
  ];
  if (task.startedAt) events.push({
    id: `${task.id}:started:${task.startedAt}`, taskId: task.id, date: task.startedAt,
    kind: "status", title: "Task started", detail: "Latest recorded background run started.",
  });
  // 终态没有完成时间时不补造时间；取消时即使存在旧结果，也不把旧结果解释为成功。
  if (task.finishedAt && ["succeeded", "failed", "cancelled"].includes(task.status)) {
    events.push({
      id: `${task.id}:finished:${task.finishedAt}`, taskId: task.id, date: task.finishedAt,
      kind: task.status === "succeeded" ? "result" : task.status === "failed" ? "error" : "status",
      title: task.status === "succeeded" ? "Latest run succeeded" : task.status === "failed" ? "Latest run failed" : "Task cancelled",
      detail: task.status === "succeeded" ? task.result ?? "No execution result was recorded."
        : task.status === "failed" ? task.error ?? "Task run failed" : "Background task cancelled.",
    });
  }
  return {
    task: presentAsyncTask(task),
    events: events.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
  };
};
