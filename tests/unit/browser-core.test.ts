import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { createPlaywrightBrowserDriver } from "../../src/adapters/browser/playwright-driver.js";
import { createBrowserService } from "../../src/features/browser/browser-service.js";
import { BrowserError } from "../../src/features/browser/types.js";
import type {
  BrowserDownloadStore,
  BrowserDriver,
  BrowserFrame,
  BrowserSnapshot,
  BrowserStreamClient,
  BrowserTab,
} from "../../src/features/browser/types.js";

const downloadStore: BrowserDownloadStore = {
  reconcileOnStart: async () => undefined,
  list: async () => [],
  capture: async () => undefined,
  content: async () => { throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found"); },
  remove: async () => { throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found"); },
  close: async () => undefined,
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let index = 0; index < 100; index++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tab = (id: string, active: boolean): BrowserTab => ({
  id,
  title: id,
  url: `https://${id}.example/`,
  active,
  loading: false,
});

const frame = (frameId: number, tabId: string, sessionId = String(frameId)): BrowserFrame => ({
  tabId,
  frameId,
  sessionId,
  width: 1280,
  height: 800,
  timestamp: frameId,
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, frameId]),
});

const receivedFrameIds = (frames: Uint8Array[]) => frames.map((bytes) => {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as { frameId: number };
  return metadata.frameId;
});

class TestClient implements BrowserStreamClient {
  texts: string[] = [];
  frames: Uint8Array[] = [];
  events: ({ kind: "text"; message: string } | { kind: "binary" })[] = [];
  closed = false;
  buffered = 0;

  sendText(message: string) {
    this.texts.push(message);
    this.events.push({ kind: "text", message });
  }

  sendBinary(data: Uint8Array) {
    this.frames.push(data);
    this.events.push({ kind: "binary" });
  }

  close() {
    this.closed = true;
  }

  bufferedAmount() {
    return this.buffered;
  }
}

const createDriverHarness = (initialTabs: BrowserTab[] = [tab("one", true)]) => {
  let tabs = initialTabs;
  let tabsListener: ((tabs: BrowserTab[]) => void) | undefined;
  let frameListener: ((frame: BrowserFrame) => void) | undefined;
  const startCalls: string[] = [];
  const stopCalls: string[] = [];
  const inputCalls: { tabId: string; event: unknown }[] = [];
  let closeCalls = 0;

  const driver: BrowserDriver = {
    start: async () => undefined,
    close: async () => { closeCalls++; },
    listTabs: async () => tabs.map((item) => ({ ...item })),
    newTab: async () => tabs[0]!,
    closeTab: async () => tabs,
    activateTab: async (tabId) => tabs.find((item) => item.id === tabId)!,
    navigate: async (tabId) => tabs.find((item) => item.id === tabId)!,
    history: async (tabId) => tabs.find((item) => item.id === tabId)!,
    reload: async (tabId) => tabs.find((item) => item.id === tabId)!,
    input: async (tabId, event) => { inputCalls.push({ tabId, event }); },
    act: async () => undefined,
    snapshot: async (tabId) => {
      const item = tabs.find((candidate) => candidate.id === tabId)!;
      return {
        tab: item,
        title: item.title,
        url: item.url,
        text: "",
        elements: [],
      } satisfies Omit<BrowserSnapshot, "untrusted">;
    },
    startScreencast: async (tabId) => { startCalls.push(tabId); },
    stopScreencast: async (tabId) => { stopCalls.push(tabId); },
    listUploads: async () => [],
    setUploadFiles: async () => undefined,
    cancelUpload: async () => undefined,
    onTabsChanged: (listener) => { tabsListener = listener; },
    onFrame: (listener) => { frameListener = listener; },
  };

  return {
    driver,
    startCalls,
    stopCalls,
    inputCalls,
    closeCalls: () => closeCalls,
    emitTabs(next: BrowserTab[]) {
      tabs = next;
      tabsListener?.(next.map((item) => ({ ...item })));
    },
    emitFrame(next: BrowserFrame) {
      frameListener?.(next);
    },
  };
};

const attachReady = async (
  service: ReturnType<typeof createBrowserService>,
  client: TestClient,
) => {
  const attached = service.attachClient(client);
  await waitFor(() => client.texts.some((message) => message.includes('"type":"ready"')), "client ready");
  return attached;
};

test("client stays gated until ready and then receives the cached first frame", async (t) => {
  const harness = createDriverHarness();
  let releaseListTabs!: () => void;
  let markListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });
  const listGate = new Promise<void>((resolve) => { releaseListTabs = resolve; });
  const service = createBrowserService({
    ...harness.driver,
    listTabs: async () => {
      markListStarted();
      await listGate;
      return harness.driver.listTabs();
    },
  }, downloadStore);
  t.after(() => service.close());
  const client = new TestClient();
  const attached = service.attachClient(client);

  await listStarted;
  harness.emitTabs([tab("one", true)]);
  harness.emitFrame(frame(1, "one"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(client.frames.length, 0);
  attached.handleMessage(JSON.stringify({ type: "click", x: 10, y: 10 }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.inputCalls.length, 0);

  releaseListTabs();
  await waitFor(() => client.frames.length === 1, "cached frame after ready");
  const firstEvent = client.events[0];
  assert.equal(firstEvent?.kind, "text");
  if (firstEvent?.kind === "text") assert.match(firstEvent.message, /"type":"ready"/);
  assert.deepEqual(receivedFrameIds(client.frames), [1]);

  attached.handleMessage(JSON.stringify({ type: "click", x: 10, y: 10 }));
  await waitFor(() => harness.inputCalls.length === 1, "input after ready");
});

test("WS inputs serialize across viewers without blocking frame ack", async (t) => {
  const harness = createDriverHarness();
  const inputCalls: { tabId: string; event: unknown }[] = [];
  const firstStarted = deferred();
  const firstGate = deferred();
  const service = createBrowserService({
    ...harness.driver,
    input: async (tabId, event) => {
      inputCalls.push({ tabId, event });
      if (inputCalls.length === 1) {
        firstStarted.resolve();
        await firstGate.promise;
      }
    },
  }, downloadStore);
  t.after(async () => {
    firstGate.resolve();
    await service.close();
  });

  const first = new TestClient();
  const firstAttached = await attachReady(service, first);
  const second = new TestClient();
  const secondAttached = await attachReady(service, second);
  harness.emitFrame(frame(1, "one"));
  await waitFor(
    () => first.frames.length === 1 && second.frames.length === 1,
    "both viewers receive the first frame",
  );

  firstAttached.handleMessage(JSON.stringify({
    type: "pointer_down",
    x: 10,
    y: 20,
    button: "left",
  }));
  await firstStarted.promise;
  secondAttached.handleMessage(JSON.stringify({ type: "insert_text", text: "中文" }));
  harness.emitTabs([tab("one", false), tab("two", true)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(inputCalls.length, 1);

  firstAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 1, sessionId: "1" }));
  harness.emitFrame(frame(2, "two"));
  await waitFor(() => first.frames.length === 2, "frame ack bypasses blocked input");
  assert.deepEqual(receivedFrameIds(first.frames), [1, 2]);

  firstGate.resolve();
  await waitFor(() => inputCalls.length === 2, "serialized second viewer input");
  assert.deepEqual(inputCalls.map((call) => call.tabId), ["one", "one"]);
  assert.deepEqual(inputCalls.map((call) => (call.event as { type: string }).type), [
    "pointer_down",
    "insert_text",
  ]);
});

test("failed accepted input does not block pointer_up after client detach", async (t) => {
  const harness = createDriverHarness();
  const inputCalls: { tabId: string; event: unknown }[] = [];
  const firstStarted = deferred();
  const firstGate = deferred();
  const service = createBrowserService({
    ...harness.driver,
    input: async (tabId, event) => {
      inputCalls.push({ tabId, event });
      if (inputCalls.length === 1) {
        firstStarted.resolve();
        await firstGate.promise;
        throw new Error("input failed");
      }
    },
  }, downloadStore);
  t.after(async () => {
    firstGate.resolve();
    await service.close();
  });

  const client = new TestClient();
  const attached = await attachReady(service, client);
  attached.handleMessage(JSON.stringify({
    type: "pointer_down",
    x: 10,
    y: 20,
    button: "left",
  }));
  await firstStarted.promise;
  attached.handleMessage(JSON.stringify({ type: "pointer_up", x: 10, y: 20, button: "left" }));
  attached.detach();
  firstGate.resolve();

  await waitFor(() => inputCalls.length === 2, "input after failure and detach");
  assert.deepEqual(inputCalls.map((call) => call.tabId), ["one", "one"]);
  assert.deepEqual(inputCalls.map((call) => (call.event as { type: string }).type), [
    "pointer_down",
    "pointer_up",
  ]);
  assert.equal(client.texts.some((message) => message.includes("Browser input failed")), false);
});

test("service close waits for accepted inputs before closing the driver", async (t) => {
  const harness = createDriverHarness();
  const inputCalls: { tabId: string; event: unknown }[] = [];
  const firstStarted = deferred();
  const firstGate = deferred();
  const service = createBrowserService({
    ...harness.driver,
    input: async (tabId, event) => {
      inputCalls.push({ tabId, event });
      if (inputCalls.length === 1) {
        firstStarted.resolve();
        await firstGate.promise;
      }
    },
  }, downloadStore);
  t.after(async () => {
    firstGate.resolve();
    await service.close();
  });

  const client = new TestClient();
  const attached = await attachReady(service, client);
  attached.handleMessage(JSON.stringify({
    type: "pointer_down",
    x: 10,
    y: 20,
    button: "left",
  }));
  await firstStarted.promise;
  attached.handleMessage(JSON.stringify({ type: "pointer_up", x: 10, y: 20, button: "left" }));

  const closing = service.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.closeCalls(), 0);
  firstGate.resolve();
  await closing;
  assert.deepEqual(inputCalls.map((call) => call.tabId), ["one", "one"]);
  assert.equal(harness.closeCalls(), 1);
});

