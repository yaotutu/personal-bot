import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";

/**
 * 文档防漂移契约测试：
 * 1) 生成的 OpenAPI 文档结构完整（每端点有 summary/200 响应 schema）。
 * 2) 免鉴权文档端点（/openapi.json、/docs）真实可达。
 * 3) 无副作用的 GET 端点真实响应能被注册表响应 schema safeParse——
 *    实现改了 schema 没跟（或反之），这里立刻红。
 */

test("docs: generated OpenAPI document is structurally complete", () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  for (const endpoint of endpoints) {
    const path = endpoint.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation = (doc.paths as Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>)[path]?.[endpoint.method];
    assert.ok(operation, `${endpoint.method} ${path} missing in generated doc`);
    assert.ok(operation.summary, `${path} has no summary`);
    const ok = operation.responses?.["200"];
    assert.ok(ok, `${path} has no 200 response`);
    if (!endpoint.sse) {
      const schema = (ok as { content?: { "application/json"?: { schema?: unknown } } }).content?.["application/json"]?.schema;
      assert.ok(schema, `${path} 200 response has no JSON schema`);
    } else {
      assert.ok((ok as Record<string, unknown>)["x-sse-events"], `${path} SSE response has no event contract`);
    }
  }
});

test("docs: /openapi.json and /docs are served without auth", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-docs-"));
  t.after(async () => {
    await (await serviceRef).close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let serviceRef!: Promise<Awaited<ReturnType<typeof createService>>>;
  serviceRef = createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const service = await serviceRef;
  const spec = await service.app.request("/openapi.json");
  assert.equal(spec.status, 200);
  const body = (await spec.json()) as { paths: Record<string, unknown> };
  assert.ok(Object.keys(body.paths).length >= 20, "spec should cover all endpoints");
  const docs = await service.app.request("/docs");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /scalar\.js|jsdelivr/);
  const scalar = await service.app.request("/scalar.js");
  assert.equal(scalar.status, 200);
  assert.match(await scalar.text(), /createApiReference/);
});

test("docs: live GET responses parse against registry schemas (no drift)", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-drift-"));
  t.after(async () => {
    await service.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  const cases: { path: string }[] = endpoints
    .filter((e) => e.method === "get" && !e.path.includes(":") && e.path !== "/api/health" || e.path === "/api/health")
    .map((e) => ({ path: e.path }));
  // conversation 需要查询参数；单独加。
  for (const { path } of cases) {
    const response = await service.app.request(path, { headers });
    assert.equal(response.status, 200, `${path} should be 200`);
    const endpoint = endpoints.find((e) => e.path === path && e.method === "get")!;
    const parsed = endpoint.response.safeParse(await response.json());
    assert.ok(parsed.success, `${path} response drifted from schema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 200)}`);
  }
  const conv = await service.app.request("/api/conversation?threadId=local-main", { headers });
  assert.equal(conv.status, 200);
  const convEndpoint = endpoints.find((e) => e.path === "/api/conversation")!;
  assert.ok(convEndpoint.response.safeParse(await conv.json()).success, "conversation response drifted");
  const profile = await service.app.request("/api/profile", { headers });
  const profileEndpoint = endpoints.find((e) => e.path === "/api/profile" && e.method === "get")!;
  assert.ok(profileEndpoint.response.safeParse(await profile.json()).success, "profile response drifted");
});

test("docs: every served route is registered and every registration is served (no shadow API)", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-audit-"));
  t.after(async () => {
    await service.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const allRoutes = (service.app as unknown as { routes: { method: string; path: string }[] }).routes;
  const served = allRoutes
    .filter((r) => ["GET", "POST", "PUT"].includes(r.method))
    .map((r) => `${r.method.toLowerCase()} ${r.path}`);
  const copilotkitWildcard = allRoutes.some(
    (r) => r.method === "ALL" && r.path === "/api/copilotkit/*",
  );
  // 文档基础设施路由：自身即文档面，不进注册表（登记会造成自引用）。
  const docsInfra = new Set(["get /openapi.json", "get /docs", "get /scalar.js"]);
  const registry = new Set(endpoints.map((e) => `${e.method} ${e.path}`));

  for (const key of served) {
    if (docsInfra.has(key)) continue;
    assert.ok(
      registry.has(key),
      `路由已注册到 Hono 但未登记端点注册表（文档会漏掉它）：${key}`,
    );
  }
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const servedDirectly = served.includes(key);
    // AG-UI run/stop/info 挂在 /api/copilotkit/* 通配处理器下，无具体路由行。
    const coveredByWildcard =
      copilotkitWildcard && endpoint.path.startsWith("/api/copilotkit/");
    assert.ok(
      servedDirectly || coveredByWildcard,
      `注册表登记了 ${key}，但服务端没有对应路由（文档在撒谎）`,
    );
  }
});
