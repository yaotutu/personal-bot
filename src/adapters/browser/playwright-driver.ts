import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { resolvePublicHost } from "../../shared/public-host.js";
import {
  BrowserError,
  type BrowserActInput,
  type BrowserDriver,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTab,
} from "../../features/browser/types.js";

type DriverConfig = {
  profileDir: string;
  executablePath?: string;
  headless: boolean;
  allowPrivateTargets: boolean;
  timeoutMs: number;
};

type TabRecord = {
  id: string;
  page: Page;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
};

type SnapshotProjection = Omit<BrowserSnapshot, "untrusted" | "tab">;

type CastSession = {
  cdp: CDPSession;
  listener: (event: ScreencastFrameEvent) => void;
};

type ScreencastFrameEvent = {
  data: string;
  sessionId: number;
  metadata: {
    deviceWidth?: number;
    deviceHeight?: number;
    timestamp?: number;
  };
};

const VIEWPORT = { width: 1280, height: 800 };
const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// tsx 会给页面函数注入浏览器不存在的 __name 辅助符号；快照脚本必须用字符串保持原样。
const SNAPSHOT_SCRIPT = String.raw`
(() => {
  const limit = (value, max) => value.replace(/\s+/g, " ").trim().slice(0, max);
  const elements = [];
  const nodes = [...(document.body?.querySelectorAll("*") ?? [])];
  for (let index = 0; index < nodes.length && elements.length < 160; index++) {
    const element = nodes[index];
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
    if (!visible) continue;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") ??
      (tag === "a" ? "link" : tag === "button" ? "button" : tag === "input" ? "textbox" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "img" ? "image" : "generic");
    const interactive = Boolean(element.closest("a,button,input,select,textarea,[role=button],[onclick]")) ||
      element.hasAttribute("contenteditable");
    if (!interactive && !element.textContent?.trim()) continue;
    const ref = "e" + (elements.length + 1);
    element.setAttribute("data-pi-muse-ref", ref);
    const input = tag === "input" ? element : undefined;
    const contentText = limit(element.textContent ?? "", 600);
    const name = element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.getAttribute("alt") ??
      (input?.type === "password" ? "Password field" : input?.value) ??
      contentText;
    elements.push({
      ref,
      role,
      name: limit(name, 240),
      text: contentText,
      tag,
      interactive,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").slice(0, 8000),
    elements,
  };
})()
`;

const present = (record: TabRecord): BrowserTab => ({
  id: record.id,
  title: record.title,
  url: record.url,
  active: record.active,
  loading: record.loading,
});

const normalizeHttpUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl.trim());
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol))
      throw new Error("invalid");
    return url;
  } catch {
    throw new BrowserError("INVALID_INPUT", "URL must be HTTP(S) without credentials");
  }
};

/**
 * Playwright 只作为系统 Chrome 的驱动适配层：这里负责进程生命周期、CDP
 * screencast 与输入映射，不实现 HTTP/WS 协议，也不暴露任意 JavaScript 给模型。
 */
