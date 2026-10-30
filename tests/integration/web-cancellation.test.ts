import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import type { ModelRequest } from "../support/fake-model.js";

/** HTTP、工具和pi都是真实链路；provider仅用固定工具请求保证每次覆盖在途取消。 */
for (const delegated of [false, true]) {
  test(`${delegated ? "subagent" : "foreground"} Stop aborts an in-flight web_fetch socket and releases the parent`, { timeout: 15_000 }, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-web-stop-"));
    let service: Awaited<ReturnType<typeof createService>> | undefined;
    const providerRequests: ModelRequest[] = [];
    let entered = false;
    let socketClosed = false;
    let answered = false;
    let delayed: ReturnType<typeof setTimeout> | undefined;
    const target = createServer((_request, response) => {
      entered = true;
      response.on("close", () => { socketClosed = true; clearTimeout(delayed); });
      delayed = setTimeout(() => { answered = true; response.end("too late"); }, 10_000);
    });
    const provider = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const input = JSON.parse(body) as ModelRequest;
      providerRequests.push(input);
      const tools = input.tools as { function: { name: string } }[];
      const child = input.messages.some((message) => message.role === "system" && String(message.content).includes("## Subagent role"));
      const callSubagent = delegated && !child && tools.some((tool) => tool.function.name === "subagent");
      const toolName = callSubagent ? "subagent" : "web_fetch";
      const toolArgs = callSubagent ? { mode: "single", tasks: [{ agent: "worker", task: "Fetch the controlled slow web page" }] } : { url: targetUrl };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, reason: string | null = null) => response.write("data: " + JSON.stringify({
        id: "cancel-test", object: "chat.completion.chunk", model: input.model,
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) + "\n\n");
      chunk({ role: "assistant" });
      chunk({ tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] });
      chunk({}, "tool_calls");
      response.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      try { await service?.close(); }
      finally {
        clearTimeout(delayed);
        target.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise<void>((resolve) => target.close(() => resolve())), new Promise<void>((resolve) => provider.close(() => resolve()))]);
        await rm(dataDir, { recursive: true, force: true });
      }
    });
    target.listen(0, "127.0.0.1"); provider.listen(0, "127.0.0.1");
    await Promise.all([once(target, "listening"), once(provider, "listening")]);
    const targetAddress = target.address(); const providerAddress = provider.address();
    assert.ok(targetAddress && typeof targetAddress !== "string" && providerAddress && typeof providerAddress !== "string");
    const targetUrl = `http://127.0.0.1:${targetAddress.port}/slow`;
    service = await createService(createConfig({
      server: { host: "127.0.0.1" },
      model: { baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, id: "test-model", apiKey: "test-only" },
      runtime: { dataDir, runTimeoutMs: 12_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
      tools: { web: { allowPrivateTargets: true, timeoutMs: 30_000 } },
    }));
    const headers = { Authorization: `Bearer ${service.auth.login()}`, "content-type": "application/json" };
    const runId = randomUUID();
    const running = Promise.resolve(service.app.request("/api/conversation/run", {
      method: "POST", headers, body: JSON.stringify({ spaceId: "local-main", runId, expectedRevision: "empty", message: { id: randomUUID(), content: "Fetch slow page" } }),
    })).then((response) => response.text());
    const deadline = Date.now() + 8000;
    while (!entered) { assert.ok(Date.now() < deadline, "tool did not reach the target"); await sleep(10); }
    const before = Date.now();
    const stop = await service.app.request("/api/conversation/stop", { method: "POST", headers, body: JSON.stringify({ spaceId: "local-main", runId }) });
    assert.equal((await stop.json()).stopped, true);
    const text = await running;
    while (!socketClosed) { assert.ok(Date.now() - before < 2500, "socket did not close on Stop"); await sleep(10); }
    assert.ok(Date.now() - before < 2500, "Stop must not wait for target completion or transport timeout");
    assert.equal(answered, false);
    assert.match(text, /"code":"STOPPED"/);
    assert.ok(!text.includes('"type":"RUN_FINISHED"'));
    assert.equal((await service.conversationHub.forThread("local-main")).isRunning(), false);
    assert.equal(providerRequests.length, delegated ? 2 : 1, "cancelled tool must not start another model turn");
  });
}
