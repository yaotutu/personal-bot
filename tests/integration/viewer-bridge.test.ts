import assert from "node:assert/strict";
import test from "node:test";

const bridgeUrl = new URL("../../assets/browser/viewer-bridge.js", import.meta.url);
const { createViewerBridge } = await import(bridgeUrl.href) as {
  createViewerBridge: (adapter: FakeAdapter, options?: { window?: FakeWindow }) => FakeBridge;
};

type TransportEnvelope = Record<string, unknown>;

type FakeWindow = {
  location: { origin: string; search: string; hash: string };
  parent: unknown;
  piMuseViewer?: unknown;
  ReactNativeWebView?: { postMessage(message: string): void };
  addEventListener(type: "message", listener: (event: {
    source: unknown;
    origin: string;
    data: unknown;
  }) => void): void;
  removeEventListener(type: "message", listener: (event: {
    source: unknown;
    origin: string;
    data: unknown;
  }) => void): void;
};

type FakeAdapter = {
  execute: (command: string, args: Record<string, unknown>) => unknown;
  getState: () => unknown;
  subscribe: (listener: (event: { event: "state" | "clipboard"; data: unknown }) => void) => () => void;
};

type FakeBridge = {
  dispatch: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  getState: () => unknown;
  subscribe: (listener: (envelope: TransportEnvelope) => void) => () => void;
  receive: (value: string | TransportEnvelope) => void;
  dispose: () => void;
};