export const createPlaywrightBrowserDriver = (config: DriverConfig): BrowserDriver => {
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let starting: Promise<void> | undefined;
  let nextFrameId = 1;
  let closing: Promise<void> | undefined;
  const tabs = new Map<string, TabRecord>();
  const recordsByPage = new WeakMap<Page, TabRecord>();
  const casts = new Map<string, CastSession>();
  const tabsListeners = new Set<(tabs: BrowserTab[]) => void>();
  const frameListeners = new Set<(frame: BrowserFrame) => void>();

  const emitTabs = () => {
    const projected = [...tabs.values()].map(present);
    for (const listener of tabsListeners) listener(projected);
  };

  const refreshRecord = async (record: TabRecord) => {
    record.url = record.page.url();
    record.title = await record.page.title().catch(() => record.title);
  };

  const setActiveRecord = (record: TabRecord) => {
    for (const item of tabs.values()) item.active = item === record;
    emitTabs();
  };

  const recordFor = (tabId: string) => {
    const record = tabs.get(tabId);
    if (!record) throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
    return record;
  };

  const registerPage = (page: Page) => {
    // context.newPage 也会触发 context 的 page 事件；按 Page 去重避免同一标签出现两条记录。
    const existing = recordsByPage.get(page);
    if (existing) return existing;
    const record: TabRecord = {
      id: randomUUID(),
      page,
      title: "",
      url: page.url(),
      active: false,
      loading: true,
    };
    tabs.set(record.id, record);
    recordsByPage.set(page, record);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      record.url = frame.url();
      record.loading = true;
      emitTabs();
    });
    page.on("domcontentloaded", () => {
      record.loading = false;
      void refreshRecord(record).finally(emitTabs);
    });
    page.on("load", () => {
      record.loading = false;
      void refreshRecord(record).finally(emitTabs);
    });
    page.on("close", () => {
      tabs.delete(record.id);
      void stopCast(record.id).catch(() => undefined);
      if (record.active && tabs.size) {
        const next = [...tabs.values()][0]!;
        next.active = true;
        void next.page.bringToFront().catch(() => undefined);
      }
      emitTabs();
    });
    void refreshRecord(record).finally(emitTabs);
    return record;
  };

  const ensureStarted = async () => {
    if (context) return;
    starting ??= (async () => {
      await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
      const launched = await chromium.launchPersistentContext(config.profileDir, {
        headless: config.headless,
        viewport: VIEWPORT,
        args: ["--disable-dev-shm-usage"],
        ...(config.executablePath
          ? { executablePath: config.executablePath }
          : { channel: "chrome" as const }),
      });
      context = launched;
      // 默认复用 Web 工具的私网边界；显式 allowPrivateTargets 只用于本机联调。
      await launched.route("**/*", async (route) => {
        try {
          const url = new URL(route.request().url());
          // 私网开关只放宽回环/内网目标；协议限制始终保留。
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("blocked");
          if (!config.allowPrivateTargets) await resolvePublicHost(url.hostname, false);
          return route.continue();
        } catch {
          return route.abort("blockedbyclient");
        }
      });
      for (const page of launched.pages()) registerPage(page);
      if (tabs.size) setActiveRecord([...tabs.values()][0]!);
      launched.on("page", (page) => {
        const record = registerPage(page);
        setActiveRecord(record);
      });
    })().catch((error) => {
      starting = undefined;
      throw error;
    });
    await starting;
  };

  const validateTarget = async (url: string) => {
    const parsed = normalizeHttpUrl(url);
    if (!config.allowPrivateTargets)
      await resolvePublicHost(parsed.hostname, false).catch(() => {
        throw new BrowserError("INVALID_INPUT", "Private browser targets are disabled");
      });
    return parsed;
  };

  const goto = async (record: TabRecord, url?: string) => {
    if (!url) return;
    const parsed = await validateTarget(url);
    record.loading = true;
    emitTabs();
    try {
      await record.page.goto(parsed.toString(), {
        waitUntil: "domcontentloaded",
        timeout: config.timeoutMs,
      });
    } finally {
      record.loading = false;
      await refreshRecord(record);
      emitTabs();
    }
  };

  const locatorFor = (record: TabRecord, ref: string) => {
    if (!REF_PATTERN.test(ref)) throw new BrowserError("INVALID_INPUT", "Invalid browser element ref");
    return record.page.locator(`[data-pi-muse-ref="${ref}"]`);
  };

  const snapshotOf = async (record: TabRecord) => {
    const projection = await record.page.evaluate(SNAPSHOT_SCRIPT) as SnapshotProjection;
    return {
      tab: present(record),
      ...projection,
      elements: projection.elements as BrowserSnapshotElement[],
    };
  };

  const stopCast = async (tabId: string) => {
    const cast = casts.get(tabId);
    if (!cast) return;
    casts.delete(tabId);
    cast.cdp.off("Page.screencastFrame", cast.listener);
    await cast.cdp.send("Page.stopScreencast").catch(() => undefined);
    await cast.cdp.detach().catch(() => undefined);
  };

  const driver: BrowserDriver = {
    start: ensureStarted,
    close: async () => {
      if (closing) return closing;
      closing = (async () => {
        // 懒启动可能仍在进行；先等它拿到 context，再统一优雅关闭，避免 Chrome 泄漏。
        const pendingStart = starting;
        if (pendingStart) await pendingStart.catch(() => undefined);
        const current = context;
        context = undefined;
        starting = undefined;
        for (const tabId of [...casts.keys()]) await stopCast(tabId);
        tabs.clear();
        await current?.close().catch(() => undefined);
      })();
      return closing;
    },
    listTabs: async () => {
      await ensureStarted();
      await Promise.all([...tabs.values()].map(refreshRecord));
      const projected = [...tabs.values()].map(present);
      return projected;
    },
    newTab: async (url) => {
      await ensureStarted();
      const page = await context!.newPage();
      const record = registerPage(page);
      setActiveRecord(record);
      await goto(record, url);
      return present(record);
    },
    closeTab: async (tabId) => {
      await ensureStarted();
      const record = recordFor(tabId);
      await stopCast(tabId);
      await record.page.close();
      return [...tabs.values()].map(present);
    },
    activateTab: async (tabId) => {
      await ensureStarted();
      const record = recordFor(tabId);
      await record.page.bringToFront();
      setActiveRecord(record);
      await refreshRecord(record);
      return present(record);
    },
    navigate: async (tabId, url) => {
      await ensureStarted();
      const record = recordFor(tabId);
      await goto(record, url);
      return present(record);
    },
    history: async (tabId, action) => {
      await ensureStarted();
      const record = recordFor(tabId);
      record.loading = true;
      emitTabs();
      try {
        if (action === "back") await record.page.goBack({ waitUntil: "domcontentloaded", timeout: config.timeoutMs });
        else await record.page.goForward({ waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      } finally {
        record.loading = false;
        await refreshRecord(record);
        emitTabs();
      }
      return present(record);
    },
    reload: async (tabId) => {
      await ensureStarted();
      const record = recordFor(tabId);
      record.loading = true;
      emitTabs();
      try {
        await record.page.reload({ waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      } finally {
        record.loading = false;
        await refreshRecord(record);
        emitTabs();
      }
      return present(record);
    },
    input: async (tabId, event) => {
      await ensureStarted();
      const record = recordFor(tabId);
      const mouse = record.page.mouse;
      const keyboard = record.page.keyboard;
      if (event.type === "pointer_move") await mouse.move(event.x, event.y);
      else if (event.type === "pointer_down") await mouse.down({ button: event.button });
      else if (event.type === "pointer_up") await mouse.up({ button: event.button });
      else if (event.type === "click")
        await mouse.click(event.x, event.y, { button: event.button, clickCount: event.clickCount });
      else if (event.type === "wheel") {
        if (event.x !== undefined && event.y !== undefined) await mouse.move(event.x, event.y);
        await mouse.wheel(event.deltaX, event.deltaY);
      } else if (event.type === "key_down") await keyboard.down(event.key);
      else if (event.type === "key_up") await keyboard.up(event.key);
      else await keyboard.insertText(event.text);
    },
    act: async (tabId, input) => {
      await ensureStarted();
      const record = recordFor(tabId);
      const locator = input.ref ? locatorFor(record, input.ref) : undefined;
      if (input.action === "click") {
        if (locator) await locator.click({ timeout: config.timeoutMs });
        else if (input.x === undefined || input.y === undefined)
          throw new BrowserError("INVALID_INPUT", "click requires ref or coordinates");
        else await record.page.mouse.click(input.x, input.y);
        return;
      }
      if (input.action === "hover") {
        if (locator) await locator.hover({ timeout: config.timeoutMs });
        else if (input.x === undefined || input.y === undefined)
          throw new BrowserError("INVALID_INPUT", "hover requires ref or coordinates");
        else await record.page.mouse.move(input.x, input.y);
        return;
      }
      if (input.action === "type") {
        if (typeof input.text !== "string" || !input.text)
          throw new BrowserError("INVALID_INPUT", "type requires text");
        if (locator) await locator.fill(input.text, { timeout: config.timeoutMs });
        else {
          if (input.x !== undefined && input.y !== undefined)
            await record.page.mouse.click(input.x, input.y);
          await record.page.keyboard.type(input.text);
        }
        return;
      }
      if (input.action === "press") {
        if (!input.key) throw new BrowserError("INVALID_INPUT", "press requires key");
        await record.page.keyboard.press(input.key);
        return;
      }
      const deltaX = input.deltaX ?? 0;
      const deltaY = input.deltaY ?? 0;
      if (locator) await locator.scrollIntoViewIfNeeded({ timeout: config.timeoutMs });
      else if (input.x !== undefined && input.y !== undefined)
        await record.page.mouse.move(input.x, input.y);
      await record.page.mouse.wheel(deltaX, deltaY);
    },
    snapshot: async (tabId) => {
      await ensureStarted();
      const record = recordFor(tabId);
      await refreshRecord(record);
      return snapshotOf(record);
    },
    startScreencast: async (tabId) => {
      await ensureStarted();
      if (casts.has(tabId)) return;
      const record = recordFor(tabId);
      const cdp = await context!.newCDPSession(record.page);
      const listener = (event: ScreencastFrameEvent) => {
        const frame: BrowserFrame = {
          tabId,
          frameId: nextFrameId++,
          sessionId: String(event.sessionId),
          width: event.metadata.deviceWidth ?? VIEWPORT.width,
          height: event.metadata.deviceHeight ?? VIEWPORT.height,
          timestamp: event.metadata.timestamp ?? Date.now(),
          jpeg: new Uint8Array(Buffer.from(event.data, "base64")),
        };
        for (const emit of frameListeners) emit(frame);
      };
      casts.set(tabId, { cdp, listener });
      cdp.on("Page.screencastFrame", listener);
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      });
    },
    stopScreencast: stopCast,
    acknowledgeFrame: async (tabId, sessionId) => {
      const cast = casts.get(tabId);
      if (!cast) return;
      await cast.cdp.send("Page.screencastFrameAck", { sessionId: Number(sessionId) });
    },
    onTabsChanged: (listener) => tabsListeners.add(listener),
    onFrame: (listener) => frameListeners.add(listener),
  };
  return driver;
};
