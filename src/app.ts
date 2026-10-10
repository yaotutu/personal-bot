import { MessageSchema, RunAgentInputSchema } from "@ag-ui/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { mkdir } from "node:fs/promises";
import { z } from "zod/v3";
import { createAuth } from "./auth.js";
import type { Config } from "./config.js";
import { createConversation } from "./conversation.js";
import { createRunner, PiAgent } from "./runtime.js";

export async function createApp(config: Config) {
  // 必须在动态导入 runtime 前关闭全局 telemetry；未构造 Intelligence 或网络搜索。
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  process.env.DO_NOT_TRACK = "1";
  const { CopilotRuntime, createCopilotHonoHandler } = await import(
    "@copilotkit/runtime/v2"
  );
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const auth = await createAuth(config);
  const conversation = await createConversation(config);
  const runtime = new CopilotRuntime({
    agents: ({ request }) => ({
      default: new PiAgent(conversation, request.signal),
    }),
    runner: createRunner(conversation),
  });
  const handler = createCopilotHonoHandler({
    runtime,
    basePath: "/api/copilotkit",
  });
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: config.allowedOrigins,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError: (c) => c.json({ error: "Request body exceeds 1 MiB" }, 413),
    }),
  );
  app.onError((_error, c) => c.json({ error: "Internal server error" }, 500));
  app.get("/api/health", (c) =>
    c.json({ ok: true, backend: "pi", configured: config.configured }),
  );
  app.post("/api/session", async (c) => {
    const input = z
      .object({ accessKey: z.string().max(512).optional() })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!input.success)
      return c.json({ error: "Invalid session request" }, 400);
    const token = auth.login(input.data.accessKey);
    return token
      ? c.json({ token, mode: "live" })
      : c.json({ error: "Workspace access key is required or invalid" }, 401);
  });
  app.use("/api/*", async (c, next) => {
    if (!auth.authorized(c.req.header("Authorization")))
      return c.json({ error: "Unauthorized: open a new session" }, 401);
    await next();
  });
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
    const [memories, identity, jobs] = await Promise.all([
      conversation.memory.list(),
      conversation.memory.identity(),
      conversation.jobs.list(),
    ]);
    const tasks = jobs.map((job) => ({
      id: job.id,
      title: job.prompt.slice(0, 80),
      prompt: job.prompt,
      kind: "monitor",
      status: !job.enabled ? "cancelled" : job.lastStatus === "failed" ? "failed" : "scheduled",
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
    }));
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
  // OpenMuse Memory 界面的增/改/忘与 Identity 保存（均走 POST）。
  app.post("/api/agent/memories", async (c) => {
    const parsed = z
      .object({
        text: z.string().trim().min(1).max(2000),
        source: z.string().max(200).optional(),
      })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid memory request" }, 400);
    const item = await conversation.memory.add(
      parsed.data.text,
      parsed.data.source || "Apps UI",
    );
    return c.json(item);
  });
  app.post("/api/agent/memories/:id", async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid memory request" }, 400);
    const item = await conversation.memory.edit(c.req.param("id"), parsed.data.text);
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/memories/:id/forget", async (c) => {
    const ok = await conversation.memory.forget(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/identity", async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        tone: z.enum(["warm", "concise", "thoughtful"]).optional(),
        avatar: z.string().max(40).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid identity request" }, 400);
    return c.json(await conversation.memory.saveIdentity(parsed.data));
  });
  app.get("/api/conversation", (c) =>
    c.json({ messages: conversation.history() }),
  );
  app.put("/api/conversation", async (c) => {
    const parsed = z
      .object({ messages: z.array(z.unknown()).max(1000) })
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
        {
          error:
            "History is server-owned; GET /api/conversation to synchronize",
        },
        409,
      );
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    const path = c.req.path;
    const allowed =
      (c.req.method === "GET" && path === "/api/copilotkit/info") ||
      (c.req.method === "POST" &&
        (path === "/api/copilotkit/agent/default/run" ||
          path === "/api/copilotkit/agent/default/stop/local-main"));
    if (!allowed)
      return c.json(
        { error: "Runtime operation is not available in text-only mode" },
        501,
      );
    if (path.endsWith("/run")) {
      // SDK 自带验证，但错误日志可能打印请求内容；宿主先验证并返回清晰 JSON。
      const parsed = RunAgentInputSchema.safeParse(
        await c.req.raw
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (!parsed.success || parsed.data.messages.length > 1000)
        return c.json({ error: "Invalid AG-UI run request" }, 400);
    }
    return handler.fetch(c.req.raw);
  });
  app.all("/api/*", (c) =>
    c.json(
      {
        error:
          "This feature is not implemented; this server currently supports text conversation only",
      },
      501,
    ),
  );
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  // P4 调度器：30 秒扫一次表，到点且主会话空闲就触发一轮（结果进聊天历史）。
  // 崩了重跑哲学：错过的任务重启后被扫到自然补跑；正忙则等下一个 tick。
  const tick = async () => {
    try {
      if (conversation.isRunning()) return;
      const due = (await conversation.jobs.list()).filter(
        (job) => job.enabled && Date.now() >= Date.parse(job.nextRunAt),
      );
      for (const job of due) {
        if (conversation.isRunning()) break;
        const outcome = await conversation.trigger(
          `⏰ [定时任务] ${job.prompt}`,
          `job-${job.id}-${Date.now()}`,
        );
        await conversation.jobs.markRun(job.id, outcome.status, outcome.text);
      }
    } catch {
      // 单次 tick 失败不打断调度；任务状态由 markRun 诚实记录。
    }
  };
  const scheduler = setInterval(() => void tick(), config.schedulerIntervalMs);
  return {
    app,
    conversation,
    close: async () => {
      clearInterval(scheduler);
      await conversation.close();
    },
  };
}
