import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { MemoryLimitError } from "../../features/memory/memory-service.js";
import type { MemoryItem } from "../../features/memory/types.js";
import {
  createMemorySchema,
  memoriesQuerySchema,
  updateMemorySchema,
} from "../contracts/rest.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

/** 长期记忆（Memories）独立查询、检索、详情、新增、修改与删除接口。 */
export const createMemoriesRoutes = (
  dependencies: Pick<HttpDependencies, "memory">,
) => {
  const { memory } = dependencies;
  const app = new Hono();

  app.get("/api/memories", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid memory query" }, 400);
    const parsed = memoriesQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid memory query" }, 400);

    let items: MemoryItem[];
    if (parsed.data.q) {
      items = await memory.search(parsed.data.q, parsed.data.limit);
    } else {
      items = await memory.list();
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

    return c.json({ memories: sorted });
  });

  app.get("/api/memories/:id", async (c) => {
    const item = await memory.get(c.req.param("id"));
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });

  app.post("/api/memories", async (c) => {
    const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    try {
      return c.json(await memory.add(parsed.data.text, parsed.data.source || "Web UI"));
    } catch (error) {
      if (error instanceof MemoryLimitError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.patch("/api/memories/:id", async (c) => {
    const parsed = updateMemorySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid memory request" }, 400);
    const item = await memory.edit(c.req.param("id"), parsed.data.text);
    return item ? c.json(item) : c.json({ error: "Memory not found" }, 404);
  });

  app.delete("/api/memories/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await memory.forget(id);
    return ok ? c.json({ ok: true as const, id }) : c.json({ error: "Memory not found" }, 404);
  });

  return app;
};
