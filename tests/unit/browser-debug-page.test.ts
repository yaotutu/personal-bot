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
  const timers = new Map<number, () => Promise<unknown>>();
  const saves: Array<{ name: string; blob: Blob }> = [];
  const revoked: string[] = [];
  let confirmDelete = false;
  let nextTimer = 0;
  const objectUrls = new Map<string, Blob>();
  class PageUrl extends URL {
    static createObjectURL(blob: Blob) { const url = "blob:test-" + objectUrls.size; objectUrls.set(url, blob); return url; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const draw = { calls: 0, clears: 0, drawImage() { this.calls++; }, clearRect() { this.clears++; } };
  const element = (tag = "div") => {
    const node: any = {
      tag, style: {}, value: "", textContent: "", href: "", download: "", disabled: false, hidden: false, files: [] as any[], children: [] as any[], parentNode: null, root: false,
      clientWidth: 1280, clientHeight: 800, width: 1280, height: 800,
      get isConnected() { let current = this; while (current) { if (current.root) return true; current = current.parentNode; } return false; },
      replaceChildren(...children: any[]) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); },
      appendChild(child: any) { child.remove(); this.children.push(child); child.parentNode = this; },
      append(...children: any[]) { for (const child of children) this.appendChild(child); },
      remove() { if (!this.parentNode) return; const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; },
      getContext: () => draw, setPointerCapture() {},
      click() { if (this.tag === "a") saves.push({ name: this.download, blob: objectUrls.get(this.href)! }); },
    };
    return node;
  };
  const document = { getElementById(id: string) { if (!elements.has(id)) { const node = element(); node.root = true; elements.set(id, node); } return elements.get(id); }, createElement: element, body: element("body"), activeElement: null };
  const location = new PageUrl(initialUrl);
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
    document, location, URL: PageUrl, history: { state: null, replaceState(_state: unknown, _title: string, url: string) { replaced = url; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async (path: string, options: Request["options"]) => {
      requests.push({ path, options });
      const response = responses.shift(); assert.ok(response, `unexpected request ${path}`);
      return { status: response.status ?? 200, ok: (response.status ?? 200) < 400, json: async () => response.body };
    },
    WebSocket: Socket, Image: class { width = 1280; height = 800; src = ""; onload?: () => void; onerror?: () => void; constructor() { images.push(this); } },
    Blob, TextDecoder, Uint8Array, DataView, btoa, atob, performance: { now: () => 100 },
    KeyboardEvent: class { constructor(public type: string, public options: unknown) {} },
    window: { addEventListener(type: string, listener: () => void) { if (type === "blur") onBlur = listener; }, confirm: () => confirmDelete },
    setInterval: (callback: () => Promise<unknown>, delay: number) => { assert.equal(delay, 2000); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval: (id: number) => timers.delete(id),
  });
  const get = (id: string) => document.getElementById(id);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const login = async () => {
    responses.push({ body: { token: "test-token" } }, { body: { tabs: [] } }, { body: { ticket: "test-ticket" } });
    get("accessKey").value = "secret";
    await get("login").onsubmit({ preventDefault() {} });
    sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: "ready", tabs: [], activeTabId: null }) });
  };
  return { get, requests, responses, sockets, images, storage, draw, flush, login, blur: () => onBlur(), replaced: () => replaced,
    timers, tick: async () => { for (const callback of timers.values()) await callback(); }, saves, revoked, confirm: (value: boolean) => { confirmDelete = value; } };
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

const pendingUpload = (id = "upload-1", multiple = false) => ({ id, tabId: "one", multiple, accept: ".txt", createdAt: "2026-10-30T00:00:00Z" });
const browserDownload = (id: string, status: string) => ({ id, tabId: "one", name: "report.txt", status, bytes: status === "completed" ? 2 : null, createdAt: "2026-10-30T00:00:00Z", error: status === "failed" ? "Failed safely" : null });
const fileSnapshot = (uploads: unknown[] = [], downloads: unknown[] = []) => ({ uploads, downloads });
const chosenFile = (name: string, size = 2, type = "") => ({ name, size, type, arrayBuffer: async () => Uint8Array.from([1, 2]).buffer });

