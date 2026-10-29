import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { isSpaceId } from "../../features/conversation/space-id.js";
import { InformationError } from "../../features/information/errors.js";
import {
  informationIngestRequestSchema,
  informationItemsQuerySchema,
  informationPreferencesRequestSchema,
  informationRunsQuerySchema,
  informationRunRequestSchema,
  informationSettingsRequestSchema,
} from "../contracts/information.js";

const failure = (error: InformationError) => {
  const status =
    error.code === "INVALID_INPUT" ? 400 :
    error.code === "SPACE_NOT_FOUND" || error.code === "NOT_FOUND" ? 404 :
    error.code === "SHUTDOWN" ? 503 : 409;
  return {
    status,
    body: { error: error.message, code: error.code },
  } as const;
};

const parseQuery = <T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  url: string,
) => {
  const query = new URL(url).searchParams;
  for (const key of new Set(query.keys())) {
    if (query.getAll(key).length > 1) return { success: false as const };
  }
  return schema.safeParse(Object.fromEntries(query.entries()));
};

/** 信息后台 HTTP 入口：所有入口都只针对已存在空间，不隐式创建。 */
export const createInformationRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  const { conversationHub, information } = dependencies;

  const guard = (spaceId: string, code = "INVALID_SPACE_ID") => {
    if (!isSpaceId(spaceId)) return { status: 400 as const, body: { error: "Invalid spaceId", code } } as const;
    return undefined;
  };

  app.put("/:spaceId/information/settings", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationSettingsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information settings", code: "INVALID_REQUEST" }, 400);
    try {
      const spaceId = c.req.param("spaceId");
      const pause = information.pauseSpace(spaceId);
      await pause.stopped;
      try {
        const saved = await conversationHub.withExistingSpace(spaceId, async () =>
          information.saveSettings(spaceId, parsed.data));
        if (!saved) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
        return c.json(saved);
      } finally {
        pause.resume();
      }
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/settings", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getSettings(c.req.param("spaceId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.put("/:spaceId/information/preferences", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationPreferencesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information preferences", code: "INVALID_REQUEST" }, 400);
    try {
      const spaceId = c.req.param("spaceId");
      const saved = await conversationHub.withExistingSpace(spaceId, async () => {
        await information.savePreferences(spaceId, parsed.data);
        return true;
      });
      if (saved !== true) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
      // getPreferences 需要 retain 空间；不能嵌套在同一个短生命周期锁内。
      return c.json(await information.getPreferences(spaceId));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/preferences", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getPreferences(c.req.param("spaceId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/:spaceId/information/items", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationIngestRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information items", code: "INVALID_REQUEST" }, 400);
    try {
      const result = await conversationHub.withExistingSpace(c.req.param("spaceId"), async () =>
        information.ingest(c.req.param("spaceId"), parsed.data.items));
      if (!result) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
      return c.json({ items: result });
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/items", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = parseQuery(informationItemsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information items query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listItems(c.req.param("spaceId"), parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/items/:itemId", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getItem(c.req.param("spaceId"), c.req.param("itemId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/:spaceId/information/runs", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationRunRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid information run request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.runNow(c.req.param("spaceId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/runs", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = parseQuery(informationRunsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information runs query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listRuns(c.req.param("spaceId"), parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:spaceId/information/runs/:runId", async (c) => {
    const invalid = guard(c.req.param("spaceId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getRun(c.req.param("spaceId"), c.req.param("runId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  return app;
};
