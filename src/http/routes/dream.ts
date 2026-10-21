import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { saveGlobalDreamSchema } from "../contracts/rest.js";

/** 全局 Dream 整理状态概览与全局提示词设置。 */
export const createDreamRoutes = (
  dependencies: Pick<HttpDependencies, "dream">,
) => {
  const { dream } = dependencies;
  const app = new Hono();
  app.get("/api/agent/dream", async (c) => c.json(await dream.describeAll()));
  app.put("/api/agent/dream", async (c) => {
    const parsed = saveGlobalDreamSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid dream request", code: "INVALID_REQUEST" }, 400);
    return c.json(await dream.saveGlobalPrompt(parsed.data.globalPrompt));
  });
  return app;
};
