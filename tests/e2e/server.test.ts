import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFakeModel } from "../support/fake-model.js";
import { createServiceProcess } from "../support/service-process.js";
import { createTestClient, waitForTest } from "../support/http-client.js";
import { agentSnapshot } from "../../src/http/contracts/responses.js";
import { pendingApprovalsResponse } from "../../src/http/contracts/approvals.js";

const fixture = async (t: TestContext) => {
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  // 在进程支架之前登记provider回收，避免启动失败留下监听端口。
  t.after(async () => { try { await service?.close(); } finally { await model?.close(); } });
  let service: Awaited<ReturnType<typeof createServiceProcess>> | undefined;
  model = await createFakeModel();
  service = await createServiceProcess(t, { modelBaseUrl: model.baseUrl });
  const response = await fetch(service.baseUrl + "/api/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: service.accessKey }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return { service, model, token: token as string, client: createTestClient(() => service!.baseUrl, token) };
};
const terminalSuccess = (events: { type: string }[]) => assert.equal(events.at(-1)?.type, "RUN_FINISHED");
const userText = (value: unknown) => typeof value === "string" ? value : Array.isArray(value) ? value.map((item) => item.text ?? "").join("") : "";
const childRequest = (request: { messages: { role: string; content: unknown }[] }) =>
  request.messages.some((message) => message.role === "system" && userText(message.content).includes("## Subagent role"));

test("e2e: built entry authenticates, streams tools, persists state and restarts with the same token/history", { timeout: 90_000 }, async (t) => {
  const { service, client, token } = await fixture(t);
  assert.equal((await fetch(service.baseUrl + "/api/agent", { signal: AbortSignal.timeout(5000) })).status, 401);
  const wrong = await fetch(service.baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "wrong" }), signal: AbortSignal.timeout(5000) });
  assert.equal(wrong.status, 401);
  const health = await client.json("/api/health");
  const spec = await client.json("/openapi.json");
  assert.equal(health.serviceVersion.mode, "build");
  assert.deepEqual(health.serviceVersion, spec["x-service-version"]);
  assert.equal(spec.paths["/api/agent/tasks"], undefined);
  assert.equal((await client.request("/api/agent/tasks", { prompt: "legacy must not execute" })).status, 501);
  assert.match(await (await client.request("/docs")).text(), /scalar\.js/);
  const timeEvents = await client.run("现在几点", "e2e-main");
  terminalSuccess(timeEvents);
  assert.ok(timeEvents.some((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "currentTime"));
  await client.run("记住E2E记忆", "e2e-main");
  const snapshot = agentSnapshot.parse(await client.json("/api/agent"));
  assert.ok(snapshot.memories.some((memory) => memory.text.includes("E2E记忆")));
  assert.equal(Object.hasOwn(snapshot, "worker"), false);
  await client.json("/api/threads/e2e-main/instructions", { instructions: "E2E-INSTRUCTIONS" }, "PUT");
  const before = await client.history("e2e-main");
  await service.restart();
  assert.deepEqual(await client.history("e2e-main"), before);
  assert.equal((await client.request("/api/agent")).status, 200, "auth.key and token survive process restart");
  assert.equal(await readFile(join(service.dataDir, "sessions/e2e-main/INSTRUCTIONS.md"), "utf8"), "E2E-INSTRUCTIONS\n");
  assert.equal(typeof token, "string");
  terminalSuccess(await client.run("hello after restart", "e2e-main"));
  assert.match(JSON.stringify(await client.history("e2e-main")), /after restart/);
});

