import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createAuth } from "../../src/adapters/auth/token-service.js";
import { serviceVersion } from "../../src/bootstrap/service-version.js";
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

test("auth: newly issued tokens carry a far-future exp and stay valid across many calls", async (t) => {
  // 验收 #2：login() 不再写 +24h 过期；新 token 的 payload.exp 必须远超原 24h（一年以上），
  // 并且同一 token 多次 authorized() 都返回 true，确保 authorized() 没有把"过期"语义写死。
  // 不引入时间冻结：仓库无 sinon/fake timers，伪造 Date.now() 容易绕过分支；改为断言 payload 结构和重复调用。
  const config = await temporaryConfig(t, {
    server: { accessKey: "workspace-key" },
    model: { apiKey: "model-key" },
  });
  const auth = await createAuth(config);
  const token = auth.login("workspace-key");
  assert.ok(token);
  const [payload, signature] = token.split(".");
  assert.ok(payload);
  assert.ok(signature);
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString(),
  ) as { owner?: string; exp?: number };
  assert.equal(decoded.owner, "local-user");
  assert.equal(typeof decoded.exp, "number");
  // 原 24h = 86_400_000；这里要求至少 1 年 (365d) 作为"远超 24h"的硬指标，
  // 实际上线后实现为 Number.MAX_SAFE_INTEGER，这个上界会远大于 1 年。
  assert.ok(
    decoded.exp! > Date.now() + 365 * 86_400_000,
    `expected exp > now + 365d, got exp=${decoded.exp} now=${Date.now()}`,
  );
  // 同一 token 多次 authorized() 必须稳定为 true，避免有人偷偷加 TTL/cache 之类的过期路径。
  assert.equal(auth.authorized(`Bearer ${token}`), true);
  assert.equal(auth.authorized(`Bearer ${token}`), true);
  assert.equal(auth.authorized(`Bearer ${token}`), true);
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
        serviceVersion: await serviceVersion,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
          "/api/threads",
          "/api/profile",
          "/api/agent",
          "/api/conversation",
          "/api/approvals/pending",
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
      "OpenMuse workspace snapshot is gone with the compat layer",
      async () => {
        // 兼容层已移除：/api/workspace 不再返回 OpenMuse 形状的快照。
        const response = await authorized("/api/workspace");
        assert.equal(response.status, 501);
      },
    );

    await t.test(
      "agent snapshot and initial conversation are available without a model",
      async () => {
        const response = await authorized("/api/agent");
        assert.equal(response.status, 200);
        const agent = await response.json();
        assert.equal(agent.identity.name, "pi-muse");
        assert.equal(Object.hasOwn(agent, "goals"), false);
        assert.equal(Object.hasOwn(agent, "worker"), false);
        assert.equal(Object.hasOwn(agent, "tasks"), false);
        assert.equal(Object.hasOwn(agent, "monitors"), false);
        assert.equal(Object.hasOwn(agent, "memories"), false);
        const goalsResponse = await authorized("/api/goals");
        assert.equal(goalsResponse.status, 200);
        assert.deepEqual(await goalsResponse.json(), { goals: [] });
        const memoriesResponse = await authorized("/api/memories");
        assert.equal(memoriesResponse.status, 200);
        assert.deepEqual(await memoriesResponse.json(), { memories: [] });
        const monitorsResponse = await authorized("/api/monitors");
        assert.equal(monitorsResponse.status, 200);
        assert.deepEqual(await monitorsResponse.json(), { monitors: [] });
        const jobsResponse = await authorized("/api/jobs");
        assert.equal(jobsResponse.status, 200);
        assert.deepEqual(await jobsResponse.json(), { jobs: [] });
        const history = await authorized("/api/conversation");
        assert.equal(history.status, 200);
        const initial = await history.json() as { sessionId: string; messages: unknown[]; revision: string };
        assert.match(initial.sessionId, /^[0-9a-f-]{36}$/);
        assert.deepEqual({ messages: initial.messages, revision: initial.revision }, { messages: [], revision: "empty" });
      },
    );

    await t.test(
      "unsupported features and runtime operations return JSON 501",
      async () => {
        for (const [path, method] of [
          ["/api/files", "GET"],
          ["/api/notifications", "GET"],
          ["/api/agent/monitors", "POST"],
          ["/api/agent/memories", "GET"],
          ["/api/agent/memories", "POST"],
          ["/api/agent/goals", "POST"],
          ["/api/copilotkit/threads", "GET"],
          ["/api/copilotkit/agent/default/connect", "POST"],
        ] as const) {
          await jsonError(await authorized(path, { method }), 501);
        }
        await jsonError(await app.request("/not-an-api-route"), 404);
      },
    );

    await t.test(
      "CORS allows any origin and echoes it back, but authentication is still required",
      async () => {
        // CORS 整体放行：浏览器拿到的是它自己发的 Origin 字符串，而不是字面量 "*"。
        const allowed = await app.request("/api/health", {
          headers: { Origin: "http://localhost:8081" },
        });
        assert.equal(allowed.status, 200);
        assert.equal(
          allowed.headers.get("access-control-allow-origin"),
          "http://localhost:8081",
        );
        // 非白名单内的 origin 也照样放行——CORS 不承担访问控制，鉴权由 Authorization 头负责。
        const alsoAllowed = await app.request("/api/health", {
          headers: { Origin: "https://untrusted.example.test" },
        });
        assert.equal(alsoAllowed.status, 200);
        assert.equal(
          alsoAllowed.headers.get("access-control-allow-origin"),
          "https://untrusted.example.test",
        );
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
        // 即便 origin 已通过 CORS，未带 Authorization 的请求依然 401——CORS 不是鉴权。
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
            await authorized("/api/conversation/run", {
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
      "conversation history is read-only (PUT removed with compat layer)",
      async () => {
        // PUT 回写端点已删除：任何 PUT 都落到未知 API 的 501，历史只能 GET。
        const response = await authorized("/api/conversation", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { id: "forged", role: "assistant", content: "client overwrite" },
            ],
          }),
        });
        assert.equal(response.status, 501);
        const after = await (await authorized("/api/conversation")).json() as { sessionId: string; messages: unknown[]; revision: string };
        assert.match(after.sessionId, /^[0-9a-f-]{36}$/);
        assert.deepEqual({ messages: after.messages, revision: after.revision }, { messages: [], revision: "empty" });
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