test("files poll only while the panel is open and online; read errors retain the last list", async () => {
  const app = page(); await app.login();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  assert.equal(app.requests.filter((request) => request.path === "/api/browser/files").length, 0);
  app.responses.push({ body: fileSnapshot([pendingUpload()]) });
  await app.get("filesToggle").onclick();
  assert.equal(app.get("filesPanel").hidden, false);
  assert.equal(app.timers.size, 1);
  assert.match(app.get("uploads").children[1].children[0].textContent, /one/);
  app.responses.push({ status: 503, body: { error: "read failed" } });
  await app.get("filesRefresh").onclick();
  assert.match(app.get("filesStatus").textContent, /read failed/);
  assert.equal(app.get("uploads").children.length, 2);
  app.responses.push({ body: fileSnapshot() }); await app.tick();
  assert.equal(app.get("uploads").children.length, 2);
  app.get("filesClose").onclick();
  assert.equal(app.get("filesPanel").hidden, true);
  assert.equal(app.timers.size, 0);
  const reads = app.requests.filter((request) => request.path === "/api/browser/files").length;
  await app.tick(); assert.equal(app.requests.filter((request) => request.path === "/api/browser/files").length, reads);
  app.responses.push({ body: fileSnapshot() }); await app.get("filesToggle").onclick();
  app.sockets[0]?.onclose?.();
  assert.equal(app.timers.size, 0);
  assert.equal(app.get("filesPanel").hidden, true);
});

test("polling keeps the same upload picker connected until its request disappears or the panel closes", async () => {
  const app = page(); await app.login();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  app.responses.push({ body: fileSnapshot([pendingUpload()]) }); await app.get("filesToggle").onclick();
  const controls = () => app.get("uploads").children[1].children[1];
  const picker = controls().children[0];
  assert.equal(picker.isConnected, true);
  app.responses.push({ body: fileSnapshot([pendingUpload()]) }); await app.tick();
  assert.equal(controls().children[0], picker);
  assert.equal(picker.isConnected, true);
  picker.files = [chosenFile("chosen.txt")]; picker.onchange();
  assert.equal(controls().children[0], picker);
  assert.equal(controls().children[1].disabled, false);
  app.responses.push({ body: fileSnapshot([pendingUpload()]) }); await app.tick();
  assert.equal(controls().children[0], picker);
  assert.equal(controls().children[1].disabled, false);
  assert.match(app.get("uploads").children[1].children[0].textContent, /chosen.txt/);
  app.responses.push({ body: fileSnapshot() }); await app.tick();
  assert.equal(picker.isConnected, false);
  app.responses.push({ body: fileSnapshot([pendingUpload("next")]) }); await app.tick();
  const nextPicker = controls().children[0];
  assert.notEqual(nextPicker, picker);
  assert.equal(nextPicker.isConnected, true);
  app.get("filesClose").onclick();
  assert.equal(nextPicker.isConnected, false);
});

test("session expiry closes the file panel and stops polling", async () => {
  const app = page(); await app.login();
  app.responses.push({ body: fileSnapshot() }); await app.get("filesToggle").onclick();
  app.responses.push({ status: 401, body: { error: "unauthorized" } });
  await app.get("filesRefresh").onclick();
  assert.equal(app.get("filesPanel").hidden, true);
  assert.equal(app.timers.size, 0);
  assert.equal(app.storage.size, 0);
  assert.equal(app.get("filesToggle").disabled, true);
});

test("uploads require explicit selection and submit, enforce limits, and retain selection after failure", async () => {
  const app = page(); await app.login();
  app.sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [tab("one", true)], activeTabId: "one" }) });
  app.responses.push({ body: fileSnapshot([pendingUpload()]) }); await app.get("filesToggle").onclick();
  const controls = () => app.get("uploads").children[1].children[1];
  assert.equal(controls().children[1].disabled, true);
  assert.equal(app.requests.filter((request) => request.options.method === "POST" && request.path.includes("uploads")).length, 0);
  controls().children[0].files = [chosenFile("one.txt"), chosenFile("two.txt")]; controls().children[0].onchange();
  await controls().children[1].onclick();
  assert.match(app.get("filesStatus").textContent, /at most 1/);
  controls().children[0].files = [chosenFile("too-big.txt", 9 * 1024 * 1024)]; controls().children[0].onchange();
  await controls().children[1].onclick();
  assert.match(app.get("filesStatus").textContent, /8 MiB/);
  controls().children[0].files = [chosenFile(".my file?.txt")]; controls().children[0].onchange();
  assert.match(app.get("uploads").children[1].children[0].textContent, /my file/);
  app.responses.push({ status: 503, body: { error: "result unknown" } }, { body: fileSnapshot([pendingUpload()]) });
  await controls().children[1].onclick();
  assert.match(app.get("filesStatus").textContent, /result unknown/);
  assert.match(app.get("uploads").children[1].children[0].textContent, /my file/);
  const writes = app.requests.filter((request) => request.options.method === "POST" && request.path.includes("uploads"));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!.options.body!), { files: [{ name: "my-file-.txt", mimeType: "application/octet-stream", contentBase64: "AQI=" }] });
  app.responses.push({ body: { ok: true } }, { body: fileSnapshot() });
  await controls().children[1].onclick();
  assert.equal(app.requests.filter((request) => request.options.method === "POST" && request.path.includes("uploads")).length, 2);
  assert.match(app.get("uploads").children[1].textContent, /No pending uploads/);
});

