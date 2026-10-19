import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { approvalDecisionRequest, approvalListQuery } from "../contracts/approvals.js";
import { presentApproval } from "../approval-presenters.js";

const cursorOf = (resolvedAt: string, id: string) => Buffer.from(JSON.stringify([resolvedAt, id])).toString("base64url");
const parseCursor = (raw: string | undefined): [string, string] | undefined => {
  if (raw === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((value) => typeof value !== "string") ||
      !Number.isFinite(Date.parse(parsed[0])) || !parsed[1] || cursorOf(parsed[0], parsed[1]) !== raw) throw new Error();
    return parsed as [string, string];
  } catch { throw new Error("Invalid approval cursor"); }
};

/** 当前待审批由SSE同步；历史只读与人的决定共用同一权威审批记录，不在HTTP执行文件副作用。 */
export const createActionsRoutes = ({ actions }: Pick<HttpDependencies, "actions">) => {
  const app = new Hono();
  app.get("/api/approvals", async (c) => {
    const parsed = approvalListQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid approval query" }, 400);
    let cursor: [string, string] | undefined;
    try { cursor = parseCursor(parsed.data.cursor); } catch { return c.json({ error: "Invalid approval cursor" }, 400); }
    const records = (await actions.history()).filter((action) => action.status !== "pending")
      .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!) || b.id.localeCompare(a.id))
      .filter((action) => !cursor || action.resolvedAt! < cursor[0] || (action.resolvedAt === cursor[0] && action.id < cursor[1]));
    const page = records.slice(0, parsed.data.limit);
    const hasMore = records.length > page.length;
    return c.json({
      approvals: page.map((action) => { const { preview: _preview, ...summary } = presentApproval(action); return summary; }),
      hasMore, nextCursor: hasMore && page.length ? cursorOf(page.at(-1)!.resolvedAt!, page.at(-1)!.id) : null,
    });
  });
  app.get("/api/approvals/:id", async (c) => {
    const action = await actions.get(c.req.param("id"));
    return action ? c.json(presentApproval(action)) : c.json({ error: "Approval not found" }, 404);
  });
  app.post("/api/approvals/:id/decision", async (c) => {
    const parsed = approvalDecisionRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid approval decision" }, 400);
    const resolved = await actions.resolveDecision(c.req.param("id"), parsed.data.decision);
    if (resolved.ok) return c.json(presentApproval(resolved.action!));
    if (resolved.code === "not_found") return c.json({ error: "Approval not found" }, 404);
    return c.json({ error: "Approval is already resolved or expired", approval: presentApproval(resolved.action!) }, 409);
  });
  return app;
};
