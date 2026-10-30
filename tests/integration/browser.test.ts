import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { attachBrowserWebSocket } from "../../src/http/browser-websocket.js";
import { browserTab } from "../../src/http/contracts/browser.js";
import { createTools, registeredToolNames, skillToToolsMap } from "../../src/adapters/pi/tools/index.js";

const chromeExecutable = process.env.PI_MUSE_TEST_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const pageHtml = `<!doctype html>
<title>Browser fixture</title>
<style>button{position:absolute;left:20px;top:20px;width:120px;height:40px}input{position:absolute;left:20px;top:80px;width:240px;height:32px}a{position:absolute;left:20px;top:130px}</style>
<button id="click">Click</button><input id="text"><div id="count">Clicks:0</div><div id="tick">Tick:0</div>
<a id="download" href="/download">Download report</a>
<script>
let clicks=0;
document.getElementById('click').onclick=()=>{clicks++;document.getElementById('count').textContent='Clicks:'+clicks};
let ticks=0;setInterval(()=>{document.getElementById('tick').textContent='Tick:'+(++ticks)},100);
</script>`;

const secondHtml = `<!doctype html><title>Second fixture</title><main>second-page</main>`;

const uploadHtml = `<!doctype html>
<title>Upload fixture</title>
<style>input{position:absolute;left:20px;top:20px;width:260px;height:32px}</style>
<input id="file" type="file" accept=".txt,text/plain">
<main id="result">UPLOAD:none</main>
<script>
document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  document.getElementById('result').textContent = 'UPLOAD:' + (file ? await file.text() : 'none');
});
</script>`;

const downloadBytes = Buffer.from("browser-download-bytes");

const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
};

