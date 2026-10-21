import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import type { AgentSnapshotDto } from "../contracts/responses.js";

/**
 * GET /api/agent：工作台首屏身份快照。
 *
 * 定时任务已迁移至独立 /api/jobs 接口，网页监控已迁移至独立 /api/monitors 接口，
 * 长期记忆已迁移至独立 /api/memories 接口，长期目标已迁移至独立 /api/goals 接口，
 * 快照中不再包含 tasks、monitors、memories 与 goals 字段。
 */
export const createSnapshotRoute = (
  dependencies: Pick<HttpDependencies, "identity">,
) => {
  const { identity } = dependencies;
  const app = new Hono();
  app.get("/api/agent", async (c) => {
    const identityState = await identity.get();
    const snapshot: AgentSnapshotDto = {
      identity: identityState,
    };
    return c.json(snapshot);
  });
  return app;
};
