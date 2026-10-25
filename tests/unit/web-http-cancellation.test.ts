import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once, getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { createHttpWebTransport, safePublicGet } from "../../src/adapters/web/http-transport.js";
import { resolvePublicHost } from "../../src/shared/public-host.js";

const config = { timeoutMs: 30_000, maxResponseBytes: 4096, allowPrivateTargets: true };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const localServer = async (t: TestContext, handle: (url: string, response: ServerResponse) => void) => {
  const server = createServer((request, response) => handle(request.url ?? "", response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

test("web transport rejects pre-cancelled fetch and search without starting HTTP or DNS", async (t) => {
  let requests = 0;
  const base = await localServer(t, (_url, response) => { requests++; response.end("unexpected"); });
  const controller = new AbortController();
  const reason = new Error("cancelled before request");
  controller.abort(reason);
  const web = createHttpWebTransport(config);
  await assert.rejects(web.fetch(base, controller.signal), (error) => error === reason);
  await assert.rejects(web.search("query", 1, controller.signal), (error) => error === reason);
  await assert.rejects(resolvePublicHost("not-resolved.test", true, controller.signal), (error) => error === reason);
  assert.equal(requests, 0);
});

for (const phase of ["headers", "body", "redirect"] as const) {
  test(`web transport cancellation destroys an in-flight ${phase} request before timeout`, { timeout: 5000 }, async (t) => {
    const entered = deferred<void>();
    const closed = deferred<void>();
    let targetRequested = false;
    const base = await localServer(t, (url, response) => {
      if (phase === "redirect" && url === "/") { response.writeHead(302, { location: "/target" }); response.end(); return; }
      response.on("close", () => closed.resolve());
      targetRequested ||= url === "/target";
      // headers 不返回任何响应；body 则只返回首段正文、保持连接打开。
      if (phase === "body") { response.writeHead(200, { "content-type": "text/plain" }); response.write("partial"); }
      entered.resolve();
    });
    const controller = new AbortController();
    const pending = safePublicGet(base, config, controller.signal);
    // 提前接住 rejection，避免读取fixture信号期间的取消产生未处理异常。
    const rejected = assert.rejects(pending, /abort|cancel/i);
    await entered.promise;
    const before = Date.now();
    controller.abort();
    await rejected;
    // redirect 的首跳已正常关闭，目标连接是否销毁另以response close观察。
    await closed.promise;
    assert.ok(Date.now() - before < 1500, "caller cancellation must not wait for the 30s transport timeout");
    if (phase === "redirect") assert.equal(targetRequested, true);
  });
}

test("web transport keeps timeout and size limits and remains usable after cancellation", { timeout: 5000 }, async (t) => {
  let entered = deferred<void>();
  const base = await localServer(t, (url, response) => {
    if (url === "/hang") { entered.resolve(); return; }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(url === "/big" ? "x".repeat(8192) : "ok");
  });
  await assert.rejects(safePublicGet(base + "/hang", { ...config, timeoutMs: 30 }), /abort/i);
  await assert.rejects(safePublicGet(base + "/big", config), /Response too large|abort/i);
  entered = deferred<void>();
  const controller = new AbortController();
  const operation = safePublicGet(base + "/hang", config, controller.signal);
  const rejected = assert.rejects(operation, /abort/i);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal((await safePublicGet(base + "/ok", config)).body, "ok");
});

test("DNS cancellation observation and successful requests do not retain abort listeners", async (t) => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  await resolvePublicHost("localhost", true, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
  const base = await localServer(t, (_url, response) => response.end("ok"));
  await safePublicGet(base, config, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
});