function createWindow({
  search = "",
  hash = "",
  origin = "https://parent.test",
  reactNative = false,
} = {}) {
  const posted: TransportEnvelope[] = [];
  const postedJson: string[] = [];
  const targetOrigins: string[] = [];
  const listeners = new Set<(event: { source: unknown; origin: string; data: unknown }) => void>();
  const parent = {
    postMessage: (envelope: TransportEnvelope, targetOrigin: string) => {
      posted.push(envelope);
      targetOrigins.push(targetOrigin);
    },
  };
  const viewerWindow: FakeWindow = {
    location: { origin, search, hash },
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  if (reactNative) {
    viewerWindow.ReactNativeWebView = {
      postMessage: (message) => postedJson.push(message),
    };
    viewerWindow.parent = null;
  }
  return {
    viewerWindow,
    parent,
    posted,
    targetOrigins,
    postedJson,
    message(event: { source?: unknown; origin?: string; data: unknown }) {
      for (const listener of listeners) {
        listener({
          source: event.source === undefined ? parent : event.source,
          origin: event.origin ?? "https://parent.test",
          data: event.data,
        });
      }
    },
  };
}

function createAdapter(state: unknown = { connected: false }) {
  const listeners = new Set<(event: { event: "state" | "clipboard"; data: unknown }) => void>();
  const adapter: FakeAdapter & {
    calls: { command: string; args: Record<string, unknown> }[];
    emit: (event: { event: "state" | "clipboard"; data: unknown }) => void;
    unsubscribed: boolean;
  } = {
    calls: [],
    unsubscribed: false,
    execute(command, args) {
      this.calls.push({ command, args });
      return { command, args };
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        this.unsubscribed = true;
      };
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
  return adapter;
}

const waitMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("viewer bridge validates commands and executes adapters during dispatch", async () => {
  const { viewerWindow } = createWindow();
  const adapter = createAdapter({ connected: true, toolbarVisible: true });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });
  assert.equal(viewerWindow.piMuseViewer, bridge);

  let afterAdapterCall = false;
  const result = bridge.dispatch("toolbar.set", { visible: false });
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.calls[0], { command: "toolbar.set", args: { visible: false } });
  afterAdapterCall = true;
  assert.deepEqual(await result, { command: "toolbar.set", args: { visible: false } });
  assert.equal(afterAdapterCall, true);

  assert.deepEqual(await bridge.dispatch("state.get"), { connected: true, toolbarVisible: true });
  assert.equal(adapter.calls.length, 1);

  await assert.rejects(bridge.dispatch("rfb.send", {}), {
    code: "UNKNOWN_COMMAND",
    message: "Unknown viewer command.",
  });

  const invalidCases: [string, Record<string, unknown>][] = [
    ["connect", { extra: true }],
    ["toolbar.set", {}],
    ["toolbar.set", { visible: 1 }],
    ["keyboard.set", { visible: null }],
    ["key.send", {}],
    ["key.send", { keysym: 0, code: "KeyA", down: true }],
    ["key.send", { keysym: 1.5 }],
    ["key.send", { keysym: 1, code: "x".repeat(65) }],
    ["key.send", { keysym: 1, down: "true" }],
    ["text.send", { text: 1 }],
    ["clipboard.set", { text: "x".repeat(10001) }],
    ["viewport.set", { mode: "fit" }],
    ["viewport.set", { mode: "scale", drag: 1 }],
    ["viewOnly.set", { enabled: "true" }],
    ["fullscreen.set", { enabled: 0 }],
  ];
  for (const [command, args] of invalidCases) {
    await assert.rejects(bridge.dispatch(command, args), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(adapter.calls.length, 1);

  adapter.execute = () => ({ value: BigInt(1) });
  await assert.rejects(bridge.dispatch("connect"), {
    code: "OPERATION_FAILED",
    message: "Viewer command failed.",
  });

  adapter.execute = () => {
    const error = new Error("internal RFB socket secret") as Error & { code?: string };
    error.code = "INTERNAL";
    throw error;
  };
  await assert.rejects(bridge.dispatch("connect"), {
    code: "OPERATION_FAILED",
    message: "Viewer command failed.",
  });

  adapter.execute = () => {
    throw Object.assign(new Error("raw adapter diagnostic"), { code: "UNSUPPORTED" });
  };
  await assert.rejects(bridge.dispatch("focus"), {
    code: "UNSUPPORTED",
    message: "Viewer does not support this command.",
  });

  adapter.execute = () => {
    throw Object.assign(new Error("raw gesture diagnostic"), { code: "USER_GESTURE_REQUIRED" });
  };
  await assert.rejects(bridge.dispatch("fullscreen.set", { enabled: true }), {
    code: "USER_GESTURE_REQUIRED",
    message: "This viewer command requires a user gesture.",
  });
});

test("viewer bridge transport returns controlled results once and rejects duplicate ids", async () => {
  const { viewerWindow, posted, message } = createWindow();
  const adapter = createAdapter({ connected: false });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    channel: "pi-muse-viewer",
    version: 1,
    type: "event",
    event: "ready",
    data: { connected: false },
  });

  message({
    data: JSON.stringify({
      channel: "pi-muse-viewer",
      version: 1,
      type: "command",
      id: "command-1",
      command: "text.send",
      args: { text: "hello" },
    }),
  });
  await waitMicrotasks();
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(posted.at(-1), {
    channel: "pi-muse-viewer",
    version: 1,
    type: "result",
    id: "command-1",
    ok: true,
    result: { command: "text.send", args: { text: "hello" } },
  });

  message({
    data: {
      channel: "pi-muse-viewer",
      version: 1,
      type: "command",
      id: "command-1",
      command: "text.send",
      args: { text: "again" },
    },
  });
  await waitMicrotasks();
  assert.equal(adapter.calls.length, 1);
  assert.equal(posted.length, 2);

  message({
    data: {
      channel: "pi-muse-viewer",
      version: 1,
      type: "command",
      id: "command-2",
      extra: true,
      command: "key.send",
      args: { keysym: 1 },
    },
  });
  await waitMicrotasks();
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(posted.at(-1), {
    channel: "pi-muse-viewer",
    version: 1,
    type: "result",
    id: "command-2",
    ok: false,
    error: { code: "INVALID_ARGUMENT", message: "Invalid viewer command arguments." },
  });

  adapter.execute = () => {
    throw Object.assign(new Error("raw connection failure"), { code: "NOT_CONNECTED" });
  };
  bridge.receive({
    channel: "pi-muse-viewer",
    version: 1,
    type: "command",
    id: "command-3",
    command: "connect",
    args: {},
  });
  await waitMicrotasks();
  assert.deepEqual(posted.at(-1), {
    channel: "pi-muse-viewer",
    version: 1,
    type: "result",
    id: "command-3",
    ok: false,
    error: { code: "NOT_CONNECTED", message: "Viewer is not connected." },
  });
});

