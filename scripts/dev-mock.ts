import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createFakeModel } from "../tests/fake-model.js";

// 只用于协议/UI 联调，不读取 .env，也不调用真实模型；mock 历史与正式数据隔离。
const model = await createFakeModel();
const service = await createApp(
  loadConfig({
    PORT: process.env.PORT || "8788",
    DATA_DIR: process.env.MOCK_DATA_DIR || ".personal-bot/mock",
    PERSONAL_MODEL_BASE_URL: model.baseUrl,
    PERSONAL_MODEL_ID: "mock-model",
    PERSONAL_RUN_TIMEOUT_MS: "15000",
    ALLOWED_ORIGINS:
      process.env.ALLOWED_ORIGINS ||
      "http://localhost:8081,http://127.0.0.1:8081",
  }),
);
const server = serve(
  {
    fetch: service.app.fetch,
    hostname: "127.0.0.1",
    port: Number(process.env.PORT || 8788),
  },
  (info) => console.log("MOCK ONLY: http://127.0.0.1:" + info.port),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await service.close();
  await model.close();
  server.close();
  if ("closeIdleConnections" in server) server.closeIdleConnections();
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
