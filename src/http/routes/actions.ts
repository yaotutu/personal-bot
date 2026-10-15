import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { actionDecisionSchema } from "../contracts/rest.js";

/** 审批决定：仅 pending 可决定；approve 放行等待中的写操作，deny 受控拒绝。 */
export const createActionsRoutes = (
  dependencies: Pick<HttpDependencies, "actions">,
) => {
  const { actions } = dependencies;
  const app = new Hono();
  app.post("/api/actions/:id/decide", async (c) => {
    const parsed = actionDecisionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid decision request" }, 400);
    const action = await actions.decide(c.req.param("id"), parsed.data.decision);
    return action ? c.json(action) : c.json({ error: "Action not pending" }, 409);
  });
  return app;
};