test("viewer bridge accepts iframe messages only from configured exact parent origin", async () => {
  const { viewerWindow, posted, targetOrigins, message } = createWindow({
    search: "?parentOrigin=https%3A%2F%2Fparent.test",
  });
  const adapter = createAdapter({ connected: true });
  createViewerBridge(adapter, { window: viewerWindow });
  assert.equal(posted.length, 1);
  assert.deepEqual(targetOrigins, ["https://parent.test"]);

  message({ source: {}, data: { id: "wrong-source" } });
  message({ origin: "https://evil.test", data: { id: "wrong-origin" } });
  message({
    data: {
      channel: "wrong-channel",
      version: 1,
      type: "command",
      id: "wrong-envelope",
      command: "connect",
      args: {},
    },
  });
  await waitMicrotasks();
  assert.equal(adapter.calls.length, 0);
  assert.equal(posted.length, 2);
  assert.deepEqual((posted.at(-1) as { error?: unknown }).error, {
    code: "INVALID_ARGUMENT",
    message: "Invalid viewer command arguments.",
  });

  message({
    data: {
      channel: "pi-muse-viewer",
      version: 1,
      type: "command",
      id: "connect-1",
      command: "connect",
      args: {},
    },
  });
  await waitMicrotasks();
  assert.equal(adapter.calls.length, 1);
  assert.equal((posted.at(-1) as { ok?: boolean }).ok, true);

  const invalid = createWindow({ search: "?parentOrigin=*" });
  await assert.rejects(
    async () => createViewerBridge(createAdapter(), { window: invalid.viewerWindow }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.equal(invalid.viewerWindow.piMuseViewer, undefined);

  const fromHash = createWindow({ hash: "#parentOrigin=https%3A%2F%2Fparent.test" });
  createViewerBridge(createAdapter(), { window: fromHash.viewerWindow });
  assert.equal(fromHash.posted.length, 1);
  assert.deepEqual(fromHash.targetOrigins, ["https://parent.test"]);

  for (const rawOrigin of ["null", "ftp://parent.test", "https://parent.test/path"]) {
    const rejected = createWindow({ search: `?parentOrigin=${encodeURIComponent(rawOrigin)}` });
    await assert.rejects(
      async () => createViewerBridge(createAdapter(), { window: rejected.viewerWindow }),
      { code: "INVALID_ARGUMENT" },
    );
  }
});

test("viewer bridge serializes RN transport as JSON", async () => {
  const { viewerWindow, postedJson } = createWindow({ reactNative: true });
  const adapter = createAdapter({ connected: true });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });

  assert.equal(postedJson.length, 1);
  assert.deepEqual(JSON.parse(postedJson[0]), {
    channel: "pi-muse-viewer",
    version: 1,
    type: "event",
    event: "ready",
    data: { connected: true },
  });

  bridge.receive(JSON.stringify({
    channel: "pi-muse-viewer",
    version: 1,
    type: "command",
    id: "native-1",
    command: "viewport.set",
    args: { mode: "scale", drag: true },
  }));
  await waitMicrotasks();
  assert.deepEqual(adapter.calls, [{
    command: "viewport.set",
    args: { mode: "scale", drag: true },
  }]);
  assert.deepEqual(JSON.parse(postedJson.at(-1) as string), {
    channel: "pi-muse-viewer",
    version: 1,
    type: "result",
    id: "native-1",
    ok: true,
    result: { command: "viewport.set", args: { mode: "scale", drag: true } },
  });
});