test("a new viewer immediately receives the latest static frame", async (t) => {
  const harness = createDriverHarness();
  const service = createBrowserService(harness.driver, downloadStore);
  t.after(() => service.close());
  const first = new TestClient();
  await attachReady(service, first);
  harness.emitFrame(frame(1, "one"));
  await waitFor(() => first.frames.length === 1, "first viewer frame");

  const second = new TestClient();
  const secondAttached = await attachReady(service, second);
  await waitFor(() => second.frames.length === 1, "cached frame for second viewer");
  assert.deepEqual(receivedFrameIds(first.frames), [1]);
  assert.deepEqual(receivedFrameIds(second.frames), [1]);

  secondAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 1, sessionId: "1" }));
  harness.emitFrame(frame(2, "one"));
  await waitFor(() => second.frames.length === 2, "slow first viewer does not block second");
  assert.deepEqual(receivedFrameIds(first.frames), [1]);
  assert.deepEqual(receivedFrameIds(second.frames), [1, 2]);
});

test("slow viewer backpressure does not block another viewer", async (t) => {
  const harness = createDriverHarness();
  const service = createBrowserService(harness.driver, downloadStore);
  t.after(() => service.close());
  const slow = new TestClient();
  const fast = new TestClient();
  await attachReady(service, slow);
  const fastAttached = await attachReady(service, fast);

  harness.emitFrame(frame(1, "one"));
  await waitFor(() => slow.frames.length === 1 && fast.frames.length === 1, "first frame");
  fastAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 1, sessionId: "1" }));

  harness.emitFrame(frame(2, "one"));
  await waitFor(() => fast.frames.length === 2, "second frame to fast viewer");
  assert.deepEqual(receivedFrameIds(slow.frames), [1]);
  assert.deepEqual(receivedFrameIds(fast.frames), [1, 2]);

  fastAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 2, sessionId: "2" }));
  harness.emitFrame(frame(3, "one"));
  await waitFor(() => fast.frames.length === 3, "third frame to fast viewer");
  assert.deepEqual(receivedFrameIds(slow.frames), [1]);
  assert.deepEqual(receivedFrameIds(fast.frames), [1, 2, 3]);
});