test("multiple chooser allows four files but rejects a fifth before reading", async () => {
  const app = page(); await app.login();
  app.responses.push({ body: fileSnapshot([pendingUpload("many", true)]) }); await app.get("filesToggle").onclick();
  const controls = () => app.get("uploads").children[1].children[1];
  controls().children[0].files = Array.from({ length: 5 }, (_, index) => chosenFile("file-" + index + ".txt"));
  controls().children[0].onchange(); await controls().children[1].onclick();
  assert.match(app.get("filesStatus").textContent, /at most 4/);
  assert.equal(app.requests.filter((request) => request.options.method === "POST" && request.path.includes("uploads")).length, 0);
  controls().children[0].files = Array.from({ length: 4 }, (_, index) => chosenFile("file-" + index + ".txt", 2, "text/plain"));
  controls().children[0].onchange();
  app.responses.push({ body: { ok: true } }, { body: fileSnapshot() });
  await controls().children[1].onclick();
  const write = app.requests.find((request) => request.path === "/api/browser/uploads/many" && request.options.method === "POST");
  assert.equal(JSON.parse(write!.options.body!).files.length, 4);
  assert.equal(JSON.parse(write!.options.body!).files[0].mimeType, "text/plain");
});

test("upload cancellation only removes its item; downloads save only completed content and delete after confirmation", async () => {
  const app = page(); await app.login();
  const downloads = [browserDownload("running", "downloading"), browserDownload("failed", "failed"), browserDownload("done", "completed")];
  app.responses.push({ body: fileSnapshot([pendingUpload()], downloads) }); await app.get("filesToggle").onclick();
  const downloadRow = () => app.get("downloads").children[3];
  assert.equal(app.get("downloads").children[1].children[1].children.length, 1);
  assert.equal(app.get("downloads").children[2].children[1].children.length, 1);
  app.responses.push({ status: 409, body: { error: "not completed" } });
  await downloadRow().children[1].children[0].onclick();
  assert.equal(app.saves.length, 0);
  assert.match(app.get("filesStatus").textContent, /not completed/);
  let resolveContent!: (value: unknown) => void;
  const delayedContent = new Promise<unknown>((resolve) => { resolveContent = resolve; });
  app.responses.push({ body: delayedContent });
  const saving = downloadRow().children[1].children[0].onclick();
  await app.flush();
  app.responses.push({ body: fileSnapshot([pendingUpload()], downloads) }); await app.tick();
  resolveContent({ name: "../bad name.txt", mimeType: "", contentBase64: "AQI=" });
  await saving;
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0]?.name, "-bad-name.txt");
  assert.deepEqual([...new Uint8Array(await app.saves[0]!.blob.arrayBuffer())], [1, 2]);
  assert.equal(app.revoked.length, 1);
  await downloadRow().children[1].children[1].onclick();
  assert.equal(app.requests.filter((request) => request.options.method === "DELETE").length, 0);
  app.confirm(true);
  app.responses.push({ body: { ok: true } }, { body: fileSnapshot([pendingUpload()], downloads.slice(0, 2)) });
  await downloadRow().children[1].children[1].onclick();
  assert.equal(app.requests.filter((request) => request.path === "/api/browser/downloads/done" && request.options.method === "DELETE").length, 1);
  app.responses.push({ body: { ok: true } }, { body: fileSnapshot([], downloads.slice(0, 2)) });
  await app.get("uploads").children[1].children[1].children[2].onclick();
  assert.equal(app.requests.filter((request) => request.path === "/api/browser/uploads/upload-1" && request.options.method === "DELETE").length, 1);
});
