import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createMonitorScheduler } from "../../src/features/monitors/monitor-scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
};
const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-thread-regression-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const releaseGates: (() => void)[] = [];
  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };
  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { presentation: { overrides: { read: "summary" } } },
  });
  let baseUrl = "";
  const start = async () => {
    service = await createService(config);
    server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  await start();
  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const snapshot = async (id: string) => {
    const response = await request(`/api/conversation?threadId=${id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: { role: string; content?: string }[]; revision: string }>;
  };
  const listed = async (id: string) => {
    const response = await request("/api/threads");
    assert.equal(response.status, 200);
    const body = await response.json() as { threads: { id: string }[] };
    return body.threads.some((thread) => thread.id === id);
  };
  const run = async (id: string, text: string) => {
    const before = await snapshot(id);
    const response = await request("/api/conversation/run", "POST", {
      threadId: id, runId: randomUUID(), expectedRevision: before.revision,
      message: { id: randomUUID(), content: text },
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /RUN_FINISHED/);
    return stream;
  };
  return { dir, model, service: () => service!, request, snapshot, listed, run, releaseGates,
    restart: async () => { await stop(); await start(); } };
};
const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

test("thread reads and late stop never create absent or deleted sessions, including during deletion", async (t) => {
  const h = await fixture(t);
  const id = "deleted-read";
  assert.deepEqual(await h.snapshot(id), { messages: [], revision: "empty" });
  assert.equal(await h.listed(id), false);
  await assertMissing(join(h.dir, "sessions", id));
  await assertMissing(join(h.dir, "workspace", "threads", id));
  assert.equal((await h.request(`/api/threads/${id}/instructions`, "PUT", { instructions: "test" })).status, 200);
  const entered = deferred();
  const proceed = deferred();
  const removeJobs = h.service().jobs.removeByOriginThreadId;
  h.service().jobs.removeByOriginThreadId = async (origin) => {
    entered.resolve(); await proceed.promise;
    return removeJobs(origin);
  };
  h.releaseGates.push(proceed.resolve);
  const deleting = h.request(`/api/threads/${id}`, "DELETE");
  await entered.promise;
  assert.deepEqual(await h.snapshot(id), { messages: [], revision: "empty" });
  const stop = await h.request("/api/conversation/stop", "POST", { threadId: id, runId: "old" });
  assert.deepEqual(await stop.json(), { stopped: false });
  for (const [path, body] of [
    [`/api/threads/${id}/instructions`, { instructions: "late" }],
    ["/api/agent/monitors", { url: "https://example.com", condition: "change", originThreadId: id }],
  ] as const) {
    const response = await h.request(path, path.includes("instructions") ? "PUT" : "POST", body);
    assert.equal(response.status, 409, path);
    assert.match(await response.text(), /THREAD_DELETING/);
  }
  proceed.resolve();
  assert.equal((await deleting).status, 200);
  h.service().jobs.removeByOriginThreadId = removeJobs;
  assert.deepEqual(await h.snapshot(id), { messages: [], revision: "empty" });
  await h.request("/api/conversation/stop", "POST", { threadId: id, runId: "old" });
  assert.equal(await h.listed(id), false);
  await assertMissing(join(h.dir, "sessions", id));
  await assertMissing(join(h.dir, "workspace", "threads", id));
  // 显式发起新一轮仍可复用 ID，但读取历史和迟到 stop 不代表创建意图。
  await h.run(id, "hello intentional recreate");
  assert.equal(await h.listed(id), true);
});

test("history reads remain side-effect free while unrelated threads are deleted", async (t) => {
  const h = await fixture(t);
  for (let index = 0; index < 12; index++) await h.service().conversationHub.forThread(`list-race-${index}`);
  const responses = await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => h.request(`/api/threads/list-race-${index}`, "DELETE")),
    ...Array.from({ length: 30 }, (_, index) => h.request(`/api/conversation?threadId=never-created-${index}`)),
    ...Array.from({ length: 15 }, () => h.request("/api/threads")),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  const listing = await (await h.request("/api/threads")).json() as { threads: { id: string }[] };
  assert.deepEqual(listing.threads.map((thread) => thread.id), ["local-main"]);
});

test("new monitor source receives notifications and deleted monitor snapshots cannot rebuild it", async (t) => {
  const h = await fixture(t);
  const id = "new-monitor-source";
  const response = await h.request("/api/agent/monitors", "POST", {
    title: "MONITOR-ORIGIN", url: "https://example.com", condition: "contains", value: "MATCH", originThreadId: id,
  });
  assert.equal(response.status, 200);
  const monitor = await response.json() as { id: string };
  await h.service().monitors.check(monitor.id, { body: "MATCH-FACT" });
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10 }, h.service().monitors,
    await h.service().conversationHub.forThread("local-main"), (thread) => h.service().conversationHub.findThread(thread));
  scheduler.start();
  try {
    await until(async () => JSON.stringify(await h.snapshot(id)).includes("MONITOR-ORIGIN"));
    assert.doesNotMatch(JSON.stringify(await h.snapshot("local-main")), /MONITOR-ORIGIN/);
    assert.equal((await h.request(`/api/threads/${id}`, "DELETE")).status, 200);
    await h.snapshot(id);
    assert.equal(await h.listed(id), false);
    await assertMissing(join(h.dir, "sessions", id));
  } finally { await scheduler.close(); }
});

test("missing-file diagnostics are safe in SSE, next model request, JSONL and reopened history", async (t) => {
  const h = await fixture(t);
  const id = "safe-file-error";
  const stream = await h.run(id, "读 absent-file.md");
  const messages = (await h.snapshot(id)).messages;
  const files = (await readdir(join(h.dir, "sessions", id))).filter((file) => file.endsWith(".jsonl"));
  const raw = (await Promise.all(files.map((file) => readFile(join(h.dir, "sessions", id, file), "utf8")))).join("\n");
  const toolRecords = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
  assert.equal(toolRecords.length, 1);
  assert.match(JSON.stringify(toolRecords), /File not found/);
  const modelToolResults = h.model.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool"));
  assert.ok(modelToolResults.length > 0);
  const physical = await realpath(h.dir);
  for (const value of [stream, JSON.stringify(messages), JSON.stringify(toolRecords), JSON.stringify(modelToolResults)]) {
    assert.ok(!value.includes(h.dir) && !value.includes(physical), value);
    assert.doesNotMatch(value, /ENOENT|lstat/);
  }
  assert.match(JSON.stringify(messages), /File not found/);
  await h.restart();
  assert.deepEqual((await h.snapshot(id)).messages, messages);
});
