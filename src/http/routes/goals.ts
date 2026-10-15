import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { createGoalSchema, editGoalSchema, goalStatusSchema } from "../contracts/rest.js";

/** 目标 CRUD、状态迁移与里程碑勾选。 */
export const createGoalsRoutes = (
  dependencies: Pick<HttpDependencies, "goals">,
) => {
  const { goals } = dependencies;
  const app = new Hono();
  app.post("/api/agent/goals", async (c) => {
    const parsed = createGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    return c.json(await goals.create(parsed.data));
  });
  app.post("/api/agent/goals/:id", async (c) => {
    const parsed = editGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    const goal = await goals.edit(c.req.param("id"), parsed.data);
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });
  app.post("/api/agent/goals/:id/status", async (c) => {
    const parsed = goalStatusSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal status request" }, 400);
    const goal = await goals.setStatus(c.req.param("id"), parsed.data.status);
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });
  app.post("/api/agent/goals/:id/milestones/:mid/toggle", async (c) => {
    const result = await goals.toggleMilestone(c.req.param("id"), c.req.param("mid"));
    return result.goal ? c.json(result.goal) : c.json({ error: "Not found" }, 404);
  });
  app.post("/api/agent/goals/:id/remove", async (c) => {
    const ok = await goals.remove(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Goal not found" }, 404);
  });
  return app;
};
