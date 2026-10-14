import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod/v3";
import type { HttpDependencies } from "../bootstrap/types.js";
import { createOpenMuseRoutes } from "../adapters/openmuse/routes.js";
import { createAgUiRoutes } from "../adapters/ag-ui/routes.js";
import { saveProfileSchema } from "./contracts/rest.js";

// 只挂载 HTTP/协议适配：使用已组装的服务，不创建 store，也不启动或关闭调度器。
export async function createHttpApp(dependencies: HttpDependencies) {
  const { config, auth, conversationHub } = dependencies;
  const runtimeRoutes = await createAgUiRoutes(conversationHub, dependencies.presentation);
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
  // 单 owner 多会话：列出已存在的 thread（按最近活跃倒序）。
  app.get("/api/threads", async (c) =>
    c.json({ threads: await conversationHub.threads() }),
  );
  // SOUL/USER 自由文本：读取与保存（下一轮 prompt 注入即生效）。
  app.get("/api/profile", async (c) => c.json(await dependencies.identity.getProfile()));
  app.put("/api/profile", async (c) => {
    const parsed = saveProfileSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) return c.json({ error: "Invalid profile request" }, 400);
    return c.json(await dependencies.identity.saveProfile(parsed.data));
  });
  // 先鉴权，再挂载兼容/运行协议，最后处理未知 API；顺序是现有安全边界。
  app.route("/", createOpenMuseRoutes(dependencies));
  app.route("/", runtimeRoutes);
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
  return app;
}