test("viewer bridge keeps top-level page dispatch local", async () => {
  const { viewerWindow, posted } = createWindow();
  viewerWindow.parent = viewerWindow;
  const adapter = createAdapter({ connected: true });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });

  assert.deepEqual(await bridge.dispatch("focus"), {
    command: "focus",
    args: {},
  });
  assert.deepEqual(posted, []);
});

test("viewer bridge forwards adapter events and detaches on dispose", () => {
  const { viewerWindow, posted, message } = createWindow();
  const adapter = createAdapter({ connected: true });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });
  const events: TransportEnvelope[] = [];
  bridge.subscribe((envelope) => events.push(envelope));

  adapter.emit({ event: "state", data: { connected: false } });
  adapter.emit({ event: "clipboard", data: { text: "clipboard-text" } });
  assert.deepEqual(events, [
    {
      channel: "pi-muse-viewer",
      version: 1,
      type: "event",
      event: "ready",
      data: { connected: true },
    },
    {
      channel: "pi-muse-viewer",
      version: 1,
      type: "event",
      event: "state",
      data: { connected: false },
    },
    {
      channel: "pi-muse-viewer",
      version: 1,
      type: "event",
      event: "clipboard",
      data: { text: "clipboard-text" },
    },
  ]);
  assert.equal(posted.length, 3);
  assert.deepEqual(bridge.getState(), adapter.getState());

  bridge.dispose();
  assert.equal(adapter.unsubscribed, true);
  assert.equal(viewerWindow.piMuseViewer, undefined);
  const lateEvents: TransportEnvelope[] = [];
  bridge.subscribe((envelope) => lateEvents.push(envelope));
  assert.deepEqual(lateEvents, []);

  adapter.emit({ event: "state", data: { connected: true } });
  message({
    data: {
      channel: "pi-muse-viewer",
      version: 1,
      type: "command",
      id: "after-dispose",
      command: "connect",
      args: {},
    },
  });
  bridge.receive({
    channel: "pi-muse-viewer",
    version: 1,
    type: "command",
    id: "direct-after-dispose",
    command: "connect",
    args: {},
  });
  assert.equal(adapter.calls.length, 0);
  assert.equal(events.length, 3);
  assert.equal(posted.length, 3);
});

test("viewer bridge does not post an in-flight result after dispose", async () => {
  const { viewerWindow, posted } = createWindow();
  const adapter = createAdapter({ connected: true });
  const bridge = createViewerBridge(adapter, { window: viewerWindow });
  let resolveExecution: (value: unknown) => void = () => {};
  adapter.execute = () => new Promise((resolve) => {
    resolveExecution = resolve;
  });

  bridge.receive({
    channel: "pi-muse-viewer",
    version: 1,
    type: "command",
    id: "in-flight",
    command: "connect",
    args: {},
  });
  bridge.dispose();
  resolveExecution({ connected: true });
  await waitMicrotasks();

  assert.deepEqual(posted.map((envelope) => envelope.type), ["event"]);
});

test("viewer bridge state projection is serializable without scanning page parameters", async () => {
  const { viewerWindow } = createWindow({
    search: "?password=not-a-model-key&parentOrigin=https%3A%2F%2Fparent.test",
  });
  const state = {
    connected: true,
    note: "password",
    nested: { enabled: true, count: 2 },
  };
  const adapter = createAdapter(state);
  const bridge = createViewerBridge(adapter, { window: viewerWindow });

  assert.deepEqual(bridge.getState(), state);
  assert.deepEqual(
    await bridge.dispatch("state.get"),
    state,
  );
  assert.equal(adapter.calls.length, 0);
});
