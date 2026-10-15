import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { createTaskSchema, taskControlSchema } from "../contracts/rest.js";
import { presentAsyncTask, presentAsyncTaskDetail, presentJob, presentJobDetail } from "../job-presenters.js";

/** 定时任务详情与异步任务创建/控制；控制按 target 分发 job|task。 */
export const createTasksRoutes = (
  dependencies: Pick<HttpDependencies, "jobs" | "tasks" | "taskWorker" | "conversationHub" | "scheduler">,
) => {
  const { jobs, tasks, taskWorker, conversationHub, scheduler } = dependencies;
  const app = new Hono();
  app.get("/api/agent/tasks/:id", async (c) => {
    const job = await jobs.get(c.req.param("id"));
    if (job) return c.json(presentJobDetail(job));
    const task = await tasks.get(c.req.param("id"));
    return task ? c.json(presentAsyncTaskDetail(task)) : c.json({ error: "Task not found" }, 404);
  });
  // 创建异步任务（后台独立会话执行），立即 kick worker。
  app.post("/api/agent/tasks", async (c) => {
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task request" }, 400);
    const task = await tasks.create(parsed.data.prompt, "web", parsed.data.title, parsed.data.originThreadId);
    taskWorker.kick();
    return c.json(presentAsyncTask(task));
  });
  app.post("/api/agent/tasks/:id/control", async (c) => {
    const parsed = taskControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task control request" }, 400);
    if (parsed.data.target === "task") {
      // schema 已拒绝 pause/resume；显式收窄也避免以后扩展 job 动作时误映射为 cancel。
      if (parsed.data.action !== "cancel" && parsed.data.action !== "retry")
        return c.json({ error: "Invalid task control request" }, 400);
      const result = await taskWorker.control(c.req.param("id"), parsed.data.action);
      if (!result.ok)
        return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
      return c.json(presentAsyncTask(result.task));
    }
    const main = await conversationHub.forThread("local-main");
    const result = await jobs.control(c.req.param("id"), parsed.data.action, () =>
      main.isRunning() || scheduler.isBusy(),
    );
    if (!result.ok)
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    return c.json(presentJob(result.job));
  });
  return app;
};
