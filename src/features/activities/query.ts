import type { ActivityDetail, ActivityOverview, ActivityStatus } from "./types.js";

/**
 * 活动查询的纯业务层：只接收已经投影好的 ActivityDetail，不做 I/O、不依赖 HTTP、
 * zod 或文件系统。排序、过滤、游标比较和分页语义集中在这里；路由只负责把查询参数
 * 解码成 typed cursor，并把分页结果编码回 HTTP。
 */

export type ActivityFilter = {
  threadId?: string;
  status?: ActivityStatus;
};

/**
 * 已解码的分页游标：上一页最后一条活动的排序键，并携带生成时的过滤条件。
 * 活动类型只保存字符串时间，因此游标同样保留 ISO 字符串；比较时再解析时间戳。
 */
export type ActivityCursor = ActivityFilter & { createdAt: string; id: string };

export type ActivityQuery = {
  filter: ActivityFilter;
  limit: number;
  cursor?: ActivityCursor;
};

export type ActivityPage = {
  activities: ActivityOverview[];
  hasMore: boolean;
  nextCursor: ActivityCursor | null;
};

/**
 * 游标绑定过滤条件：改变 threadId/status 后继续翻页会跳过一个不存在的序列，
 * 必须从第一页重新开始。未设置与显式 undefined 视为同一种过滤。
 */
export const activityCursorMatchesFilter = (
  cursor: ActivityCursor,
  filter: ActivityFilter,
): boolean =>
  (cursor.threadId ?? undefined) === (filter.threadId ?? undefined) &&
  (cursor.status ?? undefined) === (filter.status ?? undefined);

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  // 活动时间由服务端以 ISO 8601 写入；解析失败说明投影数据已损坏，
  // 不能静默当作 0 参与排序（全局约定：损坏数据必须报错，不静默过滤）。
  if (Number.isNaN(parsed)) throw new Error("Activity timestamp is invalid");
  return parsed;
};

/**
 * 降序比较：新活动在前；创建时间相同按 id 降序，保证分页游标有稳定全序。
 * 返回负数表示 a 排在 b 前。
 */
const compareDescending = (
  a: Pick<ActivityOverview, "createdAt" | "id">,
  b: Pick<ActivityOverview, "createdAt" | "id">,
): number => {
  const delta = timestamp(b.createdAt) - timestamp(a.createdAt);
  if (delta !== 0) return delta;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
};

/**
 * 读取一页活动。每次调用都基于传入的当前投影重新过滤、排序，不缓存快照：
 * 执行中的状态与步骤、以及分页期间新增的活动都会在后续请求中如实反映，
 * 因此分页不冻结（已读页不保证与首次读取一致，新增活动只会出现在第一页）。
 * cursor 指向上一页最后一项，本页只返回严格排在其后的活动，避免重复或跳过。
 */
export const queryActivities = (
  details: readonly ActivityDetail[],
  query: ActivityQuery,
): ActivityPage => {
  const { filter, limit, cursor } = query;
  for (const detail of details) {
    timestamp(detail.activity.createdAt);
  }
  if (cursor) timestamp(cursor.createdAt);
  const matches = details
    .map((detail) => detail.activity)
    .filter(
      (activity) =>
        (filter.threadId === undefined || activity.threadId === filter.threadId) &&
        (filter.status === undefined || activity.status === filter.status),
    )
    .sort(compareDescending)
    .filter((activity) => !cursor || compareDescending(activity, cursor) > 0);
  const activities = matches.slice(0, limit);
  const hasMore = matches.length > limit;
  const last = activities.at(-1);
  return {
    activities,
    hasMore,
    // nextCursor 携带本次过滤条件，后续请求若改变 threadId/status 会被路由拒绝。
    nextCursor:
      hasMore && last
        ? {
            createdAt: last.createdAt,
            id: last.id,
            ...(filter.threadId !== undefined ? { threadId: filter.threadId } : {}),
            ...(filter.status !== undefined ? { status: filter.status } : {}),
          }
        : null,
  };
};