test("tab switch discards old pending frame and reconnect restarts screencast", async (t) => {
  const harness = createDriverHarness();
  const service = createBrowserService(harness.driver, downloadStore);
  t.after(() => service.close());
  const first = new TestClient();
  const firstAttached = await attachReady(service, first);

  harness.emitFrame(frame(1, "one"));
  await waitFor(() => first.frames.length === 1, "first tab frame");
  harness.emitTabs([tab("one", false), tab("two", true)]);
  await waitFor(() => harness.startCalls.includes("two"), "second tab screencast");

  harness.emitFrame(frame(2, "two"));
  await waitFor(() => first.frames.length === 2, "second tab frame without old ack");
  firstAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 1, sessionId: "1" }));
  harness.emitFrame(frame(3, "two"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(receivedFrameIds(first.frames), [1, 2]);

  firstAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 2, sessionId: "2" }));
  harness.emitFrame(frame(4, "two"));
  await waitFor(() => first.frames.length === 3, "new frame after current ack");
  assert.deepEqual(receivedFrameIds(first.frames), [1, 2, 4]);

  firstAttached.detach();
  await waitFor(() => harness.stopCalls.includes("two"), "stop after last viewer detaches");
  const reconnected = new TestClient();
  const reconnectedAttached = await attachReady(service, reconnected);
  await waitFor(() => reconnected.frames.length === 1, "cached frame after reconnect");
  assert.deepEqual(receivedFrameIds(reconnected.frames), [4]);
  reconnectedAttached.handleMessage(JSON.stringify({ type: "frame_ack", frameId: 4, sessionId: "4" }));
  harness.emitFrame(frame(5, "two"));
  await waitFor(() => reconnected.frames.length === 2, "frame after reconnect");
  assert.deepEqual(receivedFrameIds(reconnected.frames), [4, 5]);
});

