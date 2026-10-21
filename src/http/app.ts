import { ConversationError } from "../features/conversation/errors.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { HttpDependencies } from "../bootstrap/types.js";
import { createWorkspaceRoutes } from "./workspace-routes.js";
import { sessionRequestSchema } from "./contracts/rest.js";
import { buildOpenApiDocument } from "./openapi.js";
import { createAgUiRoutes } from "../adapters/ag-ui/routes.js";
import { saveProfileSchema } from "./contracts/rest.js";
import { createSpaceRoutes } from "./routes/spaces.js";
import { createWorkspaceEventRoutes } from "./routes/events.js";
import { serviceVersion } from "../bootstrap/service-version.js";

// 只挂载 HTTP/协议适配：使用已组装的服务，不创建 store，也不启动或关闭调度器。
export async function createHttpApp(dependencies: HttpDependencies) {
  const { config, auth, conversationHub } = dependencies;
  const version = await serviceVersion;
  const runtimeRoutes = await createAgUiRoutes(conversationHub, dependencies.presentation);
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (dependencies.lifecycle?.isClosing()) return c.json({ error: "Service is closing" }, 503);
    const leave = dependencies.lifecycle?.enter();
    try { await next(); } finally { leave?.(); }
  });
  // CORS 整体放行：所有 origin 都接受，浏览器侧鉴权由 Authorization 头 + accessKey 中间件承担，
  // 不在 origin 上做策略。origin 函数对每个请求回显具体 Origin（无 Origin 时回显 "*"），
  // 这样浏览器拿到的是它自己发的值而不是字面量 "*"，对跨域请求兼容性更好。
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_048_576,
      onError: (c) => c.json({ error: "Request body exceeds 1 MiB" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ConversationError && (error.code === "SPACE_DELETING" || error.code === "THREAD_DELETING"))
      return c.json({ error: error.message, code: error.code }, 409);
    return c.json({ error: "Internal server error" }, 500);
  });
  // ---- API 文档（自动生成，免鉴权）----
  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(version)));
  app.get("/docs", (c) => c.html(docsPage));
  app.get("/scalar.js", async (c) => {
    const file = await readScalarStandalone();
    return file
      ? c.body(file, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
      : c.text("Scalar bundle not installed; run pnpm install", 404);
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, backend: "pi", configured: config.configured, serviceVersion: version }),
  );
  app.post("/api/session", async (c) => {
    const input = sessionRequestSchema.safeParse(await c.req.json().catch(() => undefined));
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
  // SOUL/USER 自由文本：读取与保存（下一轮 prompt 注入即生效）。
  app.get("/api/profile", async (c) => c.json(await dependencies.identity.getProfile()));
  app.put("/api/profile", async (c) => {
    const parsed = saveProfileSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) return c.json({ error: "Invalid profile request" }, 400);
    return c.json(await dependencies.identity.saveProfile(parsed.data));
  });
  // 先鉴权，再挂载业务/运行协议，最后处理未知 API；顺序是现有安全边界。
  app.route("/", createWorkspaceEventRoutes(dependencies.workspaceEvents));
  app.route("/api/spaces", createSpaceRoutes(dependencies));
  app.route("/", createWorkspaceRoutes(dependencies));
  app.route("/", runtimeRoutes);
  app.all("/api/*", (c) =>
    c.json(
      {
        error:
          "This feature is not implemented",
      },
      501,
    ),
  );
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

// ---------------------------------------------------------------------------
// Scalar 文档页：本地 bundle 优先，加载失败自动回退 CDN（离线安装也可见）。
// ---------------------------------------------------------------------------
const docsPage = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pi-muse API 文档</title>
  </head>
  <body>
    <div id="app"></div>
    <script>
      (function () {
        var boot = function () {
          Scalar.createApiReference('#app', { url: '/openapi.json' });
        };
        var local = document.createElement('script');
        local.src = '/scalar.js';
        local.onload = boot;
        local.onerror = function () {
          var cdn = document.createElement('script');
          cdn.src = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
          cdn.onload = boot;
          document.head.appendChild(cdn);
        };
        document.head.appendChild(local);
      })();
    </script>
  </body>
</html>`;

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const readScalarStandalone = async (): Promise<string | undefined> => {
  // exports 映射不含 package.json；从主入口（dist/index.js）反推包根再拼浏览器构建。
  try {
    const entry = require.resolve("@scalar/api-reference");
    return await readFile(join(dirname(entry), "browser", "standalone.js"), "utf8");
  } catch {
    return undefined;
  }
};
