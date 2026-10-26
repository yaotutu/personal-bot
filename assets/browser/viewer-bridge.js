/*
 * noVNC Viewer Control Bridge 的非视觉协议核心。
 * 这一层只负责命令校验、postMessage/RN JSON 传输和受控错误回执；
 * 它不认识 RFB、DOM 工具条或业务 API，替换外部 UI 时不需要触碰 noVNC 内部。
 */

const CHANNEL = "pi-muse-viewer";
const VERSION = 1;
const RECENT_COMMAND_LIMIT = 128;

const COMMAND_SCHEMAS = {
  "state.get": {},
  connect: {},
  disconnect: {},
  reconnect: {},
  focus: {},
  "toolbar.set": { visible: "boolean" },
  "keyboard.set": { visible: "boolean" },
  "key.send": {
    keysym: "integer",
    code: "optional-string",
    down: "optional-boolean",
  },
  "text.send": { text: "string" },
  "clipboard.set": { text: "string" },
  "viewport.set": {
    mode: ["scale", "clip", "native"],
    drag: "optional-boolean",
  },
  "viewOnly.set": { enabled: "boolean" },
  "fullscreen.set": { enabled: "boolean" },
};

const ERROR_MESSAGES = {
  UNKNOWN_COMMAND: "Unknown viewer command.",
  INVALID_ARGUMENT: "Invalid viewer command arguments.",
  NOT_CONNECTED: "Viewer is not connected.",
  UNSUPPORTED: "Viewer does not support this command.",
  USER_GESTURE_REQUIRED: "This viewer command requires a user gesture.",
  OPERATION_FAILED: "Viewer command failed.",
};

const ADAPTER_ERROR_CODES = new Set([
  "NOT_CONNECTED",
  "UNSUPPORTED",
  "USER_GESTURE_REQUIRED",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.includes(key));
}

function invalidArgument() {
  const error = new Error(ERROR_MESSAGES.INVALID_ARGUMENT);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function controlledError(code, message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.OPERATION_FAILED) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function adapterError(error) {
  const code = isRecord(error) && ADAPTER_ERROR_CODES.has(error.code)
    ? error.code
    : "OPERATION_FAILED";
  return controlledError(code);
}

function validateCommand(command, args) {
  if (typeof command !== "string" || !Object.hasOwn(COMMAND_SCHEMAS, command)) {
    return controlledError("UNKNOWN_COMMAND");
  }
  if (!isRecord(args) || !hasOnlyKeys(args, Object.keys(COMMAND_SCHEMAS[command]))) {
    return invalidArgument();
  }

  for (const [key, rule] of Object.entries(COMMAND_SCHEMAS[command])) {
    const value = args[key];
    if (rule === "boolean" && typeof value !== "boolean") return invalidArgument();
    if (rule === "string" && (typeof value !== "string" || value.length > 10000)) {
      return invalidArgument();
    }
    if (rule === "optional-string" && value !== undefined &&
      (typeof value !== "string" || value.length > 64)) {
      return invalidArgument();
    }
    if (rule === "optional-boolean" && value !== undefined && typeof value !== "boolean") {
      return invalidArgument();
    }
    if (rule === "integer" &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 0x1fffffff)) {
      return invalidArgument();
    }
    if (Array.isArray(rule) && !rule.includes(value)) return invalidArgument();
  }
  return undefined;
}

function parseTransport(value) {
  let envelope = value;
  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return invalidArgument();
    }
  }
  if (!isRecord(envelope) ||
      !hasOnlyKeys(envelope, ["channel", "version", "type", "id", "command", "args"]) ||
      envelope.channel !== CHANNEL ||
      envelope.version !== VERSION ||
      envelope.type !== "command" ||
      typeof envelope.id !== "string" ||
      envelope.id.length === 0 ||
      typeof envelope.command !== "string" ||
      !isRecord(envelope.args)) {
    return invalidArgument();
  }
  return undefined;
}

function serializeState(state) {
  try {
    assertJsonValue(state);
    const serialized = JSON.parse(JSON.stringify(state));
    if (serialized === undefined) throw new Error("empty state");
    return serialized;
  } catch {
    throw controlledError("OPERATION_FAILED");
  }
}

