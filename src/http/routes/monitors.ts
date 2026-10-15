import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { createMonitorSchema, monitorControlSchema } from "../contracts/rest.js";

/** 网页监控创建与控制（pause/resume/stop）。 */
export const createMonitorsRoutes = (
  dependencies: Pick<HttpDependencies, "monitors">,
) => {
  const { monitors } = dependencies;
  const app = new Hono();
  app.post("/api/agent/monitors", async (c) => {
    const parsed = createMonitorSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid monitor request" }, 400);
    try {
      const { pendingNotification: _pending, ...monitor } = await monitors.create(parsed.data);
      return c.json(monitor);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });
  app.post("/api/agent/monitors/:id/control", async (c) => {
    const parsed = monitorControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid monitor control request" }, 400);
    const result = await monitors.control(c.req.param("id"), parsed.data.action);
    if (!result.ok)
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    const { pendingNotification: _pending, ...monitor } = result.monitor;
    return c.json(monitor);
  });
  return app;
};
