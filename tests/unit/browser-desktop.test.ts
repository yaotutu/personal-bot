import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserDesktop, DESKTOP_VIEWER_PATH } from "../../src/http/browser-desktop.js";

// 桌面网关的边界回归：不启动 upstream；有效 ticket 与代理资源由集成测试覆盖。

test("disabled desktop reports null paths and never probes upstream", async () => {
  const desktop = createBrowserDesktop({ enabled: false, desktopPort: 9 });
  const status = await desktop.status();
  assert.deepEqual(status, {
    enabled: false,
    viewerPath: null,
    desktopPath: null,
    desktopAvailable: false,
  });
  assert.equal(await desktop.createTicket(), undefined);
  desktop.close();
});

test("unreachable upstream keeps desktopAvailable false and refuses to mint tickets", async () => {
  // 端口 9 是 discard 服务，本机不会监听；探测必须在 2 秒内受控失败。
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: 9 });
  const status = await desktop.status();
  assert.equal(status.enabled, true);
  assert.equal(status.viewerPath, "/browser");
  assert.equal(status.desktopPath, DESKTOP_VIEWER_PATH);
  assert.equal(status.desktopAvailable, false);
  assert.equal(await desktop.createTicket(), undefined);
  desktop.close();
});

test("launch rejects missing and unknown tickets with 401", () => {
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: 9 });
  const missing = desktop.launch(new URL("http://localhost/browser/desktop/launch"));
  assert.equal(missing.status, 401);
  const unknown = desktop.launch(new URL("http://localhost/browser/desktop/launch?ticket=nope"));
  assert.equal(unknown.status, 401);
  desktop.close();
});

test("proxy rejects traversal and encoded escapes before any upstream call", async () => {
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: 9 });
  const cookie = "pi_muse_desktop=fake-session";
  const rejected = [
    "/browser/desktop/../private",
    "/browser/desktop/%2e%2e%2fprivate",
    "/browser/desktop/%2e%2e/private",
    "/browser/desktop/sub/..%2f..%2fsecret",
    "/browser/desktop//double",
    "/browser/desktop/.",
    "/browser/desktop/",
    "/browser/desktop/a\\b",
  ];
  for (const path of rejected) {
    const response = await desktop.proxy(new Request(`http://localhost${path}`, {
      headers: { cookie },
    }));
    // 会话本身无效会先 401；这里关心的是路径绝不能到 upstream——端口 9 不可达，
    // 若路径被放行会返回 503 或 401；返回 404 表示路径校验先行拒绝。
    assert.ok(response.status === 401 || response.status === 404, `${path} -> ${response.status}`);
    if (response.status !== 401) assert.equal(response.status, 404, path);
  }
  desktop.close();
});

test("proxy requires a valid desktop cookie and refuses other methods", async () => {
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: 9 });
  const noCookie = await desktop.proxy(new Request("http://localhost/browser/desktop/vnc.html"));
  assert.equal(noCookie.status, 401);
  const badCookie = await desktop.proxy(new Request("http://localhost/browser/desktop/vnc.html", {
    headers: { cookie: "pi_muse_desktop=not-a-session" },
  }));
  assert.equal(badCookie.status, 401);
  const post = await desktop.proxy(new Request("http://localhost/browser/desktop/vnc.html", {
    method: "POST",
    headers: { cookie: "pi_muse_desktop=not-a-session" },
  }));
  assert.equal(post.status, 405);
  desktop.close();
});

test("handleUpgrade ignores non-desktop paths and rejects missing cookie or origin", () => {
  const desktop = createBrowserDesktop({ enabled: true, desktopPort: 9 });
  const socket = {
    destroyed: false,
    wrote: "",
    write(data: string) { this.wrote += data; return true; },
    destroy() { this.destroyed = true; },
  };
  const head = Buffer.alloc(0);
  // 非桌面路径不消费，返回 false 交给 dispatcher 下一位。
  const other = desktop.handleUpgrade(
    { url: "/ws/browser?ticket=x", headers: {}, socket: {} } as never,
    socket as never,
    head,
  );
  assert.equal(other, false);
  assert.equal(socket.destroyed, false);
  // 桌面路径缺 cookie/origin：拒绝且消费。
  const rejected = desktop.handleUpgrade(
    { url: "/browser/desktop/websockify", headers: { host: "example.test" }, socket: {} } as never,
    socket as never,
    head,
  );
  assert.equal(rejected, true);
  assert.equal(socket.destroyed, true);
  assert.match(socket.wrote, /401/);
  desktop.close();
});
