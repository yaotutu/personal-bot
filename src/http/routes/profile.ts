import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { saveProfileSchema } from "../contracts/rest.js";

/** SOUL/USER 自由文本：读取与保存（下一轮 prompt 注入即生效）。 */
export const createProfileRoutes = (
  dependencies: Pick<HttpDependencies, "identity">,
) => {
  const { identity } = dependencies;
  const app = new Hono();

  app.get("/api/profile", async (c) => c.json(await identity.getProfile()));

  app.put("/api/profile", async (c) => {
    const parsed = saveProfileSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid profile request", code: "INVALID_REQUEST" }, 400);
    }
    return c.json(await identity.saveProfile(parsed.data));
  });

  return app;
};
