import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { jobControlSchema, jobsQuerySchema, updateJobSchema } from "../contracts/rest.js";
import { presentJob, presentJobDetail } from "../job-presenters.js";

/** 定时任务（Jobs）独立查询、详情、修改、控制与删除接口。 */
export const createJobsRoutes = (
  dependencies: Pick<HttpDependencies, "jobs" | "conversationHub" | "scheduler">,
) => {
  const { jobs, conversationHub, scheduler } = dependencies;
  const app = new Hono();

  app.get("/api/jobs", async (c) => {
    const query = jobsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query parameters", code: "INVALID_REQUEST" }, 400);

    const targetSpace = query.data.spaceId ?? query.data.threadId;
    let all = await jobs.list();
    if (targetSpace) {
      all = all.filter((j) => (j.originSpaceId ?? j.originThreadId) === targetSpace);
    }

    const sortField = query.data.sort ?? "nextRunAt";
    const sortOrder = query.data.order ?? (sortField === "nextRunAt" ? "asc" : "desc");

    const presented = all.map(presentJob);
    presented.sort((a, b) => {
      let valA: string;
      let valB: string;
      if (sortField === "nextRunAt") {
        valA = a.nextRunAt ?? (sortOrder === "asc" ? "9999-12-31T23:59:59.999Z" : "0000-01-01T00:00:00.000Z");
        valB = b.nextRunAt ?? (sortOrder === "asc" ? "9999-12-31T23:59:59.999Z" : "0000-01-01T00:00:00.000Z");
      } else if (sortField === "createdAt") {
        valA = a.createdAt;
        valB = b.createdAt;
      } else {
        valA = a.updatedAt;
        valB = b.updatedAt;
      }
      return sortOrder === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });

    return c.json({ jobs: presented });
  });

  app.get("/api/jobs/:id", async (c) => {
    const job = await jobs.get(c.req.param("id"));
    return job ? c.json(presentJobDetail(job)) : c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);
  });

  app.post("/api/jobs/:id/control", async (c) => {
    const parsed = jobControlSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid job control request", code: "INVALID_REQUEST" }, 400);
    const main = await conversationHub.forSpace("local-main");
    const result = await jobs.control(c.req.param("id"), parsed.data.action, () =>
      main.isRunning() || scheduler.isBusy(),
    );
    if (!result.ok)
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    return c.json(presentJob(result.job));
  });

  app.patch("/api/jobs/:id", async (c) => {
    const parsed = updateJobSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid job update request", code: "INVALID_REQUEST" }, 400);

    const existing = await jobs.get(c.req.param("id"));
    if (!existing) return c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);

    const originSpaceId = parsed.data.originSpaceId ?? parsed.data.originThreadId;
    const nextDaily = parsed.data.daily !== undefined ? parsed.data.daily : existing.daily;
    const nextAt = parsed.data.at !== undefined ? parsed.data.at.trim() : existing.at;

    if (nextDaily) {
      if (!/^\d{1,2}:\d{2}$/.test(nextAt)) {
        return c.json({ error: "Invalid HH:mm format for daily task", code: "INVALID_SCHEDULE_FORMAT" }, 400);
      }
    } else {
      if (!Number.isFinite(Date.parse(nextAt))) {
        return c.json({ error: "Invalid ISO 8601 timestamp for one-time task", code: "INVALID_SCHEDULE_FORMAT" }, 400);
      }
    }

    const updated = await jobs.update(c.req.param("id"), {
      prompt: parsed.data.prompt,
      daily: parsed.data.daily,
      at: parsed.data.at,
      originSpaceId,
    });
    if (!updated) return c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);
    return c.json(presentJob(updated));
  });

  app.delete("/api/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await jobs.remove(id);
    if (!ok) return c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);
    return c.json({ ok: true as const, id });
  });

  return app;
};
