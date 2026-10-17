import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { once } from "node:events";
import { createService } from "./bootstrap/create-service.js";
import { loadConfig } from "./config/load-config.js";

/**
 * 探测 (host, port) 是否可绑定。仅探测一次，被占用时直接抛错，错误信息包含占用的 PID（若可查出）。
 * 由用户决定：改 server.port，或 `kill -15 <pid>` 释放端口。不会自动避让到下一个端口。
 */
const ensurePortFree = (host: string, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      const owner = lookupPortOwner(port);
      const hint = owner
        ? `Port ${port} on ${host} is held by PID ${owner}. ` +
          `Either change server.port in .personal-bot/config.json, ` +
          `or stop the process holding the port: kill -15 ${owner}`
        : `Port ${port} on ${host} is already in use. ` +
          `Either change server.port in .personal-bot/config.json, ` +
          `or stop the process that holds the port.`;
      reject(new Error(`Personal Bot cannot start. ${hint}`));
    });
    probe.once("listening", () => {
      probe.close(() => resolve(port));
    });
    probe.listen(port, host);
  });

/**
 * 通过 lsof 查端口占用的 PID。lsof 不存在或失败时返回 undefined，由调用方给出更通用的提示。
 * 限定超时 1s，避免冷启动或权限异常时阻塞主流程。
 */
const lookupPortOwner = (port: number): string | undefined => {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    const pid = output.toString().trim().split("\n")[0]?.trim();
    return pid && /^\d+$/.test(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
};

const config = loadConfig();
const service = await createService(config);
let server: ServerType | undefined;
try {
  // 端口被占用直接报错并把占用 PID 告诉用户；不会自动避让，避免用户不知道真实监听端口。
  const port = await ensurePortFree(config.host, config.port);
  server = serve(
    { fetch: service.app.fetch, hostname: config.host, port },
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
  if (!server) return Promise.resolve();
  const stopped = new Promise<void>((resolve) => {
    server!.close((error) => {
      if (error) process.exitCode = 1;
      resolve();
    });
  });
  closing = (async () => {
    try {
      await service.close();
    } finally {
      if (server && "closeIdleConnections" in server) server.closeIdleConnections();
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
