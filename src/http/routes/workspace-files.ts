import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { WorkspaceFileError } from "../../features/workspace/files-service.js";
import {
  workspaceContentQuerySchema,
  workspaceCreateTextSchema,
  workspaceDeleteQuerySchema,
  workspaceListQuerySchema,
  workspaceUpdateTextSchema,
} from "../contracts/workspace-files.js";
import { NEWS_INTERNAL_SPACE_ID } from "../../features/news/types.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

const failure = (error: WorkspaceFileError) =>
  error instanceof WorkspaceFileError
    ? { status: error.status, body: { error: error.message, code: error.code } }
    : undefined;
const reserved = (spaceId: string | undefined) => spaceId === NEWS_INTERNAL_SPACE_ID;

/**
 * 手机手动文件管理端点。请求校验只负责协议形状；空间存在性、UTF-8、
 * 字节数、路径与文件系统安全边界由 workspace file service 统一执行。
 */
export const createWorkspaceFileRoutes = (
  dependencies: Pick<HttpDependencies, "workspaceFiles">,
) => {
  const { workspaceFiles } = dependencies;
  const app = new Hono();

  app.get("/api/workspace/files", async (c) => {
    const parsed = workspaceListQuerySchema.safeParse(parseQueryObject(new URL(c.req.url)));
    if (!parsed.success) return c.json({ error: "Invalid workspace file query", code: "INVALID_REQUEST" }, 400);
    if (reserved(parsed.data.spaceId)) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
    try {
      return c.json(await workspaceFiles.list({
        scope: parsed.data.scope,
        spaceId: parsed.data.scope === "space" ? parsed.data.spaceId! : null,
        path: parsed.data.path,
      }));
    } catch (error) {
      const result = failure(error as WorkspaceFileError);
      if (!result) throw error;
      return c.json(result.body, result.status);
    }
  });

  app.get("/api/workspace/files/content", async (c) => {
    const parsed = workspaceContentQuerySchema.safeParse(parseQueryObject(new URL(c.req.url)));
    if (!parsed.success) return c.json({ error: "Invalid workspace file query", code: "INVALID_REQUEST" }, 400);
    if (reserved(parsed.data.spaceId)) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
    try {
      return c.json(await workspaceFiles.read({
        scope: parsed.data.scope,
        spaceId: parsed.data.scope === "space" ? parsed.data.spaceId! : null,
        path: parsed.data.path,
      }));
    } catch (error) {
      const result = failure(error as WorkspaceFileError);
      if (!result) throw error;
      return c.json(result.body, result.status);
    }
  });

  app.post("/api/workspace/files/text", async (c) => {
    const parsed = workspaceCreateTextSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid workspace file request", code: "INVALID_REQUEST" }, 400);
    if (reserved(parsed.data.spaceId)) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
    try {
      return c.json(await workspaceFiles.create({
        scope: parsed.data.scope,
        spaceId: parsed.data.scope === "space" ? parsed.data.spaceId! : null,
        path: parsed.data.path,
        content: parsed.data.content,
        confirmed: parsed.data.confirmed,
      }));
    } catch (error) {
      const result = failure(error as WorkspaceFileError);
      if (!result) throw error;
      return c.json(result.body, result.status);
    }
  });

  app.put("/api/workspace/files/text", async (c) => {
    const parsed = workspaceUpdateTextSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid workspace file request", code: "INVALID_REQUEST" }, 400);
    if (reserved(parsed.data.spaceId)) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
    try {
      return c.json(await workspaceFiles.update({
        scope: parsed.data.scope,
        spaceId: parsed.data.scope === "space" ? parsed.data.spaceId! : null,
        path: parsed.data.path,
        content: parsed.data.content,
        confirmed: parsed.data.confirmed,
      }));
    } catch (error) {
      const result = failure(error as WorkspaceFileError);
      if (!result) throw error;
      return c.json(result.body, result.status);
    }
  });

  app.delete("/api/workspace/files", async (c) => {
    const parsed = workspaceDeleteQuerySchema.safeParse(parseQueryObject(new URL(c.req.url)));
    if (!parsed.success) return c.json({ error: "Invalid workspace file query", code: "INVALID_REQUEST" }, 400);
    if (reserved(parsed.data.spaceId)) return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);
    try {
      return c.json(await workspaceFiles.delete({
        scope: parsed.data.scope,
        spaceId: parsed.data.scope === "space" ? parsed.data.spaceId! : null,
        path: parsed.data.path,
      }));
    } catch (error) {
      const result = failure(error as WorkspaceFileError);
      if (!result) throw error;
      return c.json(result.body, result.status);
    }
  });

  return app;
};
