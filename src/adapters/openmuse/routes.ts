import { MessageSchema } from "@ag-ui/core";
import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { createMemorySchema, editMemorySchema, identitySchema, conversationSchema, taskControlSchema } from "./schemas.js";
import { presentJob, presentJobDetail } from "./presenters.js";

/** 客户端兼容路由只调用业务入口，不拥有存储、会话锁或调度器。 */
export const createOpenMuseRoutes = (
  dependencies: Pick<HttpDependencies, "config" | "memory" | "identity" | "jobs" | "conversation" | "scheduler">,
) => {
  const { config, memory, identity: identityService, jobs, conversation, scheduler } = dependencies;
  const app = new Hono();
  app.get("/api/workspace", (c) =>
    c.json({
      mode: "live",
      profile: { name: "You", email: "" },
      mail: [],
      events: [],
      files: [],
      browsers: [],
      actions: [],
      activity: [],
      connections: [],
      runtime: {
        provider: "model",
        configured: config.configured,
        openbotConfigured: false,
        richThreads: false,
        serverOwnedHistory: true,
      },
    }),
  );
  app.get("/api/agent", async (c) => {
    // OpenMuse Apps 页的 Memory / Identity 界面数据源 + Activity 页任务列表。
    const [memories, identity, scheduledJobs] = await Promise.all([
      memory.list(),
      identityService.get(),
      jobs.list(),
    ]);
    const tasks = scheduledJobs.map(presentJob);
    return c.json({
      tasks,
      goals: [],
      monitors: [],
      ideas: [],
      memories,
      artifacts: [],
      notifications: [],
      identity,
      worker: { running: false },
    });
  });
  // 任务列表/详情共用投影；控制走唯一 jobs writer，不在路由内运行或重试模型。
  app.get("/api/agent/tasks/:id", async (c) => {
    const job = await jobs.get(c.req.param("id"));
    return job ? c.json(presentJobDetail(job)) : c.json({ error: "Task not found" }, 404);
  });
  app.post("/api/agent/tasks/:id/control", async (c) => {
    const parsed = taskControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid task control request" }, 400);
    const result = await jobs.control(
      c.req.param("id"), parsed.data.action,
      () => conversation.isRunning() || scheduler.isBusy(),
    );
    if (!result.ok)
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    return c.json(presentJob(result.job));
  });
  // OpenMuse Memory 界面的增/改/忘与 Identity 保存（均走 POST）。
  app.post("/api/agent/memories", async (c) => {
    const parsed = createMemorySchema
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid memory request" }, 400);
    const item = await memory.add(
      parsed.data.text,
      parsed.data.source || "Apps UI",
    );
    return c.json(item);
  });
  app.post("/api/agent/memories/:id", async (c) => {
    const parsed = editMemorySchema
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid memory request" }, 400);
    const item = await memory.edit(c.req.param("id"), parsed.data.text);
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/memories/:id/forget", async (c) => {
    const ok = await memory.forget(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/identity", async (c) => {
    const parsed = identitySchema
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid identity request" }, 400);
    return c.json(await identityService.save(parsed.data));
  });
  app.get("/api/conversation", (c) =>
    c.json({ messages: conversation.history() }),
  );
  app.put("/api/conversation", async (c) => {
    const parsed = conversationSchema
      .safeParse(await c.req.json().catch(() => undefined));
    if (
      !parsed.success ||
      parsed.data.messages.some(
        (message) => !MessageSchema.safeParse(message).success,
      )
    )
      return c.json({ error: "Invalid conversation messages" }, 400);
    // 兼容旧调用，但不信任 client assistant；一致时只确认，不一致时拒绝覆盖。
    if (
      JSON.stringify(parsed.data.messages) !==
      JSON.stringify(conversation.history())
    )
      return c.json(
        { error: "History is server-owned; GET /api/conversation to synchronize" },
        409,
      );
    return c.json({ ok: true });
  });
  return app;
};
