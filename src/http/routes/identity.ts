import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { identitySchema } from "../contracts/rest.js";

/** 助手身份设置（名字、语气等）。 */
export const createIdentityRoutes = (
  dependencies: Pick<HttpDependencies, "identity">,
) => {
  const { identity } = dependencies;
  const app = new Hono();
  app.post("/api/agent/identity", async (c) => {
    const parsed = identitySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid identity request", code: "INVALID_REQUEST" }, 400);
    return c.json(await identity.save(parsed.data));
  });
  return app;
};
