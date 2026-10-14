import { serve } from "@hono/node-server";
import { once } from "node:events";
import { createService } from "../src/bootstrap/create-service.js";
import { createConfig } from "../src/config/load-config.js";
import { createFakeModel } from "../tests/support/fake-model.js";

// 只用于协议/UI 联调，不读取正式 config.json，也不调用真实模型；mock 历史与正式数据隔离。
const model = await createFakeModel();
let service: Awaited<ReturnType<typeof createService>> | undefined;
let server: ReturnType<typeof serve> | undefined;
let closing: Promise<void> | undefined;
const shutdown = () => {
  if (closing) return closing;
  const stopped = new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  closing = (async () => {
    try {
      await service?.close();
    } finally {
      try {
        await model.close();
      } finally {
        if (server && "closeIdleConnections" in server) server.closeIdleConnections();
        await stopped;
      }
    }
  })();
  return closing;
};
try {
  const config = createConfig({
    schemaVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 8788,
      allowedOrigins: [
        "http://localhost:8081",
        "http://127.0.0.1:8081",
      ],
    },
    model: {
      baseUrl: model.baseUrl,
      id: "mock-model",
      // mock provider 不校验 key，但仍通过配置对象显式传递，保持唯一配置模型。
      apiKey: "mock-only",
    },
    runtime: {
      dataDir: ".personal-bot/mock",
      runTimeoutMs: 15000,
      schedulerIntervalMs: 2000,
    },
  });
  service = await createService(config);
  server = serve(
    { fetch: service.app.fetch, hostname: config.host, port: config.port },
    (info) => console.log("MOCK ONLY: http://127.0.0.1:" + info.port),
  );
  if (!server.listening) await once(server, "listening");
} catch (error) {
  // 配置、数据目录或监听初始化失败时，也不能遗留 fake provider 和 interval。
  await shutdown();
  throw error;
}
const onSignal = () => {
  void shutdown().catch(() => {
    console.error("Mock server shutdown failed");
    process.exitCode = 1;
  });
};
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