test("browser REST, WebSocket frames and inputs drive real system Chrome", {
  timeout: 60000,
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-browser-real-"));
  const fixture = await listen((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="report.txt"',
      });
      response.end(downloadBytes);
      return;
    }
    if (request.url === "/upload") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(uploadHtml);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/second" ? secondHtml : pageHtml);
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let apiServer: ReturnType<typeof serve> | undefined;
  let detachWebSocket: (() => void) | undefined;
  t.after(async () => {
    detachWebSocket?.();
    try { await service?.close(); }
    finally {
      if (apiServer) {
        if ("closeAllConnections" in apiServer) apiServer.closeAllConnections();
        await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
      }
      await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  service = await createService(createConfig({
    server: { host: "127.0.0.1", accessKey: "browser-test-access-key" },
    runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { browser: { enabled: true, allowPrivateTargets: true, executablePath: chromeExecutable } },
  }));
  apiServer = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!apiServer.listening) await once(apiServer, "listening");
  detachWebSocket = attachBrowserWebSocket(apiServer as unknown as Server, service.browser);
  const address = apiServer.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: "browser-test-access-key" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${method} ${path} failed: ${await response.text()}`);
    return response.json();
  };

  const debug = await fetch(base + "/browser");
  assert.equal(debug.status, 200);
  assert.match(debug.headers.get("content-type") ?? "", /text\/html/);
  const debugHtml = await debug.text();
  assert.match(debugHtml, /<canvas id="canvas"/);
  // 入口必须跟随实际访问地址：任意主机名、域名或反向代理地址都可复用同一页面。
  assert.match(debugHtml, /location\.host/);
  // 旧链接中的密钥只用于尽早清理地址栏，不得读取密钥值或自动登录。
  assert.match(debugHtml, /url\.searchParams\.delete\("accessKey"\)/);
  assert.match(debugHtml, /url\.searchParams\.delete\("key"\)/);
  assert.match(debugHtml, /history\.replaceState\(/);
  assert.doesNotMatch(debugHtml, /searchParams\.get\("(?:accessKey|key)"\)|requestSubmit\(\)/);
  assert.doesNotMatch(debugHtml, /127\.0\.0\.1:12330|localhost:12330/);
  const arbitraryHostDebug = await fetch(base + "/browser", {
    headers: { host: "browser-anywhere.example.test" },
  });
  assert.equal(arbitraryHostDebug.status, 200);
  assert.match(await arbitraryHostDebug.text(), /<canvas id="canvas"/);

  const openApi = await fetch(base + "/openapi.json").then((response) => response.json()) as {
    paths: Record<string, Record<string, { responses?: { "200"?: { content?: Record<string, unknown> } } }>>;
    "x-websocket-contracts"?: {
      browser?: {
        path?: string;
        frameFormat?: string;
        clientMessages?: Record<string, unknown>;
        serverMessages?: Record<string, unknown>;
        description?: string;
      };
    };
  };
  assert.match(
    JSON.stringify(openApi.paths["/browser"]?.get?.responses?.["200"]?.content ?? {}),
    /text\/html/,
  );
  const webSocketContract = openApi["x-websocket-contracts"]?.browser;
  assert.equal(webSocketContract?.path, "/ws/browser");
  assert.match(webSocketContract?.frameFormat ?? "", /uint32be/);
  assert.ok(webSocketContract?.clientMessages?.frame_ack);
  assert.ok(webSocketContract?.clientMessages?.input);
  assert.ok(webSocketContract?.serverMessages?.ready);
  assert.match(webSocketContract?.description ?? "", /一次性 60 秒 ticket/);

  // 首次 REST 调用必须懒启动真实 Chrome；初始标签保持 about:blank。
  const initial = await request("/api/browser/tabs") as { tabs: unknown[] };
  assert.equal(initial.tabs.length, 1);
  assert.deepEqual(initial.tabs[0], browserTab.parse(initial.tabs[0]));

  const tab = browserTab.parse(await request("/api/browser/tabs", { url: fixture.url }));
  assert.equal(tab.loading, false);
  assert.equal(tab.url, fixture.url + "/");

  const ticketResponse = await request("/api/browser/ws-ticket", {});
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/browser?ticket=${encodeURIComponent(ticketResponse.ticket)}`);
  const messages: unknown[] = [];
  const frames: { metadata: { frameId: number; tabId: string; sessionId: string; width: number; height: number }; jpeg: Uint8Array }[] = [];
  ws.binaryType = "nodebuffer";
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      messages.push(JSON.parse(String(data)));
      return;
    }
    const raw = data as Buffer;
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const metadataLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength)));
    frames.push({ metadata, jpeg: bytes.subarray(4 + metadataLength) });
    ws.send(JSON.stringify({ type: "frame_ack", frameId: metadata.frameId, sessionId: metadata.sessionId }));
  });
  await once(ws, "open");

  const waitUntil = async (predicate: () => boolean, label: string) => {
    for (let index = 0; index < 600; index++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const waitUntilAsync = async (predicate: () => Promise<boolean>, label: string) => {
    for (let index = 0; index < 600; index++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  await waitUntil(() => messages.some((message) => (message as { type?: string }).type === "ready"), "WS ready");
  await waitUntil(() => frames.length >= 2, "multiple JPEG frames");
  for (const frame of frames) {
    assert.ok(frame.jpeg.length > 100);
    assert.equal(frame.jpeg[0], 0xff);
    assert.equal(frame.jpeg[1], 0xd8);
    assert.equal(frame.jpeg[2], 0xff);
    assert.ok(frame.metadata.width > 0);
    assert.ok(frame.metadata.height > 0);
  }

  ws.send(JSON.stringify({ type: "click", x: 70, y: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  ws.send(JSON.stringify({ type: "click", x: 120, y: 96 }));
  ws.send(JSON.stringify({ type: "insert_text", text: "hello-browser" }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const browserService = service.browser;
  assert.ok(browserService);
  const snapshot = await browserService.snapshot(tab.id);
  assert.equal(snapshot.untrusted, true);
  assert.match(snapshot.text, /Clicks:1/);
  assert.ok(snapshot.elements.some((element) => element.name === "hello-browser"));

  await request(`/api/browser/tabs/${tab.id}/navigation`, {
    action: "navigate",
    url: fixture.url + "/upload",
  });
  const uploadSnapshot = await browserService.snapshot(tab.id);
  const fileInput = uploadSnapshot.elements.find((element) => element.tag === "input");
  assert.ok(fileInput);
  await browserService.act(tab.id, { action: "click", ref: fileInput.ref });
  let pendingFiles = { uploads: [] as { id: string; multiple: boolean; accept: string }[], downloads: [] as unknown[] };
  await waitUntilAsync(async () => {
    pendingFiles = await request("/api/browser/files") as typeof pendingFiles;
    return pendingFiles.uploads.length === 1;
  }, "real filechooser");
  assert.equal(pendingFiles.uploads[0]?.multiple, false);
  assert.equal(pendingFiles.uploads[0]?.accept, ".txt,text/plain");
  await request(`/api/browser/uploads/${pendingFiles.uploads[0]!.id}`, {
    files: [{
      name: "hello.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello").toString("base64"),
    }],
  });
  await waitUntilAsync(async () => {
    const current = await browserService.snapshot(tab.id);
    return current.text.includes("UPLOAD:hello");
  }, "in-memory upload bytes in page");

  await browserService.act(tab.id, { action: "click", ref: fileInput.ref });
  await waitUntilAsync(async () => {
    pendingFiles = await request("/api/browser/files") as typeof pendingFiles;
    return pendingFiles.uploads.length === 1;
  }, "second real filechooser");
  await request(`/api/browser/uploads/${pendingFiles.uploads[0]!.id}`, undefined, "DELETE");
  await waitUntilAsync(async () => {
    pendingFiles = await request("/api/browser/files") as typeof pendingFiles;
    return pendingFiles.uploads.length === 0;
  }, "upload cancellation");

  await request(`/api/browser/tabs/${tab.id}/navigation`, { action: "navigate", url: fixture.url });
  const downloadSnapshot = await browserService.snapshot(tab.id);
  const downloadLink = downloadSnapshot.elements.find((element) => element.name === "Download report");
  assert.ok(downloadLink);
  await browserService.act(tab.id, { action: "click", ref: downloadLink.ref });
  let completedDownload: { id: string; status: string; bytes: number | null } | undefined;
  await waitUntilAsync(async () => {
    const files = await request("/api/browser/files") as {
      uploads: unknown[];
      downloads: { id: string; status: string; bytes: number | null }[];
    };
    completedDownload = files.downloads.find((item) => item.status === "completed");
    return Boolean(completedDownload);
  }, "completed Playwright download");
  assert.equal(completedDownload?.bytes, downloadBytes.byteLength);
  const downloaded = await request(`/api/browser/downloads/${completedDownload!.id}/content`) as {
    name: string;
    contentBase64: string;
  };
  assert.equal(downloaded.name, "report.txt");
  assert.equal(Buffer.from(downloaded.contentBase64, "base64").toString(), downloadBytes.toString());
  await request(`/api/browser/downloads/${completedDownload!.id}`, undefined, "DELETE");
  const afterDelete = await request("/api/browser/files") as { downloads: { id: string }[] };
  assert.equal(afterDelete.downloads.some((item) => item.id === completedDownload!.id), false);

  const second = browserTab.parse(await request("/api/browser/tabs", { url: fixture.url + "/second" }));
  const secondActivationMarker = frames.at(-1)?.metadata.frameId ?? 0;
  await waitUntil(() => frames.some((frame) =>
    frame.metadata.tabId === second.id && frame.metadata.frameId > secondActivationMarker), "second tab JPEG frames");
  const activated = browserTab.parse(await request(`/api/browser/tabs/${tab.id}/activate`, {}));
  const firstActivationMarker = frames.at(-1)?.metadata.frameId ?? 0;
  await waitUntil(() => frames.some((frame) =>
    frame.metadata.tabId === tab.id && frame.metadata.frameId > firstActivationMarker), "reactivated tab JPEG frames");
  assert.equal(activated.id, tab.id);
  assert.equal(activated.active, true);
  await request(`/api/browser/tabs/${tab.id}/navigation`, { action: "navigate", url: fixture.url + "/second" });
  const back = browserTab.parse(await request(`/api/browser/tabs/${tab.id}/navigation`, { action: "back" }));
  assert.equal(back.url, fixture.url + "/");
  const forward = browserTab.parse(await request(`/api/browser/tabs/${tab.id}/navigation`, { action: "forward" }));
  assert.equal(forward.url, fixture.url + "/second");
  await request(`/api/browser/tabs/${tab.id}/navigation`, { action: "reload" });

  // Agent 工具与用户页面共享同一个 BrowserService；这里直接执行工具，验证真实
  // Chrome 上的 tab/navigate/snapshot/act，而不是只检查注册表。
  assert.ok(skillToToolsMap.browser.every((name) => registeredToolNames.includes(name)));
  const tools = createTools({
    root: join(dataDir, "workspace", "threads", "local-main"),
    memory: service.memory,
    jobs: service.jobs,
    browser: browserService,
  });
  const toolResult = async <T>(name: string, params: unknown): Promise<T> => {
    const result = await tools.find((tool) => tool.name === name)!
      .execute("browser-integration", params as never, undefined, undefined, {} as never);
    assert.equal(result.isError, false);
    return JSON.parse((result.content[0] as { text: string }).text) as T;
  };
  const listed = await toolResult<{ tabs: { id: string }[] }>("tab", { action: "list" });
  assert.ok(listed.tabs.some((item) => item.id === tab.id));
  const navigated = await toolResult<{ tab: { id: string; url: string } }>("navigate", {
    tabId: tab.id,
    url: fixture.url,
  });
  assert.equal(navigated.tab.id, tab.id);
  const projected = await toolResult<{
    untrusted: boolean;
    elements: { ref: string; name: string; tag: string }[];
  }>("snapshot", { tabId: tab.id });
  assert.equal(projected.untrusted, true);
  const button = projected.elements.find((element) => element.name === "Click");
  const input = projected.elements.find((element) => element.tag === "input");
  assert.ok(button);
  assert.ok(input);
  const clicked = await toolResult<{ snapshot: { text: string } }>("act", {
    tabId: tab.id,
    action: "click",
    ref: button.ref,
  });
  assert.match(clicked.snapshot.text, /Clicks:1/);
  const typed = await toolResult<{ snapshot: { elements: { name: string }[] } }>("act", {
    tabId: tab.id,
    action: "type",
    ref: input.ref,
    text: "agent-browser",
  });
  assert.ok(typed.snapshot.elements.some((element) => element.name === "agent-browser"));

  const closed = await request(`/api/browser/tabs/${second.id}`, undefined, "DELETE") as { tabs: unknown[] };
  assert.equal(closed.tabs.length, 2);

  // ticket 一次性：同一个 ticket 的第二次升级必须失败，不能复用 URL 凭据。
  const replay = new WebSocket(`ws://127.0.0.1:${address.port}/ws/browser?ticket=${encodeURIComponent(ticketResponse.ticket)}`);
  await Promise.race([once(replay, "error"), once(replay, "close")]);
  ws.close();
});
