import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createAuth } from "../../src/adapters/auth/token-service.js";
import { createConfig, type ConfigFileInput } from "../../src/config/load-config.js";

// 直接构造隔离配置对象，避免本机 config.json 或环境变量影响这些离线边界测试。
// 每个有持久化行为的测试独占临时目录；即使断言失败，after 也会清理签名密钥和会话数据。
const temporaryConfig = async (
  t: TestContext,
  value: ConfigFileInput = {},
) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-config-auth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return createConfig(
    { ...value, runtime: { ...value.runtime, dataDir } },
    { configFile: join(dataDir, "config.json") },
  );
};

// 错误响应必须保留 HTTP 状态及 JSON 结构，不能退化为 HTML 或仅靠正文表达失败。
const jsonError = async (response: Response, status: number) => {
  assert.equal(response.status, status);
  assert.match(
    response.headers.get("content-type") || "",
    /^application\/json\b/,
  );
  const body = (await response.json()) as { error?: unknown };
  assert.equal(typeof body.error, "string");
  assert.ok(body.error);
};

test("config: direct values are normalized and model credentials stay in config", () => {
  const config = createConfig({
    server: {
      host: "0.0.0.0",
      port: 9000,
      accessKey: " workspace-key ",
      allowedOrigins: [" https://client.example.test ", "", "http://localhost:8081 "],
    },
    model: {
      baseUrl: " http://127.0.0.1:8000/v1/// ",
      id: " local-model ",
      apiKey: " model-key ",
      maxTokens: 2048,
      contextWindow: 8192,
    },
    runtime: { dataDir: "data", runTimeoutMs: 10000 },
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.accessKey, "workspace-key");
  assert.equal(config.apiKey, "model-key");
  assert.equal(config.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(config.modelId, "local-model");
  assert.equal(config.port, 9000);
  assert.equal(config.maxTokens, 2048);
  assert.equal(config.contextWindow, 8192);
  assert.equal(config.runTimeoutMs, 10000);
  assert.deepEqual(config.allowedOrigins, [
    "https://client.example.test",
    "http://localhost:8081",
  ]);
});

test("auth: loopback login works without a configured key", async (t) => {
  const auth = await createAuth(await temporaryConfig(t));
  const token = auth.login();
  assert.ok(token);
  assert.equal(auth.authorized(`Bearer ${token}`), true);
});

test("auth: login, tampering and same-directory restart", async (t) => {
  const config = await temporaryConfig(t, {
    server: { accessKey: "workspace-key" },
    model: { apiKey: "model-key" },
  });
  const auth = await createAuth(config);
  [undefined, "", "wrong-key", "model-key"].forEach((key) =>
    assert.equal(auth.login(key), undefined),
  );
  const token = auth.login("workspace-key");
  assert.ok(token);
  assert.equal(auth.authorized(`Bearer ${token}`), true);
  const [payload, signature] = token.split(".");
  assert.ok(payload);
  assert.ok(signature);
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  // 保留原签名但改写 owner，可区分“只解码 payload”与真正验证 HMAC 的实现。
  const changedPayload = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, "base64url").toString()),
      owner: "other-user",
    }),
  ).toString("base64url");
  [
    undefined,
    null,
    "",
    token,
    `bearer ${token}`,
    "Bearer invalid",
    `Bearer ${payload}.${changedSignature}`,
    `Bearer ${changedPayload}.${signature}`,
    `Bearer ${token}.extra`,
  ].forEach((header) => assert.equal(auth.authorized(header), false));
  // 重新创建 auth 实例模拟重启，仍使用同一 DATA_DIR；旧 token 必须继续有效。
  const restarted = await createAuth(config);
  assert.equal(restarted.authorized(`Bearer ${token}`), true);
  const newToken = restarted.login("workspace-key");
  assert.ok(newToken);
  assert.equal(auth.authorized(`Bearer ${newToken}`), true);
});

