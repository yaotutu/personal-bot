import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { browserDebugPage } from "../../src/http/browser-debug-page.js";

type Request = { path: string; options: { method?: string; body?: string } };

/** 只模拟调试页 DOM/传输边界；真实 Chrome 与模型验收由隔离实例另行执行。 */
const page = (initialUrl = "http://localhost/browser") => {
  const requests: Request[] = [];
  const responses: Array<{ status?: number; body: unknown }> = [];
  const images: Array<{ onload?: () => void; onerror?: () => void; width: number; height: number; src: string }> = [];
  const sockets: Array<{ readyState: number; sent: unknown[]; onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: unknown }) => void; close: () => void; send: (value: string) => void }> = [];
  const storage = new Map<string, string>();
  const elements = new Map<string, any>();
  const draw = { calls: 0, clears: 0, drawImage() { this.calls++; }, clearRect() { this.clears++; } };
  const element = () => ({
    style: {}, value: "", textContent: "", disabled: false, children: [] as any[], clientWidth: 1280, clientHeight: 800,
    width: 1280, height: 800, replaceChildren(...children: any[]) { this.children = children; },
    appendChild(child: any) { this.children.push(child); }, getContext: () => draw, setPointerCapture() {},
  });
  const document = { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, activeElement: null };
  const location = new URL(initialUrl);
  let replaced = "";
  let onBlur = () => {};
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: unknown[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    constructor(public url: string) { sockets.push(this); }
    close() { this.readyState = 3; }
    send(value: string) { this.sent.push(JSON.parse(value)); }
  }
  const script = browserDebugPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document, location, URL, history: { state: null, replaceState(_state: unknown, _title: string, url: string) { replaced = url; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async (path: string, options: Request["options"]) => {
      requests.push({ path, options });
      const response = responses.shift(); assert.ok(response, `unexpected request ${path}`);
      return { status: response.status ?? 200, ok: (response.status ?? 200) < 400, json: async () => response.body };
    },
    WebSocket: Socket, Image: class { width = 1280; height = 800; src = ""; onload?: () => void; onerror?: () => void; constructor() { images.push(this); } },
    Blob, TextDecoder, Uint8Array, DataView, performance: { now: () => 100 },
    KeyboardEvent: class { constructor(public type: string, public options: unknown) {} },
    window: { addEventListener(type: string, listener: () => void) { if (type === "blur") onBlur = listener; } },
  });
  const get = (id: string) => document.getElementById(id);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const login = async () => {
    responses.push({ body: { token: "test-token" } }, { body: { tabs: [] } }, { body: { ticket: "test-ticket" } });
    get("accessKey").value = "secret";
    await get("login").onsubmit({ preventDefault() {} });
    sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: "ready", tabs: [], activeTabId: null }) });
  };
  return { get, requests, responses, sockets, images, storage, draw, flush, login, blur: () => onBlur(), replaced: () => replaced };
};

const tab = (id: string, active: boolean) => ({ id, title: id, url: "about:blank", active, loading: false });
const frame = (tabId: string, frameId: number) => {
  const metadata = { type: "frame", frameId, tabId, sessionId: "session", width: 1280, height: 800 };
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(4 + encoded.length + 1);
  new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4);
  return bytes.buffer;
};

test("single-tab write responses preserve the authoritative full tab list", async () => {
  const app = page(); await app.login();
  const full = { tabs: [tab("one", true), tab("two", false)] };
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", ...full, activeTabId: "one" }) });
  app.responses.push({ body: tab("two", true) }, { body: { tabs: [tab("one", false), tab("two", true)] } });
  await app.get("tabs").children[1].onclick();
  assert.equal(app.get("tabs").children.length, 2);
  assert.equal(app.get("tabs").children[1].className, "tab active");
  app.responses.push({ body: tab("two", true) }, { body: { tabs: [tab("one", false), tab("two", true)] } });
  await app.get("reload").onclick();
  assert.equal(app.get("tabs").children.length, 2);
  assert.equal(app.requests.filter((request) => request.options.method === "POST" && request.path.includes("navigation")).length, 1);
});

test("an uncertain write reads the tab list without repeating the write", async () => {
  const app = page(); await app.login();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  app.responses.push({ status: 503, body: { error: "response unavailable" } }, { body: { tabs: [tab("one", true), tab("two", false)] } });
  await app.get("newTab").onclick();
  assert.equal(app.get("tabs").children.length, 2);
  assert.equal(app.requests.filter((request) => request.path === "/api/browser/tabs" && request.options.method === "POST").length, 1);
  assert.equal(app.get("status").textContent, "response unavailable");
});

test("stale sockets and late images cannot restore controls or overwrite a newer frame", async () => {
  const app = page(); await app.login();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  const metadata = { type: "frame", frameId: 1, tabId: "one", sessionId: "session", width: 1280, height: 800 };
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(4 + encoded.length + 1);
  new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4);
  app.sockets[0]?.onmessage?.({ data: bytes.buffer });
  assert.equal(app.images.length, 1);
  app.responses.push({ body: { ticket: "next-ticket" } });
  await app.get("reconnect").onclick();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [], activeTabId: null }) });
  app.sockets[0]?.onclose?.(); app.images[0]?.onload?.();
  assert.equal(app.get("keyboard").disabled, true);
  assert.equal(app.draw.calls, 0);
  assert.equal(app.sockets[0]?.sent.filter((message: any) => message.type === "frame_ack").length, 0);
  assert.equal(app.get("tabs").children.length, 1);
  app.sockets[1]?.onmessage?.({ data: JSON.stringify({ type: "ready", tabs: [tab("one", true)], activeTabId: "one" }) });
  assert.equal(app.get("keyboard").disabled, false);
  app.sockets[1]?.onclose?.();
  assert.equal(app.get("keyboard").disabled, true);
  assert.match(app.get("status").textContent, /Disconnected/);
});