function assertJsonValue(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error("non-json value");
  if (ancestors.has(value)) throw new Error("cyclic value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, ancestors);
      return;
    }
    for (const item of Object.values(value)) {
      if (item === undefined) throw new Error("undefined field");
      assertJsonValue(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeResult(result) {
  if (result === undefined) return undefined;
  return serializeState(result);
}

function readParentOrigin(viewerWindow) {
  const search = new URLSearchParams(viewerWindow.location.search);
  let raw = search.get("parentOrigin");
  if (raw === null) {
    const hash = viewerWindow.location.hash.replace(/^#/, "");
    raw = new URLSearchParams(hash).get("parentOrigin");
  }
  if (raw === null) raw = viewerWindow.location.origin;
  if (raw === "*" || raw === "null") throw invalidArgument();

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidArgument();
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== raw) {
    throw invalidArgument();
  }
  return parsed.origin;
}

export function createViewerBridge(adapter, options = {}) {
  const viewerWindow = options.window ?? window;
  const parentOrigin = readParentOrigin(viewerWindow);
  const subscribers = new Set();
  const inFlight = new Map();
  const completedIds = new Set();
  const recentIds = [];
  let disposed = false;
  let lastState;
  let readyEnvelope;
  let unsubscribeAdapter;

  function rememberId(id) {
    if (completedIds.has(id) || inFlight.has(id)) return false;
    inFlight.set(id, true);
    return true;
  }

  function completeId(id) {
    inFlight.delete(id);
    completedIds.add(id);
    recentIds.push(id);
    if (recentIds.length > RECENT_COMMAND_LIMIT) {
      completedIds.delete(recentIds.shift());
    }
  }

  function postTransport(envelope) {
    if (disposed) return;
    const reactNativeWebView = viewerWindow.ReactNativeWebView;
    if (reactNativeWebView && typeof reactNativeWebView.postMessage === "function") {
      try {
        reactNativeWebView.postMessage(JSON.stringify(envelope));
      } catch {
        // 传输失败不重试；命令结果仍按 Promise 语义返回给页面内调用方。
      }
      return;
    }

    const parent = viewerWindow.parent;
    // 顶层页面没有外部宿主，页面内调用只走 dispatch/subscribe，不回发 self-message。
    if (parent === viewerWindow) return;
    if (parent && typeof parent.postMessage === "function") {
      try {
        parent.postMessage(envelope, parentOrigin);
      } catch {
        // 同上：postMessage 队列失败不触发命令重放。
      }
    }
  }

  function emitEvent(envelope) {
    if (disposed) return;
    for (const listener of subscribers) listener(envelope);
    postTransport(envelope);
  }

  function resultResponse(id, result) {
    completeId(id);
    postTransport({
      channel: CHANNEL,
      version: VERSION,
      type: "result",
      id,
      ok: true,
      result: result === undefined ? null : result,
    });
  }

  function errorResponse(id, error) {
    completeId(id);
    postTransport({
      channel: CHANNEL,
      version: VERSION,
      type: "result",
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  function readState() {
    try {
      lastState = serializeState(adapter.getState());
      return lastState;
    } catch (error) {
      throw adapterError(error);
    }
  }

  function dispatch(command, args = {}) {
    if (disposed) return Promise.reject(controlledError("OPERATION_FAILED"));
    const validationError = validateCommand(command, args);
    if (validationError) return Promise.reject(validationError);

    const commandArgs = { ...args };
    let execution;
    try {
      // 必须在 dispatch 的同步阶段调用 adapter，浏览器才能保留用户手势。
      execution = command === "state.get"
        ? readState()
        : adapter.execute(command, commandArgs);
    } catch (error) {
      return Promise.reject(adapterError(error));
    }
    return Promise.resolve(execution)
      .then(serializeResult)
      .catch((error) => {
        throw adapterError(error);
      });
  }

  function receiveMessage(event) {
    if (event.source !== viewerWindow.parent || event.origin !== parentOrigin) return;
    receive(event.data);
  }

  function receive(serializedOrObject) {
    if (disposed) return;
    const transportError = parseTransport(serializedOrObject);
    if (transportError) {
      const unparsed = typeof serializedOrObject === "string"
        ? undefined
        : serializedOrObject;
      if (isRecord(unparsed) && typeof unparsed.id === "string" && unparsed.id.length > 0) {
        if (rememberId(unparsed.id)) errorResponse(unparsed.id, transportError);
      }
      return;
    }

    const envelope = typeof serializedOrObject === "string"
      ? JSON.parse(serializedOrObject)
      : serializedOrObject;
    if (!rememberId(envelope.id)) return;

    const validationError = validateCommand(envelope.command, envelope.args);
    if (validationError) {
      errorResponse(envelope.id, validationError);
      return;
    }

    dispatch(envelope.command, envelope.args).then(
      (result) => resultResponse(envelope.id, result),
      (error) => errorResponse(envelope.id, error),
    );
  }

  function onAdapterEvent(event) {
    if (disposed || !isRecord(event)) return;
    if (event.event !== "state" && event.event !== "clipboard") return;
    let data;
    try {
      data = serializeState(event.data);
    } catch {
      return;
    }
    if (event.event === "state") lastState = data;
    emitEvent({
      channel: CHANNEL,
      version: VERSION,
      type: "event",
      event: event.event,
      data,
    });
  }

  const bridge = {
    dispatch,
    getState() {
      return disposed ? lastState : readState();
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      subscribers.add(listener);
      // ready 是当前状态快照，而不是需要重放的历史状态流。
      if (readyEnvelope) listener(readyEnvelope);
      return () => subscribers.delete(listener);
    },
    receive,
    dispose() {
      if (disposed) return;
      disposed = true;
      viewerWindow.removeEventListener("message", receiveMessage);
      unsubscribeAdapter?.();
      subscribers.clear();
      inFlight.clear();
      completedIds.clear();
      recentIds.length = 0;
      if (viewerWindow.piMuseViewer === bridge) delete viewerWindow.piMuseViewer;
    },
  };

  viewerWindow.piMuseViewer = bridge;
  viewerWindow.addEventListener("message", receiveMessage);

  try {
    lastState = serializeState(adapter.getState());
  } catch (error) {
    bridge.dispose();
    throw adapterError(error);
  }

  const ready = {
    channel: CHANNEL,
    version: VERSION,
    type: "event",
    event: "ready",
    data: lastState,
  };
  readyEnvelope = ready;
  emitEvent(ready);

  try {
    unsubscribeAdapter = adapter.subscribe(onAdapterEvent);
  } catch (error) {
    bridge.dispose();
    throw adapterError(error);
  }

  return bridge;
}
