import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createLiveModel, redactApiKey } from "../support/live-model.js";
import { waitForTest } from "../support/http-client.js";

// 这里只验证验收代理自身，不调用供应商，不以本测试代替真实模型验收。
test("live observer forwards configured credentials only and records actual streamed tool calls", async (t) => {
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let authorization: string | undefined;
  let received: unknown;
  const upstream = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    let body = ""; for await (const part of request) body += part;
    received = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const delta of [
      { tool_calls: [{ index: 0, function: { name: "currentTime", arguments: "{" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
      { content: "OBSERVED-OUTPUT" },
    ]) response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\r\n\r\n`);
    response.end("data: [DONE]\r\n\r\n");
  });
  t.after(async () => {
    try { await proxy?.close(); }
    finally { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  proxy = await createLiveModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "configured-test-key" });
  const input = {
    messages: [{ role: "system", content: "PRIVATE-SYSTEM ## Subagent role" }, { role: "user", content: "Synthetic task" }, { role: "tool", content: "observed prior result" }],
    tools: [{ function: { name: "currentTime" } }], stream: true,
  };
  const response = await fetch(proxy.baseUrl + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer downstream-placeholder" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200); assert.match(await response.text(), /OBSERVED-OUTPUT/);
  await waitForTest(() => proxy!.traces[0]?.endedAt, "observer completion");
  assert.equal(authorization, "Bearer configured-test-key"); assert.deepEqual(received, input);
  const trace = proxy.traces[0];
  assert.equal(trace.child, true);
  assert.deepEqual(trace.toolNames, ["currentTime"]);
  assert.deepEqual(trace.calls, [{ name: "currentTime", arguments: "{}" }]);
  assert.deepEqual(trace.toolResults, ["observed prior result"]);
  assert.equal(trace.output, "OBSERVED-OUTPUT");
  assert.ok(!JSON.stringify(trace).includes("PRIVATE-SYSTEM"));
  assert.ok(!JSON.stringify(trace).includes("configured-test-key"));
  assert.equal(redactApiKey("test-short-test-short", "short"), "test-[REDACTED]-test-[REDACTED]");
});

test("live observer client cancellation aborts its upstream socket and close is idempotent", { timeout: 8000 }, async (t) => {
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let entered = false;
  let closed = false;
  const upstream = createServer((_request, response) => {
    entered = true; response.once("close", () => { closed = true; });
  });
  t.after(async () => {
    try { await proxy?.close(); }
    finally { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  proxy = await createLiveModel({ baseUrl: `http://127.0.0.1:${address.port}/v1` });
  const controller = new AbortController();
  const pending = fetch(proxy.baseUrl + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hang" }] }), signal: controller.signal,
  });
  const rejected = assert.rejects(pending, /abort/i);
  await waitForTest(() => entered, "upstream request"); controller.abort(); await rejected;
  await waitForTest(() => closed, "upstream disconnect");
  await proxy.close(); await proxy.close();
  assert.equal(proxy.traces[0].disconnected, true);
});
