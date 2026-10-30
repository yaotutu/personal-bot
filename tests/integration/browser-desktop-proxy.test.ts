import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createBrowserDesktop } from "../../src/http/browser-desktop.js";

// 真实回环 HTTP upstream fixture：验证代理对压缩、redirect、错误页与路径的处理。
// 需要监听 127.0.0.1 随机端口；沙箱拒绝监听（EPERM）时整个文件失败，
// 由主 Agent 在允许监听的环境重跑，不用 fake 替代。

const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
};

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const mintCookie = async (desktop: ReturnType<typeof createBrowserDesktop>) => {
  const ticket = await desktop.createTicket();
  assert.ok(ticket, "ticket must be minted when upstream is reachable");
  const launch = desktop.launch(new URL(`http://localhost/browser/desktop/launch?ticket=${ticket.value}`));
  assert.equal(launch.status, 303);
  const cookie = launch.headers.get("set-cookie");
  assert.ok(cookie);
  return { launch, cookie: cookie.split(";")[0]! };
};

test("concurrent launch tickets stay independent; consumption is one-time", async (t) => {
  const upstream = await listen((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>vnc</html>");
  });
  t.after(() => closeServer(upstream.server));
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: upstream.port });
  t.after(() => desktop.close());

  const ticketA = await desktop.createTicket();
  const ticketB = await desktop.createTicket();
  assert.ok(ticketA && ticketB && ticketA.value !== ticketB.value);
  // 第二张票不使第一张失效。
  const launchA = desktop.launch(new URL(`http://localhost/browser/desktop/launch?ticket=${ticketA.value}`));
  assert.equal(launchA.status, 303);
  // 重放同一张票 401。
  const replay = desktop.launch(new URL(`http://localhost/browser/desktop/launch?ticket=${ticketA.value}`));
  assert.equal(replay.status, 401);
  // 第二张票仍可用。
  const launchB = desktop.launch(new URL(`http://localhost/browser/desktop/launch?ticket=${ticketB.value}`));
  assert.equal(launchB.status, 303);
  assert.match(launchA.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(launchA.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  assert.match(launchA.headers.get("set-cookie") ?? "", /Path=\/browser\/desktop\//);
  assert.match(launchA.headers.get("set-cookie") ?? "", /Max-Age=3600/);
  // HTTP 直连不加 Secure。
  assert.doesNotMatch(launchA.headers.get("set-cookie") ?? "", /Secure/);
  assert.equal(launchA.headers.get("cache-control"), "no-store");
  assert.equal(launchA.headers.get("referrer-policy"), "no-referrer");
  assert.match(launchA.headers.get("location") ?? "", /^\/browser\/desktop\/vnc\.html\?autoconnect=1&resize=scale&path=/);
});

test("proxied gzip asset is decompressed without leaking content-encoding", async (t) => {
  const payload = gzipSync(Buffer.from("compressed-asset-body"));
  const upstream = await listen((request, response) => {
    if (request.url === "/vnc.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>vnc</html>");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/javascript",
      "content-encoding": "gzip",
      "set-cookie": "upstream=should-not-leak",
    });
    response.end(payload);
  });
  t.after(() => closeServer(upstream.server));
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: upstream.port });
  t.after(() => desktop.close());
  const { cookie } = await mintCookie(desktop);

  const response = await desktop.proxy(new Request("http://localhost/browser/desktop/app/ui.js", {
    headers: { cookie },
  }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "compressed-asset-body");
  // fetch 已解压：绝不能把原压缩标记转发给客户端。
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("upstream redirect and error pages are replaced with controlled responses", async (t) => {
  const upstream = await listen((request, response) => {
    if (request.url === "/vnc.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>vnc</html>");
      return;
    }
    if (request.url?.startsWith("/redirect")) {
      response.writeHead(302, { location: "http://evil.example/" });
      response.end("redirect body must not leak");
      return;
    }
    response.writeHead(500, { "content-type": "text/html" });
    response.end("internal stack trace must not leak");
  });
  t.after(() => closeServer(upstream.server));
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: upstream.port });
  t.after(() => desktop.close());
  const { cookie } = await mintCookie(desktop);

  const redirect = await desktop.proxy(new Request("http://localhost/browser/desktop/redirect", {
    headers: { cookie },
  }));
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get("location"), null);
  assert.match(await redirect.text(), /refused/);

  const failure = await desktop.proxy(new Request("http://localhost/browser/desktop/broken", {
    headers: { cookie },
  }));
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /stack trace/);
});

test("encoded traversal never reaches upstream even with a valid session", async (t) => {
  const seen: string[] = [];
  const upstream = await listen((request, response) => {
    seen.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>vnc</html>");
  });
  t.after(() => closeServer(upstream.server));
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: upstream.port });
  t.after(() => desktop.close());
  const { cookie } = await mintCookie(desktop);
  seen.length = 0;

  for (const path of [
    "/browser/desktop/%2e%2e%2fprivate",
    "/browser/desktop/..%2fsecret",
    "/browser/desktop/sub%2f..%2f..%2fsecret",
  ]) {
    const response = await desktop.proxy(new Request(`http://localhost${path}`, { headers: { cookie } }));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(seen, []);
});

test("desktop cookie never authorizes /api endpoints", async (t) => {
  const upstream = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>vnc</html>");
  });
  t.after(() => closeServer(upstream.server));
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: upstream.port });
  t.after(() => desktop.close());
  const { cookie } = await mintCookie(desktop);
  // cookie 的作用域是 Path=/browser/desktop/，即便客户端错误地把它发到 /api，
  // 服务端也只在桌面代理里读取它；这里验证 cookie 不是 Bearer token 的替代。
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-desktop-cookie-"));
  const service = await createService(createConfig({
    server: { host: "127.0.0.1", accessKey: "desktop-cookie-test" },
    runtime: { dataDir },
    tools: { browser: { enabled: false, desktopPort: upstream.port } },
  }));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const apiResponse = await service.app.request("/api/browser/status", {
    headers: { cookie },
  });
  assert.equal(apiResponse.status, 401);
  // disabled 状态仍然注册并应答（带 Bearer）。
  const login = await service.app.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: "desktop-cookie-test" }),
  });
  const { token } = await login.json() as { token: string };
  const status = await service.app.request("/api/browser/status", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status.status, 200);
  const body = await status.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    enabled: false,
    viewerPath: null,
    desktopPath: null,
    desktopAvailable: false,
  });
  assert.equal(status.headers.get("cache-control"), "no-store");
});
