import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  createGoalSchema,
  goalsQuerySchema,
  updateGoalSchema,
} from "../contracts/rest.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

/** 长期目标（Goals）独立查询、详情、新增、修改、里程碑勾选与删除接口。 */
export const createGoalsRoutes = (
  dependencies: Pick<HttpDependencies, "goals">,
) => {
  const { goals } = dependencies;
  const app = new Hono();

  app.get("/api/goals", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid goals query" }, 400);
    const parsed = goalsQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid goals query" }, 400);

    let items = await goals.list();
    if (parsed.data.status) {
      items = items.filter((g) => g.status === parsed.data.status);
    }
    if (parsed.data.category) {
      items = items.filter((g) => g.category.toLowerCase() === parsed.data.category!.toLowerCase());
    }

    const sortField = parsed.data.sort ?? "updatedAt";
    const sortOrder = parsed.data.order ?? "desc";

    const sorted = [...items];
    sorted.sort((a, b) => {
      const valA = sortField === "createdAt" ? a.createdAt : a.updatedAt;
      const valB = sortField === "createdAt" ? b.createdAt : b.updatedAt;
      const cmp = sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

    return c.json({ goals: sorted });
  });

  app.get("/api/goals/:id", async (c) => {
    const goal = await goals.get(c.req.param("id"));
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });

  app.post("/api/goals", async (c) => {
    const parsed = createGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    return c.json(await goals.create(parsed.data));
  });

  app.patch("/api/goals/:id", async (c) => {
    const parsed = updateGoalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid goal request" }, 400);
    const goal = await goals.edit(c.req.param("id"), parsed.data);
    return goal ? c.json(goal) : c.json({ error: "Goal not found" }, 404);
  });

  app.post("/api/goals/:id/milestones/:mid/toggle", async (c) => {
    const result = await goals.toggleMilestone(c.req.param("id"), c.req.param("mid"));
    return result.goal ? c.json(result.goal) : c.json({ error: "Goal or milestone not found" }, 404);
  });

  app.delete("/api/goals/:id", async (c) => {
    const ok = await goals.remove(c.req.param("id"));
    return ok ? c.json({ ok: true as const, id: c.req.param("id") }) : c.json({ error: "Goal not found" }, 404);
  });

  return app;
};
