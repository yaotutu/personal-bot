import { Hono } from "hono";
import type { BrowserService } from "../../features/browser/browser-service.js";
import { BrowserError } from "../../features/browser/types.js";
import {
  browserNavigationSchema,
  createBrowserTabSchema,
} from "../contracts/browser.js";
import { browserDebugPage } from "../browser-debug-page.js";

/** 浏览器 REST 只做契约校验与受控错误投影；WS 升级由 Node server 适配层处理。 */
export const createBrowserRoutes = (
  browser: BrowserService | undefined,
) => {
  const app = new Hono();

  const error = (caught: unknown): {
    body: { error: string; code: string };
    status: 400 | 404 | 500;
  } => {
    if (!(caught instanceof BrowserError))
      return { body: { error: "Browser operation failed", code: "BROWSER_FAILED" }, status: 500 };
    return {
      body: { error: caught.message, code: caught.code },
      status: (caught.code === "TAB_NOT_FOUND" ? 404 : caught.code === "BROWSER_FAILED" ? 500 : 400) as 400 | 404 | 500,
    };
  };

  app.get("/browser", (c) =>
    c.html(browserDebugPage, 200, { "cache-control": "no-store" }),
  );

  if (!browser) return app;

  app.get("/api/browser/tabs", async (c) => {
    try { return c.json({ tabs: await browser.listTabs() }); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs", async (c) => {
    const parsed = createBrowserTabSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid browser tab request", code: "INVALID_REQUEST" }, 400);
    try { return c.json(await browser.newTab(parsed.data.url)); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.delete("/api/browser/tabs/:tabId", async (c) => {
    try { return c.json({ tabs: await browser.closeTab(c.req.param("tabId")) }); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs/:tabId/activate", async (c) => {
    try { return c.json(await browser.activateTab(c.req.param("tabId"))); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs/:tabId/navigation", async (c) => {
    const parsed = browserNavigationSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid browser navigation request", code: "INVALID_REQUEST" }, 400);
    const tabId = c.req.param("tabId");
    try {
      const tab = parsed.data.action === "navigate"
        ? await browser.navigate(tabId, parsed.data.url)
        : parsed.data.action === "back"
          ? await browser.history(tabId, "back")
          : parsed.data.action === "forward"
            ? await browser.history(tabId, "forward")
            : await browser.reload(tabId);
      return c.json(tab);
    } catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/ws-ticket", (c) => c.json(browser.createTicket()));

  return app;
};
