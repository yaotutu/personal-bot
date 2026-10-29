import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { conversationResponse } from "../../src/http/contracts/responses.js";

const sseFinished = (text: string) =>
  text.split("\n").some((line) => {
    if (!line.startsWith("data: ")) return false;
    try {
      return (JSON.parse(line.slice(6)) as { type?: string }).type === "RUN_FINISHED";
    } catch {
      return false;
    }
  });

const execute = async (options: { configPath: string }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel } = await import("../support/live-model.js");

  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error("Model configuration is required");

  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let root: string | undefined;
  let executionError: unknown;

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-information-context-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-information-context-key" },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 180_000,
        schedulerIntervalMs: 60_000,
        monitorScanIntervalMs: 60_000,
      },
      tools: { presentation: { default: "summary" }, web: { enabled: false }, browser: { enabled: false } },
    });

    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "live-information-context-key" }),
    });
    assert.equal(login.status, 200);
    const token = ((await login.json()) as { token: string }).token;

    const api = async (path: string, init: RequestInit = {}, timeoutMs = 180_000) => {
      const response = await fetch(baseUrl + path, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body, text };
    };
    const expectApi = async (path: string, init?: RequestInit) => {
      const result = await api(path, init);
      assert.equal(result.status, 200, `${path} returned ${result.status}`);
      return result;
    };
    const saveSettings = (spaceId: string, enabled: boolean) =>
      expectApi(`/api/spaces/${spaceId}/information/settings`, {
        method: "PUT",
        body: JSON.stringify({ enabled, batchWindowSeconds: 3600 }),
      });
    const establishSpace = (spaceId: string) =>
      expectApi(`/api/spaces/${spaceId}/instructions`, {
        method: "PUT",
        body: JSON.stringify({ instructions: "Information context live test space." }),
      });
    const history = async (spaceId: string) =>
      conversationResponse.parse((await expectApi(`/api/conversation?spaceId=${spaceId}`)).body);
    const startChat = async (spaceId: string, marker: string) => {
      const before = await history(spaceId);
      const result = await api("/api/conversation/run", {
        method: "POST",
        body: JSON.stringify({
          spaceId,
          runId: `live-info-context-${randomUUID()}`,
          expectedRevision: before.revision,
          message: {
            id: `live-info-context-user-${randomUUID()}`,
            content: `${marker}: Reply with only the word ok. Do not call any tool.`,
          },
        }),
      }, 300_000);
      assert.equal(result.status, 200, `chat HTTP ${result.status}`);
      assert.ok(sseFinished(result.text), `chat ${marker} did not finish successfully`);
    };
    const checkCapability = async (label: string, spaceId: string, enabled: boolean, marker: string) => {
      const baseline = proxy!.traces.length;
      await startChat(spaceId, marker);
      const requests = proxy!.traces.slice(baseline);
      assert.ok(requests.length > 0, `${label}: no real model request`);
      for (const request of requests) {
        assert.equal(request.systemMarkers.informationBackground, enabled, `${label}: wrong upstream system marker`);
        assert.equal(request.toolNames.includes("information"), enabled, `${label}: wrong information tool declaration`);
      }
      process.stdout.write(`[PASS] ${JSON.stringify({
        label,
        modelRequests: requests.length,
        systemMarkers: requests.map((request) => request.systemMarkers.informationBackground),
        informationTool: requests.map((request) => request.toolNames.includes("information")),
      })}\n`);
    };

    const main = "local-main";
    const other = "live-information-context-closed";
    await establishSpace(main);
    const initialSettings = (await expectApi(`/api/spaces/${main}/information/settings`)).body as { enabled: boolean };
    assert.equal(initialSettings.enabled, false, "new main space must default to information disabled");
    await checkCapability("default-disabled-space", main, false, "LIVE_INFORMATION_CONTEXT_CLOSED");

    await saveSettings(main, true);
    await checkCapability("enabled-space", main, true, "LIVE_INFORMATION_CONTEXT_ENABLED");

    await establishSpace(other);
    await saveSettings(other, false);
    await checkCapability("other-disabled-space", other, false, "LIVE_INFORMATION_CONTEXT_OTHER_CLOSED");

    await saveSettings(main, false);
    await checkCapability("disabled-after-enable", main, false, "LIVE_INFORMATION_CONTEXT_DISABLED");

    await saveSettings(main, true);
    await checkCapability("reenabled-space", main, true, "LIVE_INFORMATION_CONTEXT_REENABLED");
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    const cleanup: Array<{ label: string; promise: Promise<unknown> }> = [];
    if (service) cleanup.push({ label: "service", promise: service.close() });
    if (http) {
      if ("closeAllConnections" in http) http.closeAllConnections();
      cleanup.push({
        label: "http",
        promise: new Promise<void>((resolve, reject) => http!.close((error) => error ? reject(error) : resolve())),
      });
    }
    if (proxy) cleanup.push({ label: "model proxy", promise: proxy.close() });
    const cleanupResults = await Promise.allSettled(cleanup.map((item) => item.promise));
    if (root) await rm(root, { recursive: true, force: true });
    const cleanupFailures = cleanupResults
      .map((result, index) => result.status === "rejected"
        ? `${cleanup[index]!.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        : undefined)
      .filter((failure): failure is string => Boolean(failure));
    if (cleanupFailures.length) {
      const cleanupMessage = `Cleanup failed (${cleanupFailures.join("; ")})`;
      if (executionError === undefined) throw new Error(cleanupMessage);
      throw new Error(`${executionError instanceof Error ? executionError.message : String(executionError)}; ${cleanupMessage}`);
    }
  }
};

const outcome = parseLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help);
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else if (outcome.options.keepArtifacts) {
  console.error("--keep-artifacts is not supported by this focused live check");
  process.exitCode = 1;
} else {
  try {
    await execute(outcome.options);
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
