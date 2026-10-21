import { Buffer } from "node:buffer";
import type { ActivityCursor } from "../features/activities/query.js";
import { activityCursorPayloadSchema } from "./contracts/activities.js";

/** 把 typed cursor 编码成不透明 base64url；只在 HTTP 适配层使用。 */
export const encodeActivityCursor = (cursor: ActivityCursor): string =>
  Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt,
      id: cursor.id,
      ...(cursor.spaceId !== undefined ? { spaceId: cursor.spaceId } : {}),
      ...(cursor.threadId !== undefined ? { threadId: cursor.threadId } : {}),
      ...(cursor.status !== undefined ? { status: cursor.status } : {}),
    }),
    "utf8",
  ).toString("base64url");

/**
 * 解码并校验游标。失败返回 undefined，由路由统一映射为 400；这里不抛异常，
 * 避免把内部解析细节带进错误响应。
 *
 * 规范化检查（重新编码必须等于输入）拒绝 padding、空白、URL 转义和非法字符，
 * 保证同一游标只有一种合法文本形式。
 */
export const decodeActivityCursor = (value: string): ActivityCursor | undefined => {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) return undefined;
    const parsed = activityCursorPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};
