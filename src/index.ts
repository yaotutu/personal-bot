import { serve } from "@hono/node-server";
import { once } from "node:events";
import { createService } from "./bootstrap/create-service.js";
import { loadConfig } from "./config/load-config.js";

const config = loadConfig();
const service = await createService(config);
let server: ReturnType<typeof serve>;
try {
  server = serve(
    { fetch: service.app.fetch, hostname: config.host, port: config.port },
    (info) => {
      console.log(
        "Personal Bot listening on http://" +
          config.host +
          ":" +
          info.port +
          "; model " +
          (config.configured ? "configured" : "not configured"),
      );
    },
  );
  // once 同时处理监听失败；端口被占用时也释放已经创建的调度器。
  if (!server.listening) await once(server, "listening");
} catch (error) {
  await service.close();
  throw error;
}
let closing: Promise<void> | undefined;
const shutdown = () => {
  if (closing) return closing;
  // 先停止接收新连接，再取消会话；最后等 HTTP 连接和调度写入全部结束。
  const stopped = new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) process.exitCode = 1;
      resolve();
    });
  });
  closing = (async () => {
    try {
      await service.close();
    } finally {
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      await stopped;
    }
  })();
  return closing;
};
const onSignal = () => {
  void shutdown().catch(() => {
    console.error("Personal Bot shutdown failed");
    process.exitCode = 1;
  });
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
