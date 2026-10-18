import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { taskControlSchema } from "../contracts/rest.js";
import { presentJob, presentJobDetail } from "../job-presenters.js";

/** 定时任务详情与控制；子代理由父模型的工具调用管理，不提供任务创建接口。 */
export const createTasksRoutes = (
  dependencies: Pick<HttpDependencies, "jobs" | "conversationHub" | "scheduler">,
) => {
  const { jobs, conversationHub, scheduler } = dependencies;
  const app = new Hono();
  app.get("/api/agent/tasks/:id", async (c) => {
    const job = await jobs.get(c.req.param("id"));
    return job ? c.json(presentJobDetail(job)) : c.json({ error: "Task not found" }, 404);
  });
  // resume/retry 的忙闲检查仍在 repository 串行更新内执行，不能先读后判断。
  app.post("/api/agent/tasks/:id/control", async (c) => {
    const parsed = taskControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task control request" }, 400);
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
