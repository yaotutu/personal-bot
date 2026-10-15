import { Hono } from "hono";
import type { HttpDependencies } from "../bootstrap/types.js";
import {
  createGoalSchema,
  createMemorySchema,
  createTaskSchema,
  editGoalSchema,
  editMemorySchema,
  goalStatusSchema,
  identitySchema,
  taskControlSchema,
} from "./contracts/rest.js";
import { presentAsyncTask, presentJob, presentJobDetail } from "./job-presenters.js";

/**
 * 自研 Web 的业务端点（原 OpenMuse 兼容层中保留下来的部分）：
 * 工作区快照、任务（定时任务投影）与控制、记忆/身份、会话历史。
 * 兼容层独有的端点（workspace 快照、PUT conversation 回写）随兼容层移除。
 */
export const createWorkspaceRoutes = (
  dependencies: Pick<
    HttpDependencies,
    | "config"
    | "memory"
    | "identity"
    | "jobs"
    | "goals"
    | "tasks"
    | "taskWorker"
    | "conversationHub"
    | "scheduler"
  >,
) => {
  const { config, memory, identity: identityService, jobs, goals, tasks, taskWorker, conversationHub, scheduler } =
    dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    // tasks 数组混合定时任务（kind=monitor）与异步任务（kind=agent），
    // 按更新时间倒序；两者状态机不同但 DTO 同形。
    const [memories, identity, scheduledJobs, asyncTasks, goalList] = await Promise.all([
      memory.list(),
      identityService.get(),
      jobs.list(),
      tasks.list(),
      goals.list(),
    ]);
    const merged = [
      ...scheduledJobs.map(presentJob),
      ...asyncTasks.map(presentAsyncTask),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({
      tasks: merged,
      memories,
      identity,
      // goals/monitors/ideas 等域尚未实现，诚实返回空集合而不是省略字段。
      goals: goalList,
      monitors: [],
      ideas: [],
      artifacts: [],
      notifications: [],
      worker: { running: false },
    });
  });
  app.get("/api/agent/tasks/:id", async (c) => {
    const job = await jobs.get(c.req.param("id"));
    return job ? c.json(presentJobDetail(job)) : c.json({ error: "Task not found" }, 404);
  });
  // 创建异步任务（后台独立会话执行），立即 kick worker。
  app.post("/api/agent/tasks", async (c) => {
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task request" }, 400);
    const task = await tasks.create(parsed.data.prompt, "web", parsed.data.title);
    taskWorker.kick();
    return c.json(presentAsyncTask(task));
  });
  app.post("/api/agent/tasks/:id/control", async (c) => {
    const parsed = taskControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task control request" }, 400);
    if (parsed.data.target === "task") {
      const result = await tasks.control(c.req.param("id"), parsed.data.action === "retry" ? "retry" : "cancel");
      if (result.ok) taskWorker.kick();
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
  app.post("/api/agent/goals", async (c) => {
    const parsed = createGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    return c.json(await goals.create(parsed.data));
  });
  app.post("/api/agent/goals/:id", async (c) => {
    const parsed = editGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    const goal = await goals.edit(c.req.param("id"), parsed.data);
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });
  app.post("/api/agent/goals/:id/status", async (c) => {
    const parsed = goalStatusSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal status request" }, 400);
    const goal = await goals.setStatus(c.req.param("id"), parsed.data.status);
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });
  app.post("/api/agent/goals/:id/milestones/:mid/toggle", async (c) => {
    const result = await goals.toggleMilestone(c.req.param("id"), c.req.param("mid"));
    return result.goal ? c.json(result.goal) : c.json({ error: "Not found" }, 404);
  });
  app.post("/api/agent/goals/:id/remove", async (c) => {
    const ok = await goals.remove(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Goal not found" }, 404);
  });
  app.post("/api/agent/memories", async (c) => {
    const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    return c.json(await memory.add(parsed.data.text, parsed.data.source || "Web UI"));
  });
  app.post("/api/agent/memories/:id", async (c) => {
    const parsed = editMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    const item = await memory.edit(c.req.param("id"), parsed.data.text);
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/memories/:id/forget", async (c) => {
    const ok = await memory.forget(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/identity", async (c) => {
    const parsed = identitySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid identity request" }, 400);
    return c.json(await identityService.save(parsed.data));
  });
  app.get("/api/conversation", async (c) => {
    const threadId = c.req.query("threadId") || "local-main";
    try {
      const conversation = await conversationHub.forThread(threadId);
      return c.json({ messages: conversation.history() });
    } catch {
      return c.json({ error: "Invalid threadId" }, 400);
    }
  });

  void config;
  return app;
};
