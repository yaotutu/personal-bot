import { MessageSchema } from "@ag-ui/core";
import { Hono } from "hono";
import type { HttpDependencies } from "../bootstrap/types.js";
import {
  createMemorySchema,
  editMemorySchema,
  identitySchema,
  taskControlSchema,
} from "./contracts/rest.js";
import { conversationSchema } from "./legacy-conversation-schema.js";
import { presentJob, presentJobDetail } from "./job-presenters.js";

/**
 * 自研 Web 的业务端点（原 OpenMuse 兼容层中保留下来的部分）：
 * 工作区快照、任务（定时任务投影）与控制、记忆/身份、会话历史。
 * 兼容层独有的端点（workspace 快照、PUT conversation 回写）随兼容层移除。
 */
export const createWorkspaceRoutes = (
  dependencies: Pick<
    HttpDependencies,
    "config" | "memory" | "identity" | "jobs" | "conversationHub" | "scheduler"
  >,
) => {
  const { config, memory, identity: identityService, jobs, conversationHub, scheduler } =
    dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    const [memories, identity, scheduledJobs] = await Promise.all([
      memory.list(),
      identityService.get(),
      jobs.list(),
    ]);
    return c.json({
      tasks: scheduledJobs.map(presentJob),
      memories,
      identity,
      // goals/monitors/ideas 等域尚未实现，诚实返回空集合而不是省略字段。
      goals: [],
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
  // PUT 保留为“一致性确认”（历史客户端同步习惯）：内容必须与服务端一致。
  app.put("/api/conversation", async (c) => {
    const parsed = conversationSchema.safeParse(await c.req.json().catch(() => undefined));
    if (
      !parsed.success ||
      parsed.data.messages.some((message) => !MessageSchema.safeParse(message).success)
    )
      return c.json({ error: "Invalid conversation messages" }, 400);
    const conversation = await conversationHub.forThread("local-main");
    if (JSON.stringify(parsed.data.messages) !== JSON.stringify(conversation.history()))
      return c.json(
        { error: "History is server-owned; GET /api/conversation to synchronize" },
        409,
      );
    return c.json({ ok: true });
  });
  void config;
  return app;
};
