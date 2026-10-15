import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createConfig, loadConfig } from "../../src/config/load-config.js";

/** 每个用例独立配置文件；正式 loadConfig 永远不允许回退到环境变量。 */
const configFixture = async (t: TestContext, value: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-config-file-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path;
};

test("config file loads all direct settings and its instance directory", async (t) => {
  const path = await configFixture(t, {
    schemaVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 9000,
      accessKey: "workspace-key",
      allowedOrigins: [" https://a.test "],
    },
    model: {
      baseUrl: " http://127.0.0.1:8000/v1/// ",
      id: " local-model ",
      apiKey: " model-key ",
      contextWindow: 8192,
      maxTokens: 2048,
    },
    runtime: { runTimeoutMs: 10000, schedulerIntervalMs: 2000 },
  });
  const config = loadConfig(path);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9000);
  assert.equal(config.accessKey, "workspace-key");
  assert.equal(config.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(config.modelId, "local-model");
  assert.equal(config.apiKey, "model-key");
  assert.equal(config.maxTokens, 2048);
  assert.equal(config.contextWindow, 8192);
  assert.equal(config.runTimeoutMs, 10000);
  assert.equal(config.schedulerIntervalMs, 2000);
  assert.deepEqual(config.allowedOrigins, ["https://a.test"]);
  assert.equal(config.dataDir, resolve(path, ".."));
});

test("config defaults allow an unconfigured loopback instance", async (t) => {
  const path = await configFixture(t, {});
  const config = loadConfig(path);
  assert.deepEqual(
    { ...config, dataDir: undefined },
    {
      host: "127.0.0.1",
      accessKey: undefined,
      baseUrl: undefined,
      modelId: undefined,
      maxTokens: 4096,
      contextWindow: 32768,
      port: 8787,
      apiKey: undefined,
      dataDir: undefined,
      runTimeoutMs: 120000,
      schedulerIntervalMs: 30000,
      allowedOrigins: [
        "http://localhost:8081",
        "http://127.0.0.1:8081",
      ],
      configured: false,
      web: {
        enabled: true,
        timeoutMs: 30000,
        maxResponseBytes: 2000000,
        maxContentChars: 50000,
        searchResults: 5,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36",
      },
      weather: { enabled: true, defaultCity: undefined },
      writable: { enabled: true, actionTimeoutMs: 300000 },
      presentation: { default: "hidden", overrides: {} },
    },
  );
  assert.equal(config.dataDir, resolve(path, ".."));
});

test("runtime.dataDir resolves relative to the config file", async (t) => {
  const path = await configFixture(t, {
    runtime: { dataDir: "../instance-data" },
  });
  assert.equal(
    loadConfig(path).dataDir,
    resolve(path, "..", "..", "instance-data"),
  );
});

test("config rejects partial models, unsafe hosts and invalid limits", () => {
  assert.throws(
    () => createConfig({ model: { baseUrl: "http://model.test/v1" } }),
    /model.baseUrl and model.id together/,
  );
  assert.throws(
    () => createConfig({ server: { host: "0.0.0.0" } }),
    /server.accessKey.*non-loopback/,
  );
  assert.throws(
    () =>
      createConfig({
        model: { baseUrl: "http://user:secret@model.test/v1", id: "model" },
      }),
    /model.baseUrl must be an HTTP/,
  );
  assert.throws(
    () => createConfig({ server: { port: 65536 } }),
    /server.port/,
  );
  assert.throws(
    () =>
      createConfig({
        model: { maxTokens: 4096, contextWindow: 4096 },
      }),
    /smaller than model.contextWindow/,
  );
});

test("missing explicit config files, invalid JSON and unknown fields fail clearly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-config-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing.json");
  assert.throws(() => loadConfig(missing), /Config file not found/);
  const malformed = join(dir, "malformed.json");
  await writeFile(malformed, "{", { mode: 0o600 });
  assert.throws(() => loadConfig(malformed), /Invalid JSON/);
  const unknown = join(dir, "unknown.json");
  await writeFile(unknown, JSON.stringify({ schemaVersion: 1, unknown: true }), {
    mode: 0o600,
  });
  assert.throws(() => loadConfig(unknown), /Invalid config file/);
  const future = join(dir, "future.json");
  await writeFile(future, JSON.stringify({ schemaVersion: 2 }), { mode: 0o600 });
  assert.throws(() => loadConfig(future), /schemaVersion/);
});
