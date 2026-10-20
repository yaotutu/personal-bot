import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { MemoryLimitError } from "../../features/memory/memory-service.js";
import {
  createMemorySchema,
  editMemorySchema,
  identitySchema,
  memoriesQuerySchema,
  saveGlobalDreamSchema,
} from "../contracts/rest.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

/** 记忆独立查询、增改忘、Dream 全局提示词与身份设置。 */
export const createMemoryRoutes = (
  dependencies: Pick<HttpDependencies, "memory" | "identity" | "dream">,
) => {
  const { memory, identity, dream } = dependencies;
  const app = new Hono();
  app.get("/api/agent/memories", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid memory query" }, 400);
    const parsed = memoriesQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid memory query" }, 400);
    const memories = parsed.data.q
      ? await memory.search(parsed.data.q, parsed.data.limit)
      : await memory.list();
    return c.json({ memories });
  });
  app.post("/api/agent/memories", async (c) => {
    const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    try {
      return c.json(await memory.add(parsed.data.text, parsed.data.source || "Web UI"));
    } catch (error) {
      if (error instanceof MemoryLimitError) return c.json({ error: error.message }, 409);
      throw error;
    }
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
  app.get("/api/agent/dream", async (c) => c.json(await dream.describeAll()));
  app.put("/api/agent/dream", async (c) => {
    const parsed = saveGlobalDreamSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid dream request" }, 400);
    return c.json(await dream.saveGlobalPrompt(parsed.data.globalPrompt));
  });
  return app;
};
