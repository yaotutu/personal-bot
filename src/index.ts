import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const service = await createApp(config);
const server = serve(
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
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await service.close();
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
