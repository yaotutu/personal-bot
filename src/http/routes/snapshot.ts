import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { presentAsyncTask, presentJob } from "../job-presenters.js";

/** GET /api/agent：全部域的聚合快照（Web 首屏与轮询的数据源）。 */
export const createSnapshotRoute = (
  dependencies: Pick<HttpDependencies, "memory" | "identity" | "jobs" | "goals" | "tasks" | "actions" | "monitors">,
) => {
  const { memory, identity, jobs, goals, tasks, actions, monitors } = dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    // tasks 数组混合定时任务（kind=monitor）与异步任务（kind=agent），
    // 按更新时间倒序；两者状态机不同但 DTO 同形。
    const [memories, identityState, scheduledJobs, asyncTasks, goalList, actionList, monitorList] =
      await Promise.all([
        memory.list(),
        identity.get(),
        jobs.list(),
        tasks.list(),
        goals.list(),
        actions.list(),
        monitors.list(),
      ]);
    const merged = [
      ...scheduledJobs.map(presentJob),
      ...asyncTasks.map(presentAsyncTask),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({
      tasks: merged,
      memories,
      identity: identityState,
      goals: goalList,
      monitors: monitorList,
      // 未实现域诚实返回空集合而不是省略字段。
      ideas: [],
      artifacts: [],
      notifications: actionList,
      worker: { running: false },
    });
  });
  return app;
};