test("service close does not resurrect clients or screencast", async (t) => {
  const harness = createDriverHarness();
  const service = createBrowserService(harness.driver, downloadStore);
  t.after(() => service.close());
  const client = new TestClient();
  await attachReady(service, client);

  await service.close();
  assert.equal(harness.closeCalls(), 1);
  assert.equal(client.closed, true);
  const starts = harness.startCalls.length;
  harness.emitTabs([tab("two", true)]);
  harness.emitFrame(frame(1, "two"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.startCalls.length, starts);
  await assert.rejects(service.listTabs(), /Browser service is closed/);
});

class FakePage {
  visibility = "visible";
  mouseCalls: string[] = [];
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  readonly mouse = {
    move: async (x: number, y: number) => { this.mouseCalls.push(`move:${x},${y}`); },
    down: async ({ button }: { button?: string }) => { this.mouseCalls.push(`down:${button}`); },
    up: async ({ button }: { button?: string }) => { this.mouseCalls.push(`up:${button}`); },
    click: async () => undefined,
    wheel: async () => undefined,
  };
  readonly keyboard = {
    down: async () => undefined,
    up: async () => undefined,
    insertText: async () => undefined,
    type: async () => undefined,
    press: async () => undefined,
  };

  constructor(
    private readonly context: FakeContext,
    readonly targetId: string,
    visibility: "visible" | "hidden",
  ) {
    this.visibility = visibility;
  }

  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  url() { return "about:blank"; }
  async title() { return "about:blank"; }
  mainFrame() { return this; }
  async evaluate() { return this.visibility; }
  async bringToFront() { this.context.activatePage(this); }
  async close() { this.emit("close"); }
  locator() {
    return {
      click: async () => undefined,
      hover: async () => undefined,
      fill: async () => undefined,
      scrollIntoViewIfNeeded: async () => undefined,
    };
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeCdp {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(private readonly pageTargetId?: string) {}

  async send(method: string, params: unknown = {}): Promise<any> {
    this.calls.push({ method, params });
    if (method === "Target.getTargetInfo")
      return { targetInfo: { targetId: this.pageTargetId } };
    if (method === "Page.getLayoutMetrics") {
      return {
        cssLayoutViewport: { clientWidth: 1365, clientHeight: 700 },
        layoutViewport: { clientWidth: 1365, clientHeight: 700 },
      };
    }
    if (method === "Page.captureScreenshot")
      return { data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") };
    return {};
  }

  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  async detach() {}

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class FakeRootCdp extends FakeCdp {
  constructor(private readonly context: FakeContext) {
    super();
  }

  override async send(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    if (method === "Target.getTargets") return { targetInfos: this.context.nativeTargetInfos() };
    if (method === "Target.autoAttachRelated") {
      this.context.attachRelated(this, (params as { targetId: string }).targetId);
      return {};
    }
    return {};
  }
}

class FakeContext {
  readonly pagesList: FakePage[];
  readonly cdpByPage = new WeakMap<Page, FakeCdp>();
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  cdpSessionCount = 0;
  rootSessionCount = 0;
  nativeMetadataAvailable = true;
  private nextPageId = 1;
  nativeActivePage: FakePage;

  constructor() {
    const initial = this.createPage("visible");
    this.pagesList = [initial];
    this.nativeActivePage = initial;
  }

  pages() { return this.pagesList; }
  async route() {}
  async newPage() {
    const page = this.createPage("hidden");
    this.pagesList.push(page);
    this.emit("page", page);
    return page;
  }
  activatePage(page: FakePage) {
    this.nativeActivePage = page;
    for (const item of this.pagesList) item.visibility = item === page ? "visible" : "hidden";
  }
  browser() {
    return {
      newBrowserCDPSession: async () => {
        this.rootSessionCount++;
        return new FakeRootCdp(this);
      },
    };
  }
  nativeTargetInfos() {
    return this.pagesList.map((page) => ({
      targetId: `tab-${page.targetId}`,
      type: "tab",
      embedderData: this.nativeMetadataAvailable
        ? { tabActive: page === this.nativeActivePage }
        : undefined,
    }));
  }
  attachRelated(root: FakeRootCdp, tabTargetId: string) {
    const page = this.pagesList.find((item) => `tab-${item.targetId}` === tabTargetId);
    if (!page) return;
    root.emit("Target.attachedToTarget", {
      targetInfo: { targetId: tabTargetId, type: "tab" },
    });
    root.emit("Target.attachedToTarget", {
      targetInfo: { targetId: page.targetId, type: "page" },
    });
  }
  async newCDPSession(page: Page) {
    this.cdpSessionCount++;
    const fakePage = page as unknown as FakePage;
    const cdp = new FakeCdp(this.pagesList.find((item) => item === fakePage)?.targetId);
    this.cdpByPage.set(page, cdp);
    return cdp;
  }
  cdpFor(page: Page) { return this.cdpByPage.get(page)!; }
  private createPage(visibility: "visible" | "hidden") {
    return new FakePage(this, `page-${this.nextPageId++}`, visibility);
  }
  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  async close() { this.emit("close"); }
  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const createFakePlaywright = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pimuse-browser-core-"));
  const contexts: FakeContext[] = [];
  const launches: { profileDir: string; options: any }[] = [];
  const driver = createPlaywrightBrowserDriver({
    profileDir: directory,
    allowPrivateTargets: true,
    timeoutMs: 1000,
  }, {
    launchPersistentContext: async (profileDir, options) => {
      const context = new FakeContext();
      contexts.push(context);
      launches.push({ profileDir, options });
      return context as unknown as BrowserContext;
    },
  });
  return {
    directory,
    contexts,
    launches,
    driver,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

test("driver clears a closed context and can start again explicitly", async (t) => {
  const previousWindowSize = process.env.BROWSER_WINDOW_SIZE;
  process.env.BROWSER_WINDOW_SIZE = "1440x900";
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
    if (previousWindowSize === undefined) delete process.env.BROWSER_WINDOW_SIZE;
    else process.env.BROWSER_WINDOW_SIZE = previousWindowSize;
  });
  const tabsEvents: BrowserTab[][] = [];
  fake.driver.onTabsChanged?.((tabs) => tabsEvents.push(tabs));

  const initial = await fake.driver.listTabs();
  assert.equal(fake.launches.length, 1);
  assert.equal(fake.launches[0]!.options.viewport, null);
  assert.equal(fake.launches[0]!.options.handleSIGINT, false);
  assert.equal(fake.launches[0]!.options.handleSIGTERM, false);
  assert.equal(fake.launches[0]!.options.handleSIGHUP, false);

  fake.contexts[0]!.emit("close");
  assert.deepEqual(tabsEvents.at(-1), []);
  const afterCrash = await fake.driver.newTab();
  assert.equal(fake.launches.length, 2);
  assert.notEqual(afterCrash.id, initial[0]!.id);

  await fake.driver.close();
  assert.deepEqual(tabsEvents.at(-1), []);
  await fake.driver.start();
  const afterExplicitStart = await fake.driver.listTabs();
  assert.equal(fake.launches.length, 3);
  assert.notEqual(afterExplicitStart[0]!.id, afterCrash.id);
});

test("listTabs follows native tab metadata when every DOM page is visible", async (t) => {
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
  });
  const tabsEvents: BrowserTab[][] = [];
  fake.driver.onTabsChanged?.((tabs) => tabsEvents.push(tabs));

  const [first] = await fake.driver.listTabs();
  const second = await fake.driver.newTab();
  assert.ok(first);
  assert.ok(fake.contexts[0]!.rootSessionCount > 0);

  fake.contexts[0]!.pagesList[0]!.visibility = "visible";
  fake.contexts[0]!.pagesList[1]!.visibility = "visible";
  fake.contexts[0]!.nativeActivePage = fake.contexts[0]!.pagesList[1]!;
  const tabs = await fake.driver.listTabs();
  assert.equal(tabs.find((item) => item.id === first.id)?.active, false);
  assert.equal(tabs.find((item) => item.id === second.id)?.active, true);
  assert.equal(tabsEvents.at(-1)?.find((item) => item.id === second.id)?.active, true);
  const firstCdp = fake.contexts[0]!.cdpFor(fake.contexts[0]!.pagesList[0] as unknown as Page);
  assert.equal(firstCdp.calls.some((call) => call.method === "Page.startScreencast"), false);
});

test("newTab brings the real page to front before native tab probing", async (t) => {
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
  });

  const [first] = await fake.driver.listTabs();
  const second = await fake.driver.newTab();
  assert.ok(first);
  assert.equal(fake.contexts[0]!.nativeActivePage, fake.contexts[0]!.pagesList[1]);

  const tabs = await fake.driver.listTabs();
  assert.equal(tabs.find((item) => item.id === first.id)?.active, false);
  assert.equal(tabs.find((item) => item.id === second.id)?.active, true);
});

test("listTabs reports a controlled error when native tab metadata is missing", async (t) => {
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
  });
  await fake.driver.start();
  fake.contexts[0]!.nativeMetadataAvailable = false;

  await assert.rejects(
    fake.driver.listTabs(),
    (error: unknown) => error instanceof BrowserError &&
      error.code === "BROWSER_FAILED" &&
      error.message === "Native tab metadata unavailable",
  );
});

