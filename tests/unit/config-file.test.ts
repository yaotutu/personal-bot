import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("config defaults allow an unconfigured LAN-accessible instance", async (t) => {
  const path = await configFixture(t, {});
  const config = loadConfig(path);
  assert.deepEqual(
    { ...config, dataDir: undefined },
    {
      host: "0.0.0.0",
      accessKey: undefined,
      baseUrl: undefined,
      modelId: undefined,
      maxTokens: 4096,
      contextWindow: 32768,
      port: 12330,
      apiKey: undefined,
      dataDir: undefined,
      runTimeoutMs: 120000,
      monitorScanIntervalMs: 60000,
      schedulerIntervalMs: 30000,
      allowedOrigins: [
        "http://localhost:15173",
        "http://127.0.0.1:15173",
        "http://localhost:12330",
        "http://127.0.0.1:12330",
      ],
      configured: false,
      web: {
        allowPrivateTargets: false,
        enabled: true,
        timeoutMs: 30000,
        maxResponseBytes: 2000000,
        maxContentChars: 50000,
        searchResults: 5,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36",
      },
      weather: { enabled: true, defaultCity: undefined },
      writable: { enabled: true, actionTimeoutMs: 300000 },
      browser: { enabled: true, executablePath: undefined, allowPrivateTargets: false, timeoutMs: 30000, desktopPort: 6080 },
      presentation: { default: "hidden", overrides: {} },
    },
  );
  assert.equal(config.dataDir, resolve(path, ".."));
});

test("default config uses .pi-muse and never falls back to the old directory", async (t) => {
  for (const hasNewConfig of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-muse-default-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, ".personal-bot"));
    await writeFile(
      join(dir, ".personal-bot/config.json"),
      JSON.stringify({ server: { host: "127.0.0.1", port: 19999 } }),
      { mode: 0o600 },
    );
    if (hasNewConfig) {
      await mkdir(join(dir, ".pi-muse"));
      await writeFile(
        join(dir, ".pi-muse/config.json"),
        JSON.stringify({ server: { host: "127.0.0.1", port: 19998 } }),
        { mode: 0o600 },
      );
    }
    const cwd = process.cwd();
    // 仅同步调用期间切换 cwd，不让异步测试或真实实例继承临时路径。
    try {
      process.chdir(dir);
      if (hasNewConfig) {
        const config = loadConfig();
        assert.equal(config.port, 19998);
        assert.equal(config.dataDir, join(process.cwd(), ".pi-muse"));
      } else {
        assert.throws(
          () => loadConfig(),
          /Config file not found: .*\.pi-muse\/config\.json/,
        );
      }
    } finally {
      process.chdir(cwd);
    }
  }
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

test("browser config has no headless fallback because Chrome must stay headed", () => {
  assert.throws(
    () => createConfig({ tools: { browser: { headless: true } } }),
    /headless/,
  );
});

test("browser desktopPort defaults to 6080 and rejects out-of-range values", () => {
  assert.equal(createConfig({}).browser.desktopPort, 6080);
  assert.equal(createConfig({ tools: { browser: { desktopPort: 16080 } } }).browser.desktopPort, 16080);
  assert.throws(
    () => createConfig({ tools: { browser: { desktopPort: 0 } } }),
    /desktopPort/,
  );
  assert.throws(
    () => createConfig({ tools: { browser: { desktopPort: 65536 } } }),
    /desktopPort/,
  );
});

test("non-loopback host without accessKey warns instead of failing", () => {
  // 静默 capture console.warn，验证 LAN 默认行为：放行 + 提示安全。
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    const config = createConfig({ server: { host: "0.0.0.0" } });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.accessKey, undefined);
    assert.ok(
      warnings.some((w) => w.includes("server.accessKey") && w.includes("non-loopback")),
      `expected a non-loopback accessKey warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = original;
  }
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
