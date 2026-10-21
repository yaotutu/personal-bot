import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  approvalCursorMatchesFilter,
  decodeApprovalCursor,
  encodeApprovalCursor,
} from "../approval-cursor.js";
import { approvalDecisionRequest, approvalListQuery, type ApprovalFilter } from "../contracts/approvals.js";
import { presentApproval } from "../approval-presenters.js";

/**
 * 审批路由：当前 pending、终态历史、单项详情与人工决定。
 * 审批域不执行文件写入；approve 只授权受控工具继续，执行结果由工具另行回报。
 */

/**
 * 展开原始 query string 并拒绝重复键。Hono 的 c.req.query() 会静默保留第一个值，
 * 无法发现 `limit=10&limit=100` 这类歧义请求；返回 undefined 由调用方映射为 400。
 */
const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

export const createApprovalsRoutes = (
  dependencies: Pick<HttpDependencies, "actions">,
) => {
  const { actions } = dependencies;
  const app = new Hono();

  // 历史只含终态；pending 从 /pending 读取。游标绑定三个过滤条件，改变过滤必须重新从第一页开始。
  app.get("/api/approvals", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid approval query", code: "INVALID_REQUEST" }, 400);
    const parsed = approvalListQuery.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid approval query", code: "INVALID_REQUEST" }, 400);
    const { limit, cursor: encodedCursor, spaceId, activityId, status } = parsed.data;
    const effectiveSpaceId = spaceId;
    const filter: ApprovalFilter = {
      ...(effectiveSpaceId !== undefined ? { spaceId: effectiveSpaceId } : {}),
      ...(activityId !== undefined ? { activityId } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    let cursor: { resolvedAt: string; id: string } | undefined;
    if (encodedCursor !== undefined) {
      const decoded = decodeApprovalCursor(encodedCursor);
      if (!decoded || !approvalCursorMatchesFilter(decoded, filter))
        return c.json({ error: "Invalid approval cursor", code: "INVALID_CURSOR" }, 400);
      cursor = { resolvedAt: decoded.resolvedAt, id: decoded.id };
    }
    const page = await actions.page({
      limit,
      ...filter,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      approvals: page.approvals.map((action) => {
        const { preview: _preview, ...summary } = presentApproval(action);
        return summary;
      }),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ? encodeApprovalCursor(page.nextCursor, filter) : null,
    });
  });

  // 高频审批仅查询当前 pending；完整预览供横幅渲染和 SSE ready 后初始化。
  app.get("/api/approvals/pending", async (c) =>
    c.json({ approvals: (await actions.snapshotPending()).map(presentApproval) }),
  );

  // 详情含 pending 与终态；不存在返回 404，不返回空壳记录。
  app.get("/api/approvals/:id", async (c) => {
    const approval = await actions.get(c.req.param("id"));
    return approval
      ? c.json(presentApproval(approval))
      : c.json({ error: "Approval not found", code: "APPROVAL_NOT_FOUND" }, 404);
  });

  // 决定只提交一次：相同决定幂等返回当前记录；相反决定或已过期/取消返回 409。
  app.post("/api/approvals/:id/decision", async (c) => {
    const parsed = approvalDecisionRequest.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) return c.json({ error: "Invalid approval decision", code: "INVALID_REQUEST" }, 400);
    const result = await actions.resolveDecision(c.req.param("id"), parsed.data.decision);
    if (result.ok) return c.json(presentApproval(result.action!));
    return result.code === "not_found"
      ? c.json({ error: "Approval not found", code: "APPROVAL_NOT_FOUND" }, 404)
      : c.json({ error: "Approval is already resolved or expired", approval: presentApproval(result.action!) }, 409);
  });

  return app;
};
