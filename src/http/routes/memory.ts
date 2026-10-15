import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { createMemorySchema, editMemorySchema, identitySchema } from "../contracts/rest.js";

/** 记忆增改忘与身份设置保存（均走 POST）。 */
export const createMemoryRoutes = (
  dependencies: Pick<HttpDependencies, "memory" | "identity">,
) => {
  const { memory, identity } = dependencies;
  const app = new Hono();
  app.post("/api/agent/memories", async (c) => {
    const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    return c.json(await memory.add(parsed.data.text, parsed.data.source || "Web UI"));
  });
  app.post("/api/agent/memories/:id", async (c) => {
    const parsed = editMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    const item = await memory.edit(c.req.param("id"), parsed.data.text);
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/memories/:id/forget", async (c) => {
    const ok = await memory.forget(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Memory not found" }, 404);
  });
  app.post("/api/agent/identity", async (c) => {
    const parsed = identitySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid identity request" }, 400);
    return c.json(await identity.save(parsed.data));
  });
  return app;
};