test("auth: rotating the access key invalidates existing tokens in the same data directory", async (t) => {
  const config = await temporaryConfig(t, {
    server: { accessKey: "original-key" },
  });
  const original = await createAuth(config);
  const oldToken = original.login("original-key");
  assert.ok(oldToken);
  assert.equal(original.authorized(`Bearer ${oldToken}`), true);

  // 保留同一 DATA_DIR 及磁盘上的 secret，仅更换访问密钥；旧 token 必须被新实例拒绝。
  // 这能捕获签名仍只依赖持久化 secret、没有绑定访问密钥的回归。
  const rotatedConfig = createConfig({
    server: { accessKey: "rotated-key" },
    runtime: { dataDir: config.dataDir },
  });
  const rotated = await createAuth(rotatedConfig);
  assert.equal(rotated.authorized(`Bearer ${oldToken}`), false);
  assert.equal(rotated.login("original-key"), undefined);
  const newToken = rotated.login("rotated-key");
  assert.ok(newToken);
  assert.equal(rotated.authorized(`Bearer ${newToken}`), true);

  // 轮换后再以相同新密钥重启，新 token 仍有效，旧 token 仍失效。
  const restarted = await createAuth(rotatedConfig);
  assert.equal(restarted.authorized(`Bearer ${oldToken}`), false);
  assert.equal(restarted.authorized(`Bearer ${newToken}`), true);
});

