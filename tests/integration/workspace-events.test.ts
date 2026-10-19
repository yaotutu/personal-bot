import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";

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

type Frame = { event: string; data: any };

const connect = async (t: TestContext, service: Service, headers: Record<string, string>) => {
  const controller = new AbortController();
  const response = await service.app.request("/api/events", { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
  const decoder = new TextDecoder();
  let buffer = "";

  const nextFrame = async (): Promise<Frame> => {
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (event) return { event, data: JSON.parse(dataLines.join("\n")) };
      }
      const { done, value } = await reader.read();
      assert.equal(done, false, "event stream ended unexpectedly");
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const ready = await nextFrame();
  assert.equal(ready.event, "ready");
  assert.ok(ready.data.instanceId);
  return { nextFrame, reader, controller, ready: ready.data };
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

test("workspace events require Bearer auth and reconnect yields fresh ready snapshot", async (t) => {
  const { service, headers } = await fixture(t);
  for (const authorization of [undefined, "Bearer invalid", "Basic invalid"]) {
    const denied = await service.app.request("/api/events", { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "Unauthorized: open a new session" });
  }

  const first = await connect(t, service, headers);
  assert.deepEqual(first.ready.pendingApprovals, []);
  assert.deepEqual(first.ready.agentStatuses, []);
  await first.reader.cancel();

  // 断线期间登记新待审批
  const action = await service.actions.submit("file_write", "Title while disconnected", {
    path: "notes.md", content: "offline hello", originalContent: "", baseVersion: "missing", beforeExists: "false",
  });

  // 重连时携带 Last-Event-ID 不应重放历史事件，首帧 ready 必须直接包含当前待审批集合
  const second = await connect(t, service, { ...headers, "Last-Event-ID": "not-a-replay-cursor" });
  assert.equal(second.ready.pendingApprovals.length, 1);
  assert.equal(second.ready.pendingApprovals[0].id, action.id);
  assert.equal(second.ready.pendingApprovals[0].preview.after, "offline hello");
});

test("approval notifications push approval_pending with full preview and approval_updated on resolution", async (t) => {
  const { service, headers } = await fixture(t);
  const stream = await connect(t, service, headers);

  for (const decision of ["approve", "deny", "cancel", "expire"] as const) {
    const pendingPromise = stream.nextFrame();
    const action = await service.actions.submit("file_write", `Title ${decision}`, {
      path: `${decision}.md`, content: `content-${decision}`, originalContent: "", baseVersion: "missing", beforeExists: "false",
    }, { timeoutMs: decision === "expire" ? 10 : 60_000 });

    const pendingFrame = await pendingPromise;
    assert.equal(pendingFrame.event, "approval_pending");
    assert.equal(pendingFrame.data.id, action.id);
    assert.equal(pendingFrame.data.status, "pending");
    assert.equal(pendingFrame.data.revision, 1);
    assert.equal(pendingFrame.data.preview.after, `content-${decision}`);

    const updatedPromise = stream.nextFrame();
    if (decision === "expire") {
      await sleep(20);
      await service.actions.expirePending();
    } else if (decision === "cancel") {
      await service.actions.cancel(action.id);
    } else {
      const res = await post(service, headers, `/api/approvals/${action.id}/decision`, { decision });
      assert.equal(res.status, 200);
    }

    const updatedFrame = await updatedPromise;
    assert.equal(updatedFrame.event, "approval_updated");
    assert.equal(updatedFrame.data.id, action.id);
    assert.equal(updatedFrame.data.status, decision === "cancel" ? "cancelled" : decision === "expire" ? "expired" : decision === "approve" ? "approved" : "denied");
    assert.equal(updatedFrame.data.revision, 2);
    assert.ok(updatedFrame.data.resolvedAt);
    assert.equal(Object.hasOwn(updatedFrame.data, "preview"), false);
  }
});

test("execution receipts push higher approval revisions without changing the human decision or resending previews", async (t) => {
  const { service, headers } = await fixture(t);
  const stream = await connect(t, service, headers);
  const action = await service.actions.submit("file_write", "Receipt", {
    path: "receipt.md", content: "planned", originalContent: "", beforeExists: "false", baseVersion: "missing",
  });
  assert.equal((await stream.nextFrame()).event, "approval_pending");
  await service.actions.resolveDecision(action.id, "approve");
  const authorized = (await stream.nextFrame()).data;
  assert.equal(authorized.revision, 2);
  assert.equal(authorized.execution, null);
  assert.equal(await service.actions.markExecuting(action.id), true);
  const started = await stream.nextFrame();
  assert.equal(started.event, "approval_updated");
  assert.equal(started.data.revision, 3);
  assert.equal(started.data.execution.status, "running");
  await service.actions.finishExecution(action.id, "succeeded", "Committed");
  const finished = await stream.nextFrame();
  assert.equal(finished.event, "approval_updated");
  assert.equal(finished.data.revision, 4);
  assert.equal(finished.data.execution.status, "succeeded");
  assert.equal(finished.data.decidedAt, authorized.decidedAt);
  assert.equal(finished.data.resolvedAt, authorized.resolvedAt);
  for (const field of ["preview", "payload", "title", "kind"]) assert.equal(Object.hasOwn(finished.data, field), false);
});

test("model conversation run pushes agent_status_updated events and disconnecting events does not cancel a chat", async (t) => {
  const { service, headers, model } = await fixture(t, true);
  const events = await connect(t, service, headers);

  const runPromise = post(service, headers, "/api/conversation/run", {
    threadId: "local-main", runId: randomUUID(), expectedRevision: "empty",
    message: { id: randomUUID(), content: "记住我喜欢喝茶" },
  }).then(drain);

  // 接收运行状态推送
  const statusFrame = await events.nextFrame();
  assert.equal(statusFrame.event, "agent_status_updated");
  assert.equal(statusFrame.data.threadId, "local-main");
  assert.ok(statusFrame.data.revision >= 1);

  assert.match(await runPromise, /RUN_FINISHED/);
  assert.equal((await service.memory.list()).length, 1);

  // 验证事件流断开不影响正在运行的会话
  const conversation = await service.conversationHub.forThread("local-main");
  const revision = conversation.snapshot().revision;
  const frozenPromise = post(service, headers, "/api/conversation/run", {
    threadId: "local-main", runId: randomUUID(), expectedRevision: revision,
    message: { id: randomUUID(), content: "freeze" },
  }).then(drain);

  await until(() => model!.requests.length >= 3);
  await events.reader.cancel();
  assert.equal(conversation.isRunning(), true);
  await conversation.cancel();
  assert.match(await frozenPromise, /RUN_ERROR/);
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
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/);
  const next = reader.read();
  await service.close();
  assert.equal((await next).done, true);
});
