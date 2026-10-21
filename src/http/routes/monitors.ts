import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  createMonitorSchema,
  monitorControlSchema,
  monitorsQuerySchema,
  updateMonitorSchema,
} from "../contracts/rest.js";
import { presentMonitor } from "../monitor-presenters.js";

/** 网页监控（Monitors）独立查询、详情、修改、控制与删除接口。 */
export const createMonitorsRoutes = (
  dependencies: Pick<HttpDependencies, "monitors" | "conversationHub">,
) => {
  const { monitors, conversationHub } = dependencies;
  const app = new Hono();

  app.get("/api/monitors", async (c) => {
    const query = monitorsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query parameters" }, 400);

    const targetSpace = query.data.spaceId ?? query.data.threadId;
    let all = await monitors.list();
    if (targetSpace) {
      all = all.filter((m) => (m.originSpaceId ?? m.originThreadId) === targetSpace);
    }

    const sortField = query.data.sort ?? "createdAt";
    const sortOrder = query.data.order ?? "desc";

    const presented = all.map(presentMonitor);
    presented.sort((a, b) => {
      let valA: string;
      let valB: string;
      if (sortField === "lastCheckedAt") {
        valA = a.lastCheckedAt ?? (sortOrder === "asc" ? "9999-12-31T23:59:59.999Z" : "");
        valB = b.lastCheckedAt ?? (sortOrder === "asc" ? "9999-12-31T23:59:59.999Z" : "");
      } else if (sortField === "status") {
        valA = a.status;
        valB = b.status;
      } else {
        valA = a.createdAt;
        valB = b.createdAt;
      }
      const cmp = sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

    return c.json({ monitors: presented });
  });

  app.get("/api/monitors/:id", async (c) => {
    const monitor = await monitors.get(c.req.param("id"));
    return monitor ? c.json(presentMonitor(monitor)) : c.json({ error: "Monitor not found" }, 404);
  });

  app.post("/api/monitors", async (c) => {
    const parsed = createMonitorSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid monitor request" }, 400);
    if (parsed.data.condition === "contains" && !parsed.data.value?.trim())
      return c.json({ error: "contains condition needs a keyword" }, 400);
    const targetSpace = parsed.data.originSpaceId ?? parsed.data.originThreadId;
    const create = async () => {
      const monitor = await monitors.create({
        ...parsed.data,
        originSpaceId: targetSpace,
        originThreadId: targetSpace,
      });
      return c.json(presentMonitor(monitor));
    };
    return targetSpace
      ? conversationHub.withSpace(targetSpace, create)
      : create();
  });

  app.post("/api/monitors/:id/control", async (c) => {
    const parsed = monitorControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid monitor control request" }, 400);
    const result = await monitors.control(c.req.param("id"), parsed.data.action);
    if (!result.ok)
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    return c.json(presentMonitor(result.monitor));
  });

  app.patch("/api/monitors/:id", async (c) => {
    const parsed = updateMonitorSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid monitor update request" }, 400);

    const existing = await monitors.get(c.req.param("id"));
    if (!existing) return c.json({ error: "Monitor not found" }, 404);

    const nextCondition = parsed.data.condition ?? existing.condition;
    const nextValue = parsed.data.value !== undefined ? parsed.data.value.trim() : existing.value;
    if (nextCondition === "contains" && !nextValue) {
      return c.json({ error: "contains condition needs a keyword" }, 400);
    }

    const targetSpace = parsed.data.originSpaceId ?? parsed.data.originThreadId;
    const update = async () => {
      const updated = await monitors.update(c.req.param("id"), {
        title: parsed.data.title,
        url: parsed.data.url,
        condition: parsed.data.condition,
        value: parsed.data.value,
        intervalMinutes: parsed.data.intervalMinutes,
        originSpaceId: targetSpace,
        originThreadId: targetSpace,
      });
      if (!updated) return c.json({ error: "Monitor not found" }, 404);
      return c.json(presentMonitor(updated));
    };

    return targetSpace
      ? conversationHub.withSpace(targetSpace, update)
      : update();
  });

  app.delete("/api/monitors/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await monitors.remove(id);
    if (!ok) return c.json({ error: "Monitor not found" }, 404);
    return c.json({ ok: true as const, id });
  });

  return app;
};
