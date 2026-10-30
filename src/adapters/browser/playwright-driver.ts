import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Download,
  type ElementHandle,
  type FileChooser,
  type Page,
} from "playwright-core";
import { resolvePublicHost } from "../../shared/public-host.js";
import {
  BrowserError,
  type BrowserActInput,
  type BrowserDownloadEvent,
  type BrowserDriver,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTab,
  type BrowserUpload,
  type BrowserUploadFile,
} from "../../features/browser/types.js";

type DriverConfig = {
  profileDir: string;
  executablePath?: string;
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

type PendingUpload = {
  id: string;
  tabId: string;
  chooser: FileChooser;
  element: ElementHandle;
  multiple: boolean;
  accept: Promise<string>;
  createdAt: string;
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

type NativeTargetInfo = {
  targetId?: unknown;
  type?: unknown;
  embedderData?: Record<string, unknown>;
};
type LaunchPersistentContext = (
  profileDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;
type DriverDependencies = { launchPersistentContext?: LaunchPersistentContext };

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
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
export const createPlaywrightBrowserDriver = (
  config: DriverConfig,
  dependencies: DriverDependencies = {},
): BrowserDriver => {
  const launchPersistentContext = dependencies.launchPersistentContext ??
    ((profileDir, options) => chromium.launchPersistentContext(profileDir, options));
  let context: BrowserContext | undefined;
  let starting: Promise<void> | undefined;
  let nextFrameId = 1;
  let closing: Promise<void> | undefined;
  const tabs = new Map<string, TabRecord>();
  const recordsByPage = new WeakMap<Page, TabRecord>();
  const pageTargetIds = new WeakMap<Page, string>();
  const casts = new Map<string, CastSession>();
  const tabsListeners = new Set<(tabs: BrowserTab[]) => void>();
  const frameListeners = new Set<(frame: BrowserFrame) => void>();
  const downloadListeners = new Set<(download: BrowserDownloadEvent) => void>();
  const uploadsByTab = new Map<string, PendingUpload>();
  let castProbeTimer: ReturnType<typeof setInterval> | undefined;
  let castProbeRunning = false;

  const nativeMetadataError = () =>
    new BrowserError("BROWSER_FAILED", "Native tab metadata unavailable");

  const clearCastProbe = () => {
    if (!castProbeTimer) return;
    clearInterval(castProbeTimer);
    castProbeTimer = undefined;
  };

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

  const clearUpload = (tabId: string) => {
    uploadsByTab.delete(tabId);
  };

  const clearPendingUpload = (pending: PendingUpload) => {
    if (uploadsByTab.get(pending.tabId) === pending) uploadsByTab.delete(pending.tabId);
  };

  const uploadProjection = async (pending: PendingUpload): Promise<BrowserUpload> => ({
    id: pending.id,
    tabId: pending.tabId,
    multiple: pending.multiple,
    accept: await pending.accept,
    createdAt: pending.createdAt,
  });

  const pendingUpload = (uploadId: string) => {
    for (const pending of uploadsByTab.values())
      if (pending.id === uploadId) return pending;
    throw new BrowserError("UPLOAD_NOT_FOUND", "Browser upload chooser not found");
  };

  const registerDownload = (download: Download) => {
    let page: Page;
    try {
      page = download.page();
    } catch {
      void download.delete().catch(() => undefined);
      return;
    }
    const record = recordsByPage.get(page);
    if (!record) {
      void download.delete().catch(() => undefined);
      return;
    }
    const event: BrowserDownloadEvent = {
      id: randomUUID(),
      tabId: record.id,
      name: download.suggestedFilename(),
      createdAt: new Date().toISOString(),
      read: () => download.createReadStream(),
      failure: () => download.failure(),
      cancel: () => download.cancel(),
      discard: () => download.delete(),
    };
    for (const listener of downloadListeners) {
      try {
        listener(event);
      } catch {
        // download 事件不能因业务监听器异常破坏 Playwright 事件循环。
      }
    }
  };

  const resetContext = (launched: BrowserContext) => {
    if (context !== launched) return;
    context = undefined;
    starting = undefined;
    clearCastProbe();
    for (const cast of casts.values()) {
      cast.cdp.off("Page.screencastFrame", cast.listener);
    }
    casts.clear();
    uploadsByTab.clear();
    tabs.clear();
    emitTabs();
  };

  const recordFor = (tabId: string) => {
    const record = tabs.get(tabId);
    if (!record) throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
    return record;
  };

  const registerPage = (page: Page, owner: BrowserContext) => {
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
      if (context !== owner) return;
      if (frame !== page.mainFrame()) return;
      clearUpload(record.id);
      record.url = frame.url();
      record.loading = true;
      emitTabs();
    });
    page.on("domcontentloaded", () => {
      if (context !== owner) return;
      record.loading = false;
      void refreshRecord(record).finally(emitTabs);
    });
    page.on("load", () => {
      if (context !== owner) return;
      record.loading = false;
      void refreshRecord(record).finally(emitTabs);
    });
    page.on("close", () => {
      if (context !== owner) return;
      clearUpload(record.id);
      tabs.delete(record.id);
      void stopCast(record.id).catch(() => undefined);
      if (record.active && tabs.size) {
        const next = [...tabs.values()][0]!;
        next.active = true;
        void next.page.bringToFront().catch(() => undefined);
      }
      emitTabs();
    });
    page.on("filechooser", (chooser) => {
      if (context !== owner) return;
      const element = chooser.element();
      const pending: PendingUpload = {
        id: randomUUID(),
        tabId: record.id,
        chooser,
        element,
        multiple: chooser.isMultiple(),
        accept: element.getAttribute("accept")
          .then((value) => value ?? "")
          .catch(() => ""),
        createdAt: new Date().toISOString(),
      };
      // 一页只保留当前 chooser；新 chooser 直接替换旧引用，不尝试清空旧 input。
      uploadsByTab.set(record.id, pending);
    });
    void refreshRecord(record).finally(emitTabs);
    return record;
  };

  const ensureStarted = async () => {
    if (closing) await closing;
    if (context) return;
    if (starting) return starting;
    const pending = (async () => {
      await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
      // Docker 的 noVNC 通道展示整台 X 屏幕；让 Chrome 按屏幕尺寸占满，不叠一层固定视口。
      const windowSize = process.env.BROWSER_WINDOW_SIZE;
      const [windowWidth, windowHeight] = windowSize?.split("x") ?? [];
      const launched = await launchPersistentContext(config.profileDir, {
        // 产品要求固定使用带 GUI 的真实 Chrome；Docker 部署由 Xvfb 提供显示，不回退 headless。
        headless: false,
        // 进程信号由应用的 shutdown 串行驱动 service.close；Playwright 默认 handler
        // 会并发关闭同一 Browser，二次 gracefullyClose 会升级为强制 kill。
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        acceptDownloads: true,
        viewport: windowSize ? null : DEFAULT_VIEWPORT,
        // Linux 容器默认禁止 Chrome 创建 namespace sandbox；这里保持真实 GUI，
        // 不引入 headless 或远程渲染替代。
        args: [
          "--disable-dev-shm-usage",
          // Linux 容器默认禁止 Chrome 创建 namespace sandbox；本机 macOS 不放宽。
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          ...(windowSize
            ? [
                "--window-position=0,0",
                `--window-size=${windowWidth},${windowHeight}`,
                "--hide-crash-restore-bubble",
                "--test-type",
              ]
            : []),
        ],
        ...(config.executablePath
          ? { executablePath: config.executablePath }
          : { channel: "chrome" as const }),
      });
      context = launched;
      launched.on("close", () => resetContext(launched));
      try {
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
        if (context !== launched) throw new Error("Browser context closed during startup");
        for (const page of launched.pages()) registerPage(page, launched);
        if (context !== launched) throw new Error("Browser context closed during startup");
        if (tabs.size) setActiveRecord([...tabs.values()][0]!);
        launched.on("page", (page) => {
          if (context !== launched) return;
          const record = registerPage(page, launched);
          setActiveRecord(record);
        });
        launched.on("download", (download) => {
          if (context !== launched) return;
          registerDownload(download);
        });
      } catch (error) {
        if (context === launched) resetContext(launched);
        await launched.close().catch(() => undefined);
        throw error;
      }
    })();
    starting = pending;
    try {
      await pending;
    } finally {
      if (starting === pending) starting = undefined;
    }
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
    if (!casts.size) clearCastProbe();
    await cast.cdp.send("Page.stopScreencast").catch(() => undefined);
    await cast.cdp.detach().catch(() => undefined);
  };

  /**
   * Playwright focus emulation 会让所有页面保持 DOM visible，不能据此判断原生
   * 标签。这里用 Browser root CDP 的 tabActive 元数据，并通过 autoAttachRelated
   * 的 page targetId 精确关联 Playwright Page；所有临时 CDP session 都在 finally
   * 分离，避免影响 Playwright 自己的会话。
   */
  const detectVisibleRecord = async (owner: BrowserContext) => {
    if (context !== owner) return;
    const browser = owner.browser();
    if (!browser) throw nativeMetadataError();
    const root = await browser.newBrowserCDPSession();
    try {
      const targets = await root.send("Target.getTargets", { filter: [{ type: "tab" }] });
      if (!Array.isArray(targets.targetInfos)) throw nativeMetadataError();
      const tabTargets = (targets.targetInfos as NativeTargetInfo[])
        .filter((target) => target.type === "tab");
      if (!tabTargets.length) throw nativeMetadataError();

      const activeTabIds: string[] = [];
      for (const target of tabTargets) {
        const tabActive = (target.embedderData as Record<string, unknown> | undefined)?.tabActive;
        if (typeof tabActive !== "boolean" || typeof target.targetId !== "string")
          throw nativeMetadataError();
        if (tabActive) activeTabIds.push(target.targetId);
      }
      if (!activeTabIds.length) return;

      const relatedPageTargetIds = new Set<string>();
      const attachedListener = (event: { targetInfo?: NativeTargetInfo }) => {
        if (event.targetInfo?.type === "page" && typeof event.targetInfo.targetId === "string")
          relatedPageTargetIds.add(event.targetInfo.targetId);
      };
      root.on("Target.attachedToTarget", attachedListener);
      try {
        for (const targetId of activeTabIds) {
          await root.send("Target.autoAttachRelated", {
            targetId,
            waitForDebuggerOnStart: false,
            filter: [{ type: "page" }, { type: "tab" }],
          });
        }
      } finally {
        root.off("Target.attachedToTarget", attachedListener);
      }
      if (context !== owner) return;
      if (!relatedPageTargetIds.size) throw nativeMetadataError();

      const records = [...tabs.values()];
      const targetIds = new Map<TabRecord, string>();
      await Promise.all(records.map(async (record) => {
        let targetId = pageTargetIds.get(record.page);
        if (!targetId) {
          const pageCdp = await owner.newCDPSession(record.page);
          try {
            const info = await pageCdp.send("Target.getTargetInfo");
            const found = (info.targetInfo as NativeTargetInfo | undefined)?.targetId;
            if (typeof found !== "string" || !found) throw nativeMetadataError();
            targetId = found;
            pageTargetIds.set(record.page, targetId);
          } finally {
            await pageCdp.detach().catch(() => undefined);
          }
        }
        targetIds.set(record, targetId);
      }));
      if (context !== owner) return;

      const current = records.find((record) => record.active);
      const matched = current && relatedPageTargetIds.has(targetIds.get(current)!)
        ? current
        : records.find((record) => relatedPageTargetIds.has(targetIds.get(record)!));
      if (matched && !matched.active) setActiveRecord(matched);
    } finally {
      await root.detach().catch(() => undefined);
    }
  };

  const ensureCastProbe = (owner: BrowserContext) => {
    if (context !== owner) return;
    if (!casts.size) {
      clearCastProbe();
      return;
    }
    if (castProbeTimer) return;
    castProbeTimer = setInterval(() => {
      if (context !== owner || !casts.size) {
        clearCastProbe();
        return;
      }
      if (castProbeRunning) return;
      castProbeRunning = true;
      void detectVisibleRecord(owner)
        .catch(() => undefined)
        .finally(() => {
          castProbeRunning = false;
        });
    }, 1000);
    castProbeTimer.unref();
  };

  const driver: BrowserDriver = {
    start: ensureStarted,
    close: async () => {
      if (closing) return closing;
      const pending = (async () => {
        // 懒启动可能仍在进行；先等它拿到 context，再统一优雅关闭，避免 Chrome 泄漏。
        const pendingStart = starting;
        if (pendingStart) await pendingStart.catch(() => undefined);
        const current = context;
        context = undefined;
        starting = undefined;
        clearCastProbe();
        for (const tabId of [...casts.keys()]) await stopCast(tabId);
        tabs.clear();
        emitTabs();
        await current?.close().catch(() => undefined);
      })();
      const tracked = pending.finally(() => {
        if (closing === tracked) closing = undefined;
      });
      closing = tracked;
      return closing;
    },
    listTabs: async () => {
      await ensureStarted();
      const owner = context!;
      await Promise.all([...tabs.values()].map(refreshRecord));
      await detectVisibleRecord(owner);
      const projected = [...tabs.values()].map(present);
      return projected;
    },
    newTab: async (url) => {
      await ensureStarted();
      const owner = context!;
      const page = await owner.newPage();
      if (context !== owner) throw new BrowserError("BROWSER_FAILED", "Browser operation failed");
      // newPage 可能只创建后台标签；内部 active 必须跟随 Chrome 真正可见的 page。
      await page.bringToFront();
      const record = registerPage(page, owner);
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
      else if (event.type === "pointer_down") {
        await mouse.move(event.x, event.y);
        await mouse.down({ button: event.button });
      } else if (event.type === "pointer_up") {
        await mouse.move(event.x, event.y);
        await mouse.up({ button: event.button });
      } else if (event.type === "click")
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
      const owner = context!;
      const record = recordFor(tabId);
      const cdp = await owner.newCDPSession(record.page);
      const metrics = await cdp.send("Page.getLayoutMetrics");
      if (context !== owner) {
        await cdp.detach().catch(() => undefined);
        throw new BrowserError("BROWSER_FAILED", "Browser operation failed");
      }
      const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      const viewport = {
        width: Math.max(1, Math.round(layout.clientWidth)),
        height: Math.max(1, Math.round(layout.clientHeight)),
      };
      const listener = (event: ScreencastFrameEvent) => {
        // CDP 生产帧与 viewer ack 解耦：驱动收到帧就回 ack，客户端慢只影响自己的 pending。
        if (event.sessionId > 0)
          void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
        const frame: BrowserFrame = {
          tabId,
          frameId: nextFrameId++,
          sessionId: String(event.sessionId),
          width: event.metadata.deviceWidth ?? viewport.width,
          height: event.metadata.deviceHeight ?? viewport.height,
          timestamp: event.metadata.timestamp ?? Date.now(),
          jpeg: new Uint8Array(Buffer.from(event.data, "base64")),
        };
        for (const emit of frameListeners) emit(frame);
      };
      casts.set(tabId, { cdp, listener });
      cdp.on("Page.screencastFrame", listener);
      ensureCastProbe(owner);
      try {
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: viewport.width,
          maxHeight: viewport.height,
        });
        // headed Chrome 的静态页面可能迟迟不触发 screencast 重绘；启动时从真实
        // GUI 捕一帧，保证切换标签后客户端立即看到当前页面而不是空白画布。
        const captured = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 70,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
        }) as { data: string };
        listener({
          data: captured.data,
          sessionId: 0,
          metadata: { deviceWidth: viewport.width, deviceHeight: viewport.height, timestamp: Date.now() },
        });
      } catch (error) {
        await stopCast(tabId);
        throw error;
      }
    },
    stopScreencast: stopCast,
    listUploads: async () => {
      if (!context) return [];
      return Promise.all([...uploadsByTab.values()].map(uploadProjection));
    },
    setUploadFiles: async (uploadId, files: BrowserUploadFile[]) => {
      await ensureStarted();
      const pending = pendingUpload(uploadId);
      const isConnected = () =>
        pending.element.evaluate((node) => (node as { isConnected?: boolean }).isConnected === true)
          .catch(() => false);
      if (!(await isConnected())) {
        clearPendingUpload(pending);
        throw new BrowserError("UPLOAD_NOT_FOUND", "Browser upload chooser not found");
      }
      try {
        await pending.chooser.setFiles(files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.content),
        })));
      } catch {
        if (!(await isConnected())) {
          clearPendingUpload(pending);
          throw new BrowserError("UPLOAD_NOT_FOUND", "Browser upload chooser not found");
        }
        throw new BrowserError("BROWSER_FAILED", "Browser upload failed");
      }
      clearPendingUpload(pending);
    },
    cancelUpload: async (uploadId) => {
      const pending = pendingUpload(uploadId);
      clearPendingUpload(pending);
    },
    onTabsChanged: (listener) => tabsListeners.add(listener),
    onFrame: (listener) => frameListeners.add(listener),
    onDownload: (listener) => downloadListeners.add(listener),
  };
  return driver;
};
