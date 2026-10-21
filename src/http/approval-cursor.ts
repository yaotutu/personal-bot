import { Buffer } from "node:buffer";
import {
  approvalCursorPayloadSchema,
  type ApprovalCursorPayloadDto,
  type ApprovalFilter,
} from "./contracts/approvals.js";

/** 把 typed cursor 与生成时的过滤条件编码成不透明 base64url；只在 HTTP 适配层使用。 */
export const encodeApprovalCursor = (
  cursor: { resolvedAt: string; id: string },
  filter: ApprovalFilter,
): string => {
  return Buffer.from(
    JSON.stringify({
      resolvedAt: cursor.resolvedAt,
      id: cursor.id,
      ...(filter.spaceId !== undefined ? { spaceId: filter.spaceId } : {}),
      ...(filter.activityId !== undefined ? { activityId: filter.activityId } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
    }),
    "utf8",
  ).toString("base64url");
};

/**
 * 解码并校验游标。失败返回 undefined，由路由统一映射为 400；这里不抛异常，
 * 避免把内部解析细节带进错误响应。
 *
 * 规范化检查（重新编码必须等于输入）拒绝 padding、空白、URL 转义和非法字符，
 * 保证同一游标只有一种合法文本形式。
 */
export const decodeApprovalCursor = (
  value: string,
): ApprovalCursorPayloadDto | undefined => {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) return undefined;
    const parsed = approvalCursorPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** 游标必须与本次查询的三个过滤条件完全一致，避免跨条件静默翻页。 */
export const approvalCursorMatchesFilter = (
  cursor: ApprovalCursorPayloadDto,
  filter: ApprovalFilter,
): boolean => {
  return (
    cursor.spaceId === filter.spaceId &&
    cursor.activityId === filter.activityId &&
    cursor.status === filter.status
  );
};
