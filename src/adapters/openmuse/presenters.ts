import type { Job } from "../../features/jobs/types.js";

/**
 * enabled 只表示是否继续调度，lastStatus 才表示最近一次执行结果，两者不能混为取消状态。
 * 一次性任务执行后自动停用，需将 completed 转成 OpenMuse 的 succeeded；每日任务停用
 * 则表示取消后续调度，即使有历史结果也展示 cancelled，但不清除 DTO 中的结果和错误。
 * 仍启用的任务保持原展示策略：最近失败显示 failed，其余显示 scheduled。
 */
const presentJobStatus = (job: Job) => {
  if (job.enabled) return job.lastStatus === "failed" ? "failed" : "scheduled";
  if (!job.daily && job.lastStatus) return job.lastStatus === "completed" ? "succeeded" : "failed";
  return "cancelled";
};

/** 现有 OpenMuse task DTO：展示映射不影响任务执行/持久化状态。 */
export const presentJob = (job: Job) => ({
  id: job.id,
  title: job.prompt.slice(0, 80),
  prompt: job.prompt,
  kind: "monitor",
  status: presentJobStatus(job),
  plan: [],
  evidence: [],
  input: {},
  state: {},
  createdAt: job.createdAt,
  updatedAt: job.lastRunAt ?? job.createdAt,
  nextRunAt: job.enabled ? job.nextRunAt : undefined,
  attempts: 0,
  artifactIds: [],
  result: job.lastResult,
  error: job.lastStatus === "failed" ? "Last run failed" : null,
});
