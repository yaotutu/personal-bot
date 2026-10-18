import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { presentJob } from "../job-presenters.js";
import type { AgentSnapshotDto } from "../contracts/responses.js";

/**
 * GET /api/agent：工作台业务事实快照；完整审批载荷由专用查询提供。
 *
 * 后台任务域已下线：tasks 字段仅展示定时任务；不再提供 worker 忙闲状态。
 */
export const createSnapshotRoute = (
  dependencies: Pick<HttpDependencies, "memory" | "identity" | "jobs" | "goals" | "monitors">,
) => {
  const { memory, identity, jobs, goals, monitors } = dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    // 只投影定时任务，按 updatedAt 倒序；后台任务数据保留文件但不读取。
    const [memories, identityState, scheduledJobs, goalList, monitorList] =
      await Promise.all([
        memory.list(),
        identity.get(),
        jobs.list(),
        goals.list(),
        monitors.list(),
      ]);
    const snapshot: AgentSnapshotDto = {
      tasks: scheduledJobs.map(presentJob).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      memories,
      identity: identityState,
      goals: goalList,
      // 待投递记录属于调度器内部生命周期；响应只展示监控事实，不暴露内部补通知状态。
      monitors: monitorList.map(({ pendingNotification: _pendingNotification, ...monitor }) => monitor),
    };
    return c.json(snapshot);
  });
  return app;
};
