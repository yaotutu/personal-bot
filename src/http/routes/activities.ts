import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { activitiesQuerySchema } from "../contracts/activities.js";
import { decodeActivityCursor, encodeActivityCursor } from "../activity-cursor.js";
import {
  activityCursorMatchesFilter,
  queryActivities,
  type ActivityCursor,
  type ActivityFilter,
} from "../../features/activities/query.js";

/**
 * 活动查询路由：只读。活动由主模型通过对话工具登记/更新/完成，HTTP 不提供写入口，
 * 避免客户端伪造执行过程或绕过审批；这里只把 hub 的当前投影做过滤、排序和分页。
 */

/**
 * 把原始 query string 解析成普通对象，并拒绝重复键。
 * Hono 的 c.req.query() 会静默保留第一个值，无法发现 `limit=10&limit=100` 这类
 * 自相矛盾的请求；严格契约要求歧义参数直接 400，所以这里自行展开 URLSearchParams。
 * 返回值 undefined 表示存在重复参数，由调用方统一映射为 400。
 */
const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

export const createActivitiesRoutes = (
  dependencies: Pick<HttpDependencies, "activities">,
) => {
  const { activities } = dependencies;
  const app = new Hono();
  app.get("/api/activities", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid activity query" }, 400);
    const parsed = activitiesQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid activity query" }, 400);
    const { limit, cursor: encodedCursor, threadId, status } = parsed.data;
    const filter: ActivityFilter = {
      ...(threadId !== undefined ? { threadId } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    let cursor: ActivityCursor | undefined;
    if (encodedCursor !== undefined) {
      cursor = decodeActivityCursor(encodedCursor);
      // 游标绑定过滤条件：解码失败、结构/时间非法或与本次 threadId/status 不一致都 400，
      // 不尝试“纠正”成第一页，避免客户端在错误过滤条件下静默拿到不完整结果。
      if (!cursor || !activityCursorMatchesFilter(cursor, filter))
        return c.json({ error: "Invalid activity cursor" }, 400);
    }
    const page = queryActivities(await activities.list(), {
      filter,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      activities: page.activities,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
    });
  });
  // 详情同样只读；不存在或来源会话已删除时 404，不返回空壳记录。
  app.get("/api/activities/:id", async (c) => {
    const detail = await activities.get(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "Activity not found" }, 404);
  });
  return app;
};
