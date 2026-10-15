import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { presentAsyncTask, presentJob } from "../job-presenters.js";
import type { AgentSnapshotDto } from "../contracts/responses.js";

/** GET /api/agent：工作台业务事实快照；完整审批载荷由专用查询提供。 */
export const createSnapshotRoute = (
  dependencies: Pick<HttpDependencies, "memory" | "identity" | "jobs" | "goals" | "tasks" | "monitors" | "taskWorker">,
) => {
  const { memory, identity, jobs, goals, tasks, monitors, taskWorker } = dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    // tasks 数组混合定时任务（kind=job）与异步任务（kind=task），
    // 按更新时间倒序；两者状态机不同但 DTO 同形。
    const [memories, identityState, scheduledJobs, asyncTasks, goalList, monitorList] =
      await Promise.all([
        memory.list(),
        identity.get(),
        jobs.list(),
        tasks.list(),
        goals.list(),
        monitors.list(),
      ]);
    const merged = [
      ...scheduledJobs.map(presentJob),
      ...asyncTasks.map(presentAsyncTask),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const snapshot: AgentSnapshotDto = {
      tasks: merged,
      memories,
      identity: identityState,
      goals: goalList,
      // 待投递记录属于调度器内部生命周期；响应只展示监控事实，不暴露内部补通知状态。
      monitors: monitorList.map(({ pendingNotification: _pendingNotification, ...monitor }) => monitor),
      // 在完成异步数据读取后采样真实 worker；不缓存也不根据任务状态猜测执行状态。
      worker: { running: taskWorker.isRunning() },
    };
    return c.json(snapshot);
  });
  return app;
};