test("app: offline health, authentication and text-only HTTP boundaries", async (t) => {
  const config = await temporaryConfig(t, {
    server: {
      accessKey: "workspace-key",
      allowedOrigins: ["http://localhost:8081"],
    },
  });
  const fixture = await createService(config);
  const { app } = fixture;
  // 不监听真实端口；通过真实登录路由取得 token，再验证后续路由，不绕过鉴权中间件。
  try {
    await t.test("health is public without a configured model", async () => {
      const response = await app.request("/api/health");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        backend: "pi",
        configured: false,
      });
    });

    await t.test("session rejects missing or wrong access keys", async () => {
      for (const body of [{}, { accessKey: "wrong-key" }]) {
        await jsonError(
          await app.request("/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          401,
        );
      }
    });

    const login = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "workspace-key" }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token?: unknown; mode?: unknown };
    assert.equal(session.mode, "live");
    assert.equal(typeof session.token, "string");
    assert.ok(session.token);
    const token = session.token;
    const authorized = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return app.request(path, { ...init, headers });
    };

    await t.test(
      "protected and unsupported API routes require a valid token",
      async () => {
        for (const path of [
          "/api/workspace",
          "/api/agent",
          "/api/conversation",
          "/api/copilotkit/info",
          "/api/files",
        ]) {
          await jsonError(await app.request(path), 401);
          await jsonError(
            await app.request(path, {
              headers: { Authorization: `Bearer ${token}tampered` },
            }),
            401,
          );
        }
      },
    );

    await t.test(
      "workspace exposes server-owned history and text-only capabilities",
      async () => {
        const response = await authorized("/api/workspace");
        assert.equal(response.status, 200);
        const workspace = await response.json();
        assert.equal(workspace.mode, "live");
        [
          "mail",
          "events",
          "files",
          "browsers",
          "actions",
          "activity",
          "connections",
        ].forEach((name) => {
          assert.deepEqual(workspace[name], []);
        });
        assert.deepEqual(workspace.runtime, {
          provider: "model",
          configured: false,
          openbotConfigured: false,
          richThreads: false,
          serverOwnedHistory: true,
        });
      },
    );

    await t.test(
      "agent snapshot and initial conversation are available without a model",
      async () => {
        const response = await authorized("/api/agent");
        assert.equal(response.status, 200);
        const agent = await response.json();
        [
          "tasks",
          "goals",
          "monitors",
          "ideas",
          "memories",
          "artifacts",
          "notifications",
        ].forEach((name) => {
          assert.deepEqual(agent[name], []);
        });
        assert.equal(agent.identity.name, "Personal Bot");
        assert.equal(agent.worker.running, false);
        const history = await authorized("/api/conversation");
        assert.equal(history.status, 200);
        assert.deepEqual(await history.json(), { messages: [] });
      },
    );

    await t.test(
      "unsupported features and runtime operations return JSON 501",
      async () => {
        for (const [path, method] of [
          ["/api/files", "GET"],
          ["/api/notifications", "GET"],
          ["/api/agent/tasks", "POST"],
          ["/api/copilotkit/threads", "GET"],
          ["/api/copilotkit/agent/default/connect", "POST"],
        ] as const) {
          await jsonError(await authorized(path, { method }), 501);
        }
        await jsonError(await app.request("/not-an-api-route"), 404);
      },
    );

    await t.test(
      "CORS allows the configured origin but does not grant other origins access",
      async () => {
        const allowed = await app.request("/api/health", {
          headers: { Origin: "http://localhost:8081" },
        });
        assert.equal(allowed.status, 200);
        assert.equal(
          allowed.headers.get("access-control-allow-origin"),
          "http://localhost:8081",
        );
        const denied = await app.request("/api/health", {
          headers: { Origin: "https://untrusted.example.test" },
        });
        assert.equal(denied.status, 200);
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
        const preflight = await app.request("/api/workspace", {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:8081",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
          },
        });
        assert.equal(preflight.status, 204);
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          "http://localhost:8081",
        );
        assert.ok(
          preflight.headers
            .get("access-control-allow-methods")
            ?.split(",")
            .includes("GET"),
        );
        const allowedHeaders =
          preflight.headers
            .get("access-control-allow-headers")
            ?.toLowerCase() || "";
        assert.match(allowedHeaders, /authorization/);
        assert.match(allowedHeaders, /content-type/);
        // 允许的 Origin 也必须登录，防止把 CORS 白名单误当作鉴权。
        await jsonError(
          await app.request("/api/workspace", {
            headers: { Origin: "http://localhost:8081" },
          }),
          401,
        );
      },
    );

    await t.test(
      "malformed session and run inputs return JSON 400",
      async () => {
        for (const body of [
          "{",
          "null",
          "[]",
          JSON.stringify({ accessKey: 123 }),
          JSON.stringify({ accessKey: "x".repeat(513) }),
        ]) {
          await jsonError(
            await app.request("/api/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            }),
            400,
          );
        }
        for (const body of [
          "{",
          "null",
          "{}",
          JSON.stringify({ threadId: "local-main", messages: "invalid" }),
        ]) {
          await jsonError(
            await authorized("/api/copilotkit/agent/default/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            }),
            400,
          );
        }
      },
    );

    await t.test(
      "conversation validates input and refuses client-owned history",
      async () => {
        for (const body of [
          "{",
          "{}",
          JSON.stringify({ messages: "invalid" }),
          JSON.stringify({ messages: [{ role: "invalid" }] }),
        ]) {
          await jsonError(
            await authorized("/api/conversation", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body,
            }),
            400,
          );
        }
        const unchanged = await authorized("/api/conversation", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        });
        assert.equal(unchanged.status, 200);
        assert.deepEqual(await unchanged.json(), { ok: true });
        await jsonError(
          await authorized("/api/conversation", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                {
                  id: "forged",
                  role: "assistant",
                  content: "client overwrite",
                },
              ],
            }),
          }),
          409,
        );
        assert.deepEqual(await (await authorized("/api/conversation")).json(), {
          messages: [],
        });
      },
    );

    await t.test(
      "requests with an oversized Content-Length return JSON 413 before parsing",
      async () => {
        // 标准非流式 HTTP 请求携带实际字节长度，稳定验证中间件的提前拒绝路径。
        const body = JSON.stringify({ accessKey: "x".repeat(1_048_576) });
        await jsonError(
          await app.request("/api/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(body)),
            },
            body,
          }),
          413,
        );
      },
    );
  } finally {
    // 先关闭会话再返回测试体；temporaryConfig 注册的 after 随后删除 DATA_DIR。
    await fixture.close();
  }
});