test("driver preserves input, viewport, ack and native cast probe lifecycle", async (t) => {
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
  });
  const tabsEvents: BrowserTab[][] = [];
  const frames: BrowserFrame[] = [];
  fake.driver.onTabsChanged?.((tabs) => tabsEvents.push(tabs));
  fake.driver.onFrame?.((next) => frames.push(next));

  const [first] = await fake.driver.listTabs();
  assert.ok(first);
  await fake.driver.input(first.id, { type: "pointer_down", x: 11, y: 22, button: "right" });
  await fake.driver.input(first.id, { type: "pointer_up", x: 33, y: 44, button: "right" });
  assert.deepEqual(fake.contexts[0]!.pagesList[0]!.mouseCalls, [
    "move:11,22",
    "down:right",
    "move:33,44",
    "up:right",
  ]);

  await fake.driver.startScreencast(first.id);
  assert.equal(frames.at(-1)?.width, 1365);
  assert.equal(frames.at(-1)?.height, 700);
  const cdp = fake.contexts[0]!.cdpFor(fake.contexts[0]!.pagesList[0] as unknown as Page);
  const start = cdp.calls.find((call) => call.method === "Page.startScreencast");
  assert.deepEqual(start?.params, {
    format: "jpeg",
    quality: 70,
    maxWidth: 1365,
    maxHeight: 700,
  });
  const capture = cdp.calls.find((call) => call.method === "Page.captureScreenshot");
  assert.deepEqual((capture?.params as any).clip, { x: 0, y: 0, width: 1365, height: 700, scale: 1 });

  cdp.emit("Page.screencastFrame", {
    data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
    sessionId: 7,
    metadata: { deviceWidth: 1365, deviceHeight: 700, timestamp: 1 },
  });
  await waitFor(
    () => cdp.calls.some((call) => call.method === "Page.screencastFrameAck"),
    "immediate CDP frame ack",
  );
  assert.deepEqual(
    cdp.calls.find((call) => call.method === "Page.screencastFrameAck")?.params,
    { sessionId: 7 },
  );

  const second = await fake.driver.newTab();
  await fake.driver.startScreencast(second.id);
  fake.contexts[0]!.pagesList[0]!.visibility = "visible";
  fake.contexts[0]!.pagesList[1]!.visibility = "visible";
  fake.contexts[0]!.nativeActivePage = fake.contexts[0]!.pagesList[0]!;
  await sleep(1100);
  await waitFor(
    () => tabsEvents.at(-1)?.some((item) => item.id === first.id && item.active) === true,
    "manual native tab switch sync",
  );

  await fake.driver.stopScreencast(first.id);
  await fake.driver.stopScreencast(second.id);
  const probesAfterStop = fake.contexts[0]!.rootSessionCount;
  await sleep(1100);
  assert.equal(fake.contexts[0]!.rootSessionCount, probesAfterStop);
});