test("current socket acknowledges discarded tab frames and late images exactly once", async () => {
  const app = page(); await app.login();
  const socket = app.sockets[0]!;
  socket.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true), tab("two", false)], activeTabId: "one" }) });
  socket.onmessage?.({ data: frame("one", 1) });
  assert.equal(app.images.length, 1);
  socket.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", false), tab("two", true)], activeTabId: "two" }) });
  socket.onmessage?.({ data: frame("one", 2) });
  assert.equal(app.images.length, 1);
  app.images[0]?.onload?.(); app.images[0]?.onload?.();
  assert.equal(app.draw.calls, 0);
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "frame_ack").map((message: any) => message.frameId), [2, 1]);
  socket.onmessage?.({ data: frame("two", 3) });
  app.images[1]?.onerror?.();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "frame_ack").map((message: any) => message.frameId), [2, 1, 3]);
});

test("reconnect and window blur release held input only while the socket is writable", async () => {
  const app = page(); await app.login();
  const socket = app.sockets[0]!;
  socket.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  socket.onmessage?.({ data: frame("one", 1) }); app.images[0]?.onload?.();
  const stage = app.get("keyboard");
  const press = () => {
    stage.onpointerdown({ pointerId: 5, button: 0, offsetX: 20, offsetY: 20, preventDefault() {} });
    stage.onkeydown({ key: "Control", code: "ControlLeft", preventDefault() {} });
  };
  press(); app.blur(); app.blur();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "pointer_up" || message.type === "key_up").map((message: any) => message.type), ["pointer_up", "key_up"]);
  press();
  app.responses.push({ body: { ticket: "next-ticket" } });
  await app.get("reconnect").onclick();
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "pointer_up" || message.type === "key_up").map((message: any) => message.type), ["pointer_up", "key_up", "pointer_up", "key_up"]);
  app.sockets[1]?.onmessage?.({ data: JSON.stringify({ type: "ready", tabs: [tab("one", true)], activeTabId: "one" }) });
  app.sockets[1]?.onmessage?.({ data: frame("one", 2) }); app.images[1]?.onload?.();
  stage.onkeydown({ key: "Control", code: "ControlLeft", preventDefault() {} });
  app.sockets[1]!.readyState = 3; app.sockets[1]?.onclose?.(); app.blur();
  assert.equal(app.sockets[1]?.sent.filter((message: any) => message.type === "key_up").length, 0);
});

test("login removes URL keys and clears plaintext; inputs carry valid buttons, text, and keys", async () => {
  const app = page("http://localhost/browser?accessKey=leak&key=also-leak&view=1#stage");
  assert.equal(app.replaced(), "/browser?view=1#stage");
  await app.login();
  assert.equal(app.get("accessKey").value, "");
  assert.equal(app.storage.get("pi-muse-browser-token"), "test-token");
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  const metadata = { type: "frame", frameId: 1, tabId: "one", sessionId: "session", width: 1280, height: 800 };
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const bytes = new Uint8Array(4 + encoded.length + 1);
  new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4);
  app.sockets[0]?.onmessage?.({ data: bytes.buffer }); app.images[0]?.onload?.();
  const stage = app.get("keyboard");
  stage.onpointerdown({ pointerId: 7, button: 2, offsetX: 20, offsetY: 20, preventDefault() {} });
  stage.onpointercancel({ pointerId: 7, button: 2, offsetX: 20, offsetY: 20 });
  stage.value = "paste text"; stage.oninput({ data: "paste text" });
  stage.oncompositionstart(); stage.value = "汉"; stage.oninput({ data: "汉" });
  assert.equal(stage.value, "汉");
  stage.oncompositionend({ data: "汉" }); stage.value = "汉"; stage.oninput({ data: "汉" });
  const event = (key: string, extra: Record<string, unknown> = {}) => ({ key, code: key, preventDefault() {}, ...extra });
  stage.onkeydown(event("Control")); stage.onkeydown(event("a", { ctrlKey: true }));
  stage.onkeyup(event("a", { ctrlKey: true })); stage.onkeyup(event("Control"));
  stage.onkeydown(event("/", { code: "Slash", ctrlKey: true })); stage.onkeyup(event("/", { code: "Slash", ctrlKey: true }));
  stage.onkeydown(event("Unidentified"));
  const sent = app.sockets[0]?.sent as Array<Record<string, unknown>>;
  assert.deepEqual(sent.filter((message) => message.type === "pointer_down" || message.type === "pointer_up").map((message) => [message.type, message.button]), [["pointer_down", "right"], ["pointer_up", "right"]]);
  assert.deepEqual(sent.filter((message) => message.type === "insert_text").map((message) => message.text), ["paste text", "汉"]);
  assert.deepEqual(sent.filter((message) => message.type === "key_down" || message.type === "key_up").map((message) => [message.type, message.key]), [["key_down", "Control"], ["key_down", "a"], ["key_up", "a"], ["key_up", "Control"], ["key_down", "Slash"], ["key_up", "Slash"]]);
});