test("e2e: parent dispatches single, concurrent and chained subagents without a second task queue", { timeout: 90_000 }, async (t) => {
  const { service, model, client } = await fixture(t);
  terminalSuccess(await client.run("E2E single", "e2e-subagent"));
  const parallelStart = model.requests.length;
  terminalSuccess(await client.run("E2E parallel", "e2e-subagent"));
  const parallelChildren = model.requests.map((request, index) => ({ request, timing: model.requestTimings[index], index }))
    .filter(({ request, index }) => index >= parallelStart && childRequest(request) && !request.messages.some((message) => message.role === "tool"));
  assert.equal(parallelChildren.length, 2);
  assert.ok(Math.max(...parallelChildren.map(({ timing }) => timing.startedAt)) < Math.min(...parallelChildren.map(({ timing }) => timing.endedAt!)), "two provider requests must actually overlap");
  const chainStart = model.requests.length;
  terminalSuccess(await client.run("E2E chain", "e2e-subagent"));
  const chainChildren = model.requests.slice(chainStart).filter(childRequest);
  assert.equal(chainChildren.length, 2);
  assert.ok(chainChildren.some((request) => request.messages.some((message) => message.role === "user" && userText(message.content) === "Task: E2E previous E2E-CHAIN-SEED")));
  for (const request of model.requests.filter(childRequest)) {
    const names = (request.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(!names.some((name) => ["bash", "subagent", "schedule", "monitor", "instructions", "delegate_task"].includes(name)));
    assert.ok(!request.messages.some((message) => message.role === "user" && userText(message.content) === "E2E parallel"));
  }
  assert.ok((await readdir(join(service.dataDir, "sessions"))).every((name) => !name.startsWith("subagent-")));
  await assert.rejects(stat(join(service.dataDir, "tasks.json")), { code: "ENOENT" });
  await client.json("/api/threads/e2e-subagent/skills", { overrides: { task: false } }, "PUT");
  const disabledStart = model.requests.length;
  terminalSuccess(await client.run("plain check", "e2e-subagent"));
  assert.ok(!(model.requests[disabledStart].tools as { function: { name: string } }[]).some((tool) => tool.function.name === "subagent"));
});

for (const decision of ["approve", "deny", "cancel"] as const) {
  test(`e2e: subagent file approval ${decision} preserves ownership and filesystem truth`, { timeout: 90_000 }, async (t) => {
    const { service, client } = await fixture(t);
    const running = await client.startRun("请子代理写入", "e2e-approval");
    const action = await waitForTest(async () => pendingApprovalsResponse.parse(await client.json("/api/approvals/pending")).approvals.find((item) => item.runId === running.runId), "child approval");
    assert.equal(action.threadId, running.threadId);
    assert.match(action.payload.content, /DRAFT-CONTENT/);
    const childDir = (await readdir(join(service.dataDir, "workspace/threads"))).find((name) => name.startsWith("subagent-"));
    assert.ok(childDir);
    const target = join(service.dataDir, "workspace/threads", childDir, "draft.md");
    await assert.rejects(stat(target), { code: "ENOENT" });
    if (decision === "cancel") {
      assert.equal((await client.json("/api/conversation/stop", { threadId: running.threadId, runId: running.runId })).stopped, true);
      const events = await running.done;
      assert.equal(events.at(-1)?.type, "RUN_ERROR");
    } else {
      assert.equal((await client.request(`/api/approvals/${action.id}/decision`, { decision })).status, 200);
      terminalSuccess(await running.done);
    }
    assert.equal((await client.json(`/api/approvals/${action.id}`)).status, decision === "approve" ? "approved" : decision === "deny" ? "denied" : "cancelled");
    if (decision === "approve") assert.equal(await readFile(target, "utf8"), action.payload.content);
    else await assert.rejects(stat(target), { code: "ENOENT" });
    assert.deepEqual((await client.json("/api/approvals/pending")).approvals, []);
    terminalSuccess(await client.run("现在几点", running.threadId));
  });
}

test("e2e: Stop interrupts the child model and real slow HTTP socket, then the same thread remains usable", { timeout: 90_000 }, async (t) => {
  const { model, client } = await fixture(t);
  const started = model.requests.length;
  const child = await client.startRun("请子代理挂起", "e2e-stop");
  await waitForTest(() => model.requests.length >= started + 2, "child provider request");
  const closedBefore = model.slowClosed();
  assert.equal((await client.json("/api/conversation/stop", { threadId: child.threadId, runId: child.runId })).stopped, true);
  assert.equal((await child.done).at(-1)?.type, "RUN_ERROR");
  await waitForTest(() => model.slowClosed() > closedBefore, "child provider disconnect");
  terminalSuccess(await client.run("现在几点", child.threadId));
  let entered = false;
  let closed = false;
  const server = createServer((_request, response) => {
    entered = true;
    response.writeHead(200, { "Content-Type": "text/plain" }); response.write("partial body");
    response.once("close", () => { closed = true; });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const web = await client.startRun(`E2E child-web http://127.0.0.1:${address.port}/slow`, child.threadId);
  await waitForTest(() => entered, "child real HTTP socket");
  const stopStart = Date.now();
  assert.equal((await client.json("/api/conversation/stop", { threadId: web.threadId, runId: web.runId })).stopped, true);
  assert.equal((await web.done).at(-1)?.type, "RUN_ERROR");
  await waitForTest(() => closed, "slow socket closed", 3000);
  assert.ok(Date.now() - stopStart < 3000, "must not wait for web transport timeout");
  terminalSuccess(await client.run("现在几点", web.threadId));
});

test("e2e: private workspaces stay isolated and deleted threads do not revive on reads or late Stop", { timeout: 90_000 }, async (t) => {
  const { service, client } = await fixture(t);
  await client.json("/api/threads/e2e-owner/instructions", { instructions: "owner" }, "PUT");
  await client.json("/api/threads/e2e-other/instructions", { instructions: "other" }, "PUT");
  await writeFile(join(service.dataDir, "workspace/threads/e2e-owner/private.md"), "OWNER-PRIVATE");
  await writeFile(join(service.dataDir, "workspace/shared/shared.md"), "SHARED-OK");
  const missing = await client.run("读 private.md", "e2e-other");
  assert.ok(!JSON.stringify(missing).includes("OWNER-PRIVATE"));
  const shared = await client.run("读 shared/shared.md", "e2e-other");
  assert.match(shared.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join(""), /SHARED-OK/);
  terminalSuccess(await client.run("hello", "e2e-owner"));
  const remove = await client.json("/api/threads/e2e-owner", undefined, "DELETE");
  assert.deepEqual(remove.removed, { jobs: 0, monitors: 0 });
  assert.deepEqual(await client.history("e2e-owner"), { messages: [], revision: "empty" });
  assert.deepEqual(await client.json("/api/conversation/stop", { threadId: "e2e-owner", runId: "late" }), { stopped: false });
  assert.ok(!(await client.json("/api/threads")).threads.some((thread: { id: string }) => thread.id === "e2e-owner"));
  await assert.rejects(stat(join(service.dataDir, "sessions/e2e-owner")), { code: "ENOENT" });
});

test("e2e: workspace named SSE matches its contract and SIGTERM ends open subscriptions", { timeout: 90_000 }, async (t) => {
  const { service, token, client } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(service.baseUrl + "/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.match(stream.headers.get("Content-Type") ?? "", /text\/event-stream/);
  const reader = stream.body!.getReader();
  t.after(async () => { await reader.cancel().catch(() => undefined); });
  let buffer = "";
  const decoder = new TextDecoder();
  const nextFrame = async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); return frame; }
      const value = await reader.read(); if (value.done) return null;
      buffer += decoder.decode(value.value, { stream: true });
    }
  };
  assert.equal(await nextFrame(), "event: ready\ndata: {}");
  await client.json("/api/agent/memories", { text: "SSE-E2E" });
  assert.equal(await nextFrame(), "event: workspace_updated\ndata: {}");
  const spec = await client.json("/openapi.json");
  assert.deepEqual(Object.keys(spec.paths["/api/events"].get.responses["200"]["x-sse-events"]).sort(), ["actions_updated", "ready", "workspace_updated"]);
  await service.stop();
  assert.equal(await nextFrame(), null);
});