test("driver keeps a live failed upload retryable and clears detached choosers", async (t) => {
  const fake = await createFakePlaywright();
  t.after(async () => {
    await fake.driver.close();
    await fake.cleanup();
  });
  let connected = true;
  let failSetFiles = true;
  let setFiles = async () => {
    if (failSetFiles) throw new Error("transient setFiles failure");
  };
  const element = {
    evaluate: async () => connected,
    getAttribute: async () => ".txt",
  };
  const chooser = {
    element: () => element,
    isMultiple: () => false,
    setFiles: () => setFiles(),
  };
  const files = [{ name: "one.txt", mimeType: "text/plain", content: Uint8Array.from([1]) }];
  await fake.driver.start();
  const page = fake.contexts[0]!.pagesList[0]!;

  page.emit("filechooser", chooser);
  const first = (await fake.driver.listUploads())[0];
  assert.ok(first);
  await assert.rejects(
    fake.driver.setUploadFiles(first.id, files),
    (error: unknown) => error instanceof BrowserError && error.code === "BROWSER_FAILED",
  );
  assert.equal((await fake.driver.listUploads())[0]?.id, first.id);

  failSetFiles = false;
  await fake.driver.setUploadFiles(first.id, files);
  assert.deepEqual(await fake.driver.listUploads(), []);

  connected = false;
  page.emit("filechooser", chooser);
  const detached = (await fake.driver.listUploads())[0];
  assert.ok(detached);
  await assert.rejects(
    fake.driver.setUploadFiles(detached.id, files),
    (error: unknown) => error instanceof BrowserError && error.code === "UPLOAD_NOT_FOUND",
  );
  assert.deepEqual(await fake.driver.listUploads(), []);

  connected = true;
  page.emit("filechooser", chooser);
  const replaced = (await fake.driver.listUploads())[0];
  assert.ok(replaced);
  setFiles = async () => {
    connected = false;
    throw new Error("detached during setFiles");
  };
  await assert.rejects(
    fake.driver.setUploadFiles(replaced.id, files),
    (error: unknown) => error instanceof BrowserError && error.code === "UPLOAD_NOT_FOUND",
  );
  assert.deepEqual(await fake.driver.listUploads(), []);
});
