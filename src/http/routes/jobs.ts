import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { jobControlSchema, jobsQuerySchema, updateJobSchema } from "../contracts/rest.js";
import { presentJob, presentJobDetail } from "../job-presenters.js";
import {
  assertValidSchedule,
  InvalidScheduleError,
} from "../../features/jobs/schedule-calculator.js";

/** 定时任务（Jobs）独立查询、详情、修改、控制与删除接口。 */
export const createJobsRoutes = (
  dependencies: Pick<HttpDependencies, "jobs" | "conversationHub" | "scheduler">,
) => {
  const { jobs, conversationHub, scheduler } = dependencies;
  const app = new Hono();

  app.get("/api/jobs", async (c) => {
    const query = jobsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid query parameters", code: "INVALID_REQUEST" }, 400);

    const targetSpace = query.data.spaceId;
    let all = await jobs.list();
    if (targetSpace) {
      all = all.filter((j) => (j.originSpaceId ?? "local-main") === targetSpace);
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
    const existing = await jobs.get(c.req.param("id"));
    if (!existing) return c.json({ error: "Task not found" }, 404);
    const targetSpace = existing.originSpaceId ?? "local-main";
    const spaceConversation = await conversationHub.forSpace(targetSpace);
    const result = await jobs.control(c.req.param("id"), parsed.data.action, () =>
      spaceConversation.isRunning() || scheduler.isBusy(),
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

    const originSpaceId = parsed.data.originSpaceId;
    const nextDaily = parsed.data.daily !== undefined ? parsed.data.daily : existing.daily;
    const nextAt = parsed.data.at !== undefined ? parsed.data.at.trim() : existing.at;

    // 预校验合并后的排期设定：在进入 withSpace 之前校验，防止非法时刻创建新空间
    try {
      assertValidSchedule(nextDaily, nextAt);
    } catch (err) {
      if (err instanceof InvalidScheduleError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }

    const update = async () => {
      try {
        const updated = await jobs.update(c.req.param("id"), {
          prompt: parsed.data.prompt,
          daily: parsed.data.daily,
          at: parsed.data.at,
          originSpaceId,
        });
        if (!updated) return c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);
        return c.json(presentJob(updated));
      } catch (err) {
        if (err instanceof InvalidScheduleError) {
          return c.json({ error: err.message, code: err.code }, 400);
        }
        throw err;
      }
    };

    return originSpaceId
      ? conversationHub.withSpace(originSpaceId, update)
      : update();
  });

  app.delete("/api/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await jobs.remove(id);
    if (!ok) return c.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, 404);
    return c.json({ ok: true as const, id });
  });

  return app;
};
