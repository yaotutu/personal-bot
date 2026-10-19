import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { sseEvents } from "../../src/http/contracts/sse-events.js";
import { workspaceEvents } from "../../src/http/contracts/workspace-events.js";
import { createFakeModel } from "../support/fake-model.js";

const execFileAsync = promisify(execFile);
type Service = Awaited<ReturnType<typeof createService>>;

/** 每项测试独占实例和 provider，任何初始化/断言失败都不会碰正式数据或遗留连接。 */
const fixture = async (t: TestContext, withModel = false) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-events-"));
  let service: Service | undefined;
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally {
      try { await model?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  if (withModel) model = await createFakeModel();
  service = await createService(createConfig({
    server: { accessKey: "events-test-access" },
    ...(model ? { model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "events-model-secret" } } : {}),
    runtime: { dataDir, runTimeoutMs: 10_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
  }));
  return { service, dataDir, headers: { Authorization: `Bearer ${service.auth.login("events-test-access")}` }, model };
};

const post = async (service: Service, headers: Record<string, string>, path: string, body: unknown) => service.app.request(path, {
  method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const connect = async (t: TestContext, service: Service, headers: Record<string, string>) => {
  const controller = new AbortController();
  const response = await service.app.request("/api/events", { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
  const next = async () => {
    const { done, value } = await reader.read();
    assert.equal(done, false, "event stream ended unexpectedly");
    return new TextDecoder().decode(value);
  };
  assert.equal(await next(), "event: ready\ndata: {}\n\n");
  return { next, reader, controller };
};

const until = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await sleep(10);
  }
};

const drain = async (response: Response) => {
  assert.equal(response.status, 200);
  return response.text();
};

test("workspace events require Bearer auth and replay no notifications after reconnect", async (t) => {
  const { service, headers } = await fixture(t);
  for (const authorization of [undefined, "Bearer invalid", "Basic invalid"]) {
    const denied = await service.app.request("/api/events", { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "Unauthorized: open a new session" });
  }
  const first = await connect(t, service, headers);
  await first.reader.cancel();
  await service.memory.add("changed while disconnected", "web");
  const second = await connect(t, service, { ...headers, "Last-Event-ID": "not-a-replay-cursor" });
  // connect 已校验首帧 ready；重新读取事实，不依赖断线期间事件。
  const snapshot = await (await service.app.request("/api/agent", { headers })).json();
  assert.equal(snapshot.memories[0].text, "changed while disconnected");
  const next = second.next();
  await service.memory.add("changed after reconnect", "web");
  assert.equal(await next, "event: workspace_updated\ndata: {}\n\n");
});

test("all workspace repositories notify every connection after commit, while reads and refusals stay silent", async (t) => {
  const { service, headers, dataDir } = await fixture(t);
  const a = await connect(t, service, headers);
  const b = await connect(t, service, headers);
  const received: string[] = [];
  const unsubscribe = service.workspaceEvents.subscribe({ notify: (event) => received.push(event), close: () => {} });
  t.after(unsubscribe);
  const changed = async (write: () => Promise<unknown>, assertPersisted: () => Promise<void>) => {
    const eventA = a.next();
    const eventB = b.next();
    await write();
    await assertPersisted();
    assert.equal(await eventA, "event: workspace_updated\ndata: {}\n\n");
    assert.equal(await eventB, "event: workspace_updated\ndata: {}\n\n");
  };
  const document = async (name: string) => JSON.parse(await readFile(join(dataDir, name), "utf8"));
  await changed(async () => {
    const response = await post(service, headers, "/api/agent/memories", { text: "REST-MEMORY" });
    assert.equal(response.status, 200);
  }, async () => { assert.equal((await document("memory.json")).memories[0].text, "REST-MEMORY"); });
  await changed(() => service.identity.save({ name: "Events identity" }), async () => {
    assert.equal((await document("memory.json")).identity.name, "Events identity");
  });
  await changed(() => service.jobs.add("later", false, new Date(Date.now() + 3_600_000).toISOString()), async () => {
    assert.equal((await document("jobs.json"))[0].prompt, "later");
  });
  await changed(() => service.goals.create({ title: "Learn", milestones: ["Read"] }), async () => {
    assert.equal((await document("goals.json"))[0].title, "Learn");
  });
  await changed(() => service.monitors.create({ url: "https://example.com", condition: "change" }), async () => {
    assert.equal((await document("monitors.json"))[0].status, "active");
  });
  const monitor = (await service.monitors.list())[0];
  await changed(() => service.monitors.check(monitor.id, { error: "private diagnostic" }), async () => {
    assert.equal((await document("monitors.json"))[0].error, "Fetch failed");
  });
  const count = received.length;
  assert.equal((await service.app.request("/api/agent", { headers })).status, 200);
  await service.memory.list();
  await service.goals.edit("missing", { title: "no-op" });
  assert.equal((await service.jobs.control("missing", "cancel")).ok, false);
  const bad = await post(service, headers, "/api/agent/memories", {});
  assert.equal(bad.status, 400);
  assert.equal(received.length, count);

  // 模拟 rename 失败，不能先广播再失败；只操作本测试实例的 goals 文件。
  await rm(join(dataDir, "goals.json"));
  await mkdir(join(dataDir, "goals.json"));
  await assert.rejects(service.goals.create({ title: "cannot commit" }));
  assert.equal(received.length, count);
});

test("approval notifications cover new, approved, denied, cancelled and expired without broadcasting previews", async (t) => {
  const { service, headers } = await fixture(t);
  const stream = await connect(t, service, headers);
  const changed = async (write: () => Promise<unknown>) => {
    const next = stream.next();
    await write();
    assert.equal(await next, "event: actions_updated\ndata: {}\n\n");
  };
  for (const decision of ["approve", "deny", "cancel", "expire"] as const) {
    let id = "";
    await changed(async () => {
      const action = await service.actions.submit("file_write", "PRIVATE-TITLE", { path: "private.md", content: "PRIVATE-CONTENT" }, { timeoutMs: decision === "expire" ? 1 : 60_000 });
      id = action.id;
    });
    if (decision === "expire") {
      await sleep(5);
      await changed(() => service.actions.poll(id));
    } else if (decision === "cancel") {
      await changed(() => service.actions.cancel(id));
    } else {
      await changed(async () => {
        const response = await post(service, headers, `/api/approvals/${id}/decision`, { decision });
        assert.equal(response.status, 200);
      });
    }
    const pending = await (await service.app.request("/api/approvals/pending", { headers })).json();
    assert.deepEqual(pending.approvals, []);
  }
  const invalidated: string[] = [];
  const unsubscribe = service.workspaceEvents.subscribe({ notify: (event) => invalidated.push(event), close: () => {} });
  await service.actions.list();
  await service.actions.poll("missing");
  await service.actions.cancel("missing");
  await service.actions.decide("missing", "deny");
  unsubscribe();
  assert.deepEqual(invalidated, []);
});

test("model memory tools share commit notifications and disconnecting events does not cancel a chat", async (t) => {
  const { service, headers, model } = await fixture(t, true);
  const events = await connect(t, service, headers);
  const notice = events.next();
  const run = post(service, headers, "/api/conversation/run", {
    threadId: "local-main", runId: randomUUID(), expectedRevision: "empty",
    message: { id: randomUUID(), content: "记住我喜欢喝茶" },
  }).then(drain);
  assert.equal(await notice, "event: workspace_updated\ndata: {}\n\n");
  assert.match(await run, /RUN_FINISHED/);
  assert.equal((await service.memory.list()).length, 1);
  const conversation = await service.conversationHub.forThread("local-main");
  const revision = conversation.snapshot().revision;
  const frozen = post(service, headers, "/api/conversation/run", {
    threadId: "local-main", runId: randomUUID(), expectedRevision: revision,
    message: { id: randomUUID(), content: "freeze" },
  }).then(drain);
  await until(() => model!.requests.length >= 3);
  await events.reader.cancel();
  assert.equal(conversation.isRunning(), true);
  await conversation.cancel();
  assert.match(await frozen, /RUN_ERROR/);
});

test("live HTTP event connections end on service close and reject new subscriptions", async (t) => {
  const { service, headers } = await fixture(t);
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  const next = reader.read();
  const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await service.close();
  assert.equal((await next).done, true);
  await reader.cancel();
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  await stopped;
  assert.equal((await service.app.request("/api/events", { headers })).status, 503);
});

test("process entry handles SIGTERM with an open event stream", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-events-process-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // 子进程真实跑入口，不调用 process.exit；只要长连接/心跳未回收就会超时失败。
  const script = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { createServer } from "node:net";
    import { mkdir, writeFile } from "node:fs/promises";
    import { setTimeout as sleep } from "node:timers/promises";
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const config = {server:{host:"127.0.0.1",port,accessKey:"process-events-key"},runtime:{dataDir:${JSON.stringify(dataDir)},schedulerIntervalMs:60000,monitorScanIntervalMs:60000}};
    const configDir = ${JSON.stringify(join(dataDir, ".pi-muse"))};
    await mkdir(configDir);
    const configFile = configDir + "/config.json";
    await writeFile(configFile, JSON.stringify(config), {mode:0o600});
    const child = spawn(process.execPath, ["--import", ${JSON.stringify(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname)}, ${JSON.stringify(new URL("../../src/index.ts", import.meta.url).pathname)}], {cwd:${JSON.stringify(dataDir)},stdio:["ignore","pipe","pipe"]});
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exit = new Promise(resolve => child.on("exit", (code, signal) => resolve({code,signal})));
    const deadline = Date.now() + 25_000;
    try {
      while (!output.includes("pi-muse listening")) {
        assert.equal(child.exitCode, null, "Server exited before listening: " + output);
        assert.ok(Date.now() < deadline, "Server did not start within 25 seconds: " + output);
        await sleep(20);
      }
      const base = "http://127.0.0.1:" + port;
      const login = await fetch(base + "/api/session", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accessKey:"process-events-key"})});
      const {token} = await login.json();
      const stream = await fetch(base + "/api/events", {headers:{Authorization:"Bearer " + token}});
      const reader = stream.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
      child.kill("SIGTERM");
      const shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        assert.equal((await reader.read()).done, true);
        assert.deepEqual(await exit, {code:0,signal:null});
        console.log("OPEN_SSE_SIGTERM_OK");
      } finally { clearTimeout(shutdownTimer); }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  `;
  const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 40_000 });
  assert.match(child.stdout, /OPEN_SSE_SIGTERM_OK/);
});

test("OpenAPI keeps workspace named events separate from AG-UI and empty payloads strict", () => {
  const doc = buildOpenApiDocument();
  type Operation = { security: unknown; responses: Record<string, { "x-sse-events": Record<string, unknown> }> };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
  assert.deepEqual(Object.keys(paths["/api/events"].get.responses[200]["x-sse-events"]), Object.keys(workspaceEvents));
  assert.deepEqual(Object.keys(paths["/api/conversation/run"].post.responses[200]["x-sse-events"]), Object.keys(sseEvents));
  assert.deepEqual(paths["/api/events"].get.security, [{ bearerAuth: [] }]);
  for (const schema of Object.values(workspaceEvents)) {
    assert.deepEqual(schema.parse({}), {});
    assert.equal(schema.safeParse({ content: "no business data" }).success, false);
  }
});
