import { randomUUID } from "node:crypto";
import {
  BrowserError,
  type BrowserActInput,
  type BrowserDriver,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserSnapshot,
  type BrowserStreamClient,
  type BrowserTab,
} from "./types.js";

type Ticket = { value: string; expiresAt: number };
type ClientState = {
  client: BrowserStreamClient;
  pendingFrame?: { frameId: number; sessionId: string };
};

const TICKET_LIFETIME_MS = 60_000;
const MAX_CLIENT_BUFFER_BYTES = 2 * 1024 * 1024;

const textEncoder = new TextEncoder();
const isFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const coordinate = (value: unknown) => isFinite(value) && value >= 0 && value <= 20000;
const scrollDelta = (value: unknown) => isFinite(value) && Math.abs(value) <= 100000;
const key = (value: unknown) =>
  typeof value === "string" && value.length <= 64 && /^[a-zA-Z0-9]+(?:\+[a-zA-Z0-9]+)*$/.test(value);
const button = (value: unknown) => value === undefined || ["left", "middle", "right"].includes(value as string);
const clickCount = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3);

/** feature 层不用协议库；这里保持与 HTTP 契约相同的输入边界。 */
const isInputMessage = (value: unknown): value is BrowserInputEvent => {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case "pointer_move": case "pointer_down": case "pointer_up":
      return coordinate(item.x) && coordinate(item.y) && button(item.button);
    case "click":
      return coordinate(item.x) && coordinate(item.y) && button(item.button) &&
        clickCount(item.clickCount);
    case "wheel":
      return (item.x === undefined || coordinate(item.x)) && (item.y === undefined || coordinate(item.y)) &&
        scrollDelta(item.deltaX) && scrollDelta(item.deltaY);
    case "key_down": case "key_up":
      return key(item.key);
    case "insert_text":
      return typeof item.text === "string" && item.text.length >= 1 && item.text.length <= 2000;
    default:
      return false;
  }
};

const tabsMessage = (tabs: BrowserTab[]) => {
  const active = tabs.find((tab) => tab.active) ?? tabs[0];
  return JSON.stringify({
    type: "tabs",
    tabs,
    activeTabId: active?.id ?? null,
  });
};

const frameMessage = (frame: BrowserFrame) => {
  const metadata = {
    type: "frame",
    frameId: frame.frameId,
    tabId: frame.tabId,
    sessionId: frame.sessionId,
    width: frame.width,
    height: frame.height,
    mimeType: "image/jpeg",
    timestamp: frame.timestamp,
  };
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metadataBytes.length, false);
  const output = new Uint8Array(header.length + metadataBytes.length + frame.jpeg.length);
  output.set(header, 0);
  output.set(metadataBytes, header.length);
  output.set(frame.jpeg, header.length + metadataBytes.length);
  return output;
};

/**
 * BrowserService 是浏览器能力的唯一业务入口：HTTP、调试页、WS 与 Agent 工具
 * 都操作同一个懒启动 Chrome 实例。这里只保留标签、订阅、一次性 ticket 和
 * 输入协议，不做恢复框架或多用户租约。
 */
