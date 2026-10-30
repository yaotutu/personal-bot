import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { InformationError } from "../../features/information/errors.js";
import { NewsError } from "../../features/news/errors.js";
import {
  newsArticlesQuerySchema,
  newsCommentCreateRequestSchema,
  newsCreateSourceRequestSchema,
  newsPreferencesUpdateRequestSchema,
  newsReactionRequestSchema,
  newsRefreshRequestSchema,
  newsSavedRequestSchema,
} from "../contracts/news.js";

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

const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

const failure = (error: unknown) => {
  if (error instanceof NewsError) {
    const status = error.code === "INVALID_INPUT" ? 400
      : error.code === "NOT_FOUND" ? 404
      : error.code === "SHUTDOWN" ? 503
      : 409;
    return { status, body: { error: error.message, code: error.code } } as const;
  }
  if (error instanceof InformationError) {
    const status = error.code === "INVALID_INPUT" ? 400
      : error.code === "NOT_FOUND" ? 404
      : error.code === "SHUTDOWN" ? 503
      : 409;
    return { status, body: { error: error.message, code: error.code } } as const;
  }
  return undefined;
};

export const createNewsRoutes = (dependencies: Pick<HttpDependencies, "news">) => {
  const { news } = dependencies;
  const app = new Hono();

  const handle = async (c: Context, work: () => Promise<unknown>) => {
    try {
      return c.json(await work());
    } catch (error) {
      const result = failure(error);
      if (result) return c.json(result.body, result.status);
      throw error;
    }
  };

  app.get("/status", (c) => handle(c, () => news.status()));
  app.get("/sources", (c) => handle(c, () => news.listSources()));
  app.post("/sources", async (c) => {
    const parsed = newsCreateSourceRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid RSS source", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.addSource(parsed.data));
  });
  app.delete("/sources/:sourceId", (c) => {
    const sourceId = c.req.param("sourceId");
    if (!validId(sourceId)) return c.json({ error: "Invalid sourceId", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.deleteSource(sourceId));
  });
  app.get("/articles", (c) => {
    const parsed = parseQuery(newsArticlesQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid news query", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.listArticles(parsed.data));
  });
  app.get("/articles/:articleId", (c) => {
    const articleId = c.req.param("articleId");
    if (!validId(articleId)) return c.json({ error: "Invalid articleId", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.getArticle(articleId));
  });
  app.put("/articles/:articleId/reaction", async (c) => {
    const articleId = c.req.param("articleId");
    if (!validId(articleId)) return c.json({ error: "Invalid articleId", code: "INVALID_INPUT" }, 400);
    const parsed = newsReactionRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid reaction", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.setReaction(articleId, parsed.data.reaction));
  });
  app.put("/articles/:articleId/saved", async (c) => {
    const articleId = c.req.param("articleId");
    if (!validId(articleId)) return c.json({ error: "Invalid articleId", code: "INVALID_INPUT" }, 400);
    const parsed = newsSavedRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid saved state", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.setSaved(articleId, parsed.data.saved));
  });
  app.post("/articles/:articleId/comments", async (c) => {
    const articleId = c.req.param("articleId");
    if (!validId(articleId)) return c.json({ error: "Invalid articleId", code: "INVALID_INPUT" }, 400);
    const parsed = newsCommentCreateRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Comment must be non-blank and at most 4000 characters", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.addComment(articleId, parsed.data.text));
  });
  app.delete("/articles/:articleId/comments/:commentId", (c) => {
    const articleId = c.req.param("articleId");
    const commentId = c.req.param("commentId");
    if (!validId(articleId) || !validId(commentId))
      return c.json({ error: "Invalid article or comment ID", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.deleteComment(articleId, commentId));
  });
  app.post("/refresh", async (c) => {
    const parsed = newsRefreshRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid refresh request", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.refresh({ retryFailed: true }));
  });
  app.get("/preferences", (c) => handle(c, () => news.preferences()));
  app.put("/preferences", async (c) => {
    const parsed = newsPreferencesUpdateRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid news preferences", code: "INVALID_INPUT" }, 400);
    return handle(c, () => news.savePreferences(parsed.data.notes));
  });
  return app;
};