export const createBrowserService = (driver: BrowserDriver) => {
  let closed = false;
  let closing: Promise<void> | undefined;
  const clients = new Map<BrowserStreamClient, ClientState>();
  const tickets = new Map<string, Ticket>();
  let activeTabId: string | undefined;

  const checkOpen = () => {
    if (closed) throw new BrowserError("BROWSER_FAILED", "Browser service is closed");
  };

  const broadcastTabs = (tabs: BrowserTab[]) => {
    activeTabId = (tabs.find((tab) => tab.active) ?? tabs[0])?.id;
    const message = tabsMessage(tabs);
    for (const { client } of clients.values()) client.sendText(message);
  };

  const syncScreencast = async (previousActiveTabId?: string, nextActiveTabId?: string) => {
    if (!clients.size) return;
    if (previousActiveTabId && previousActiveTabId !== nextActiveTabId)
      await driver.stopScreencast(previousActiveTabId).catch(() => undefined);
    if (nextActiveTabId) await driver.startScreencast(nextActiveTabId).catch(() => undefined);
  };

  driver.onTabsChanged?.((tabs) => {
    const previous = activeTabId;
    broadcastTabs(tabs);
    void syncScreencast(previous, activeTabId).catch(() => undefined);
  });

  driver.onFrame?.((frame) => {
    if (!clients.size) return;
    const message = frameMessage(frame);
    for (const state of clients.values()) {
      if (state.client.bufferedAmount() > MAX_CLIENT_BUFFER_BYTES) {
        state.client.close();
        continue;
      }
      if (state.pendingFrame !== undefined) continue;
      state.client.sendBinary(message);
      state.pendingFrame = { frameId: frame.frameId, sessionId: frame.sessionId };
    }
  });

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    checkOpen();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("BROWSER_FAILED", "Browser operation failed");
    }
  };

  const listTabs = () => run(async () => {
    const tabs = await driver.listTabs();
    broadcastTabs(tabs);
    return tabs;
  });

  const withActiveTab = async () => {
    const tabs = await listTabs();
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    if (!active) throw new BrowserError("TAB_NOT_FOUND", "No browser tab is open");
    return active;
  };

  const createTicket = () => {
    checkOpen();
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
    const ticket: Ticket = {
      value: randomUUID(),
      expiresAt: now + TICKET_LIFETIME_MS,
    };
    tickets.set(ticket.value, ticket);
    return { ticket: ticket.value, expiresAt: new Date(ticket.expiresAt).toISOString() };
  };

  const consumeTicket = (value: string | undefined) => {
    checkOpen();
    const ticket = value ? tickets.get(value) : undefined;
    tickets.delete(value ?? "");
    return Boolean(ticket && ticket.expiresAt > Date.now());
  };

  const detachClient = (client: BrowserStreamClient) => {
    clients.delete(client);
    if (!clients.size && activeTabId)
      void driver.stopScreencast(activeTabId).catch(() => undefined);
  };

  const handleClientMessage = async (client: BrowserStreamClient, raw: string) => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      client.sendText(JSON.stringify({ type: "error", error: "Invalid JSON message" }));
      return;
    }
    const value = message as { type?: unknown; frameId?: unknown; sessionId?: unknown };
    if (value?.type === "frame_ack") {
      const state = clients.get(client);
      if (
        !state ||
        typeof value.frameId !== "number" ||
        typeof value.sessionId !== "string" ||
        state.pendingFrame?.frameId !== value.frameId ||
        state.pendingFrame.sessionId !== value.sessionId
      ) return;
      const { sessionId } = state.pendingFrame;
      state.pendingFrame = undefined;
      if (activeTabId)
        await driver.acknowledgeFrame(activeTabId, sessionId).catch(() => undefined);
      return;
    }
    if (!isInputMessage(message)) {
      client.sendText(JSON.stringify({ type: "error", error: "Invalid input message" }));
      return;
    }
    const targetTabId = activeTabId;
    if (!targetTabId) {
      client.sendText(JSON.stringify({ type: "error", error: "No active browser tab" }));
      return;
    }
    try {
      await driver.input(targetTabId, message);
    } catch {
      client.sendText(JSON.stringify({ type: "error", error: "Browser input failed" }));
    }
  };

  const attachClient = (client: BrowserStreamClient) => {
    checkOpen();
    clients.set(client, { client });
    void (async () => {
      try {
        const tabs = await driver.listTabs();
        broadcastTabs(tabs);
        client.sendText(JSON.stringify({
          type: "ready",
          tabs,
          activeTabId: activeTabId ?? null,
          frameFormat: BROWSER_FRAME_FORMAT,
        }));
        await syncScreencast(undefined, activeTabId);
      } catch {
        client.sendText(JSON.stringify({ type: "error", error: "Browser operation failed" }));
        client.close();
        detachClient(client);
      }
    })();
    return {
      handleMessage: (message: string) => {
        void handleClientMessage(client, message).catch(() => undefined);
      },
      detach: () => detachClient(client),
    };
  };

  const close = () => {
    if (closing) return closing;
    closed = true;
    for (const { client } of clients.values()) client.close();
    clients.clear();
    tickets.clear();
    closing = driver.close().catch(() => undefined);
    return closing;
  };

  return {
    listTabs,
    newTab: (url?: string) => run(() => driver.newTab(url)),
    closeTab: (tabId: string) => run(() => driver.closeTab(tabId)),
    activateTab: (tabId: string) => run(() => driver.activateTab(tabId)),
    navigate: (tabId: string | undefined, url: string) =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.navigate(target, url);
      }),
    history: (tabId: string | undefined, action: "back" | "forward") =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.history(target, action);
      }),
    reload: (tabId: string | undefined) =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.reload(target);
      }),
    input: (tabId: string, event: BrowserInputEvent) => run(() => driver.input(tabId, event)),
    act: (tabId: string | undefined, input: BrowserActInput) =>
      run(async () => {
        const target = tabId ? await driver.listTabs().then((tabs) => tabs.some((item) => item.id === tabId)
          ? tabId
          : undefined) : (await withActiveTab()).id;
        if (!target) throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
        await driver.act(target, input);
        return driver.snapshot(target);
      }),
    snapshot: (tabId?: string) =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        const tabs = await driver.listTabs();
        if (!tabs.some((tab) => tab.id === target))
          throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
        const snapshot = await driver.snapshot(target);
        return { ...snapshot, untrusted: true } satisfies BrowserSnapshot;
      }),
    createTicket,
    consumeTicket,
    attachClient,
    close,
  };
};

export type BrowserService = ReturnType<typeof createBrowserService>;

/** WS 二进制帧：4 字节大端 metadata 长度 + UTF-8 JSON metadata + JPEG 字节。 */
export const BROWSER_FRAME_FORMAT =
  "binary: uint32be metadataLength + utf8-json metadata + jpeg bytes";
