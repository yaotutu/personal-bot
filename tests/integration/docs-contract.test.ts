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
  assert.equal(doc.info.title, "pi-muse API");
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

test("docs: notification stream documents the client sync protocol and keeps event namespaces separate", () => {
  const document = buildOpenApiDocument();
  type StreamResponse = { description: string; "x-sse-events": Record<string, { schema: unknown }> };
  type Operation = { description: string; security?: unknown[]; responses: Record<string, StreamResponse> };
  const operation = document.paths["/api/events"].get as Operation;
  // 只检查标准描述，不借助 x-sse-events，防止关键接入规则只在机器扩展里存在。
  const description = operation.description;
  for (const rule of [
    /Authorization: Bearer/, /event:[\s\S]*data:/, /data: \{\}/, /UTF-8/, /空行/,
    /ready[\s\S]*\/api\/agent[\s\S]*\/api\/actions\/pending/,
    /workspace_updated/, /actions_updated/, /刷新请求进行中[\s\S]*补刷/,
    /首次连接[\s\S]*重连/, /回到前台[\s\S]*ready/, /30 秒[\s\S]*keep-alive/,
    /不发送事件 id/, /不支持历史重放/, /忽略 Last-Event-ID/,
    /不取消聊天或后台任务/, /服务关闭[\s\S]*结束活跃流/,
    /HTTP 401[\s\S]*重新登录/, /HTTP 503/, /不是聊天文字增量/, /不负责后台或锁屏推送/,
    /轮询/, /合并或冗余/,
  ]) assert.match(description, rule, `Missing client protocol rule in generated docs: ${rule}`);
  assert.ok(operation.security?.length);
  assert.deepEqual(Object.keys(operation.responses["200"]["x-sse-events"]).sort(), ["actions_updated", "ready", "workspace_updated"]);
  const chat = document.paths["/api/conversation/run"].post as Operation;
  assert.ok(Object.hasOwn(chat.responses["200"]["x-sse-events"], "RUN_FINISHED"));
  assert.ok(!Object.hasOwn(chat.responses["200"]["x-sse-events"], "workspace_updated"));
});

test("docs: /api/events SSE schema is text/event-stream with strict empty-object event payloads", () => {
  const doc = buildOpenApiDocument();
  const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/events"]?.get;
  assert.ok(op);
  const ok = (op.responses as Record<string, Record<string, unknown>>)["200"];
  // 200 必须声明 text/event-stream 媒体类型
  const content = (ok.content as Record<string, Record<string, unknown>>)["text/event-stream"];
  assert.ok(content, "200 必须声明 text/event-stream content");
  // 事件表恰好三种
  const table = ok["x-sse-events"] as Record<string, { schema: Record<string, unknown> }>;
  assert.ok(table, "必须声明 x-sse-events 事件契约");
  assert.deepEqual(Object.keys(table).sort(), ["actions_updated", "ready", "workspace_updated"]);
  // 每个事件 schema 都是严格的空对象
  for (const [name, entry] of Object.entries(table)) {
    const schema = entry.schema;
    assert.equal(schema.type, "object", `${name} schema.type 必须是 object`);
    assert.deepEqual((schema.properties ?? {}) as Record<string, unknown>, {}, `${name} properties 必须为空`);
    assert.equal(schema.additionalProperties, false, `${name} additionalProperties 必须为 false`);
  }
  // 聊天 SSE 仍走独立事件表，不混入通知事件
  const runOp = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/conversation/run"]?.post;
  const runTable = (runOp?.responses as Record<string, Record<string, Record<string, unknown>>>)["200"]?.["x-sse-events"];
  assert.ok(runTable, "聊天 SSE 必须有自己独立的事件表");
  const runNames = Object.keys(runTable as object);
  for (const name of ["ready", "workspace_updated", "actions_updated"]) {
    assert.ok(!runNames.includes(name), `聊天 SSE 事件表不应混入通知事件 ${name}`);
  }
});

test("docs: /openapi.json and /docs are served without auth", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-docs-"));
  t.after(async () => {
    await serviceRef?.then((service) => service.close(), () => undefined);
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
  const body = (await spec.json()) as { info: { title: string }; paths: Record<string, unknown> };
  assert.equal(body.info.title, "pi-muse API");
  assert.ok(Object.keys(body.paths).length >= 20, "spec should cover all endpoints");
  const docs = await service.app.request("/docs");
  assert.equal(docs.status, 200);
  const html = await docs.text();
  assert.match(html, /<title>pi-muse API 文档<\/title>/);
  assert.match(html, /scalar\.js|jsdelivr/);
  const scalar = await service.app.request("/scalar.js");
  assert.equal(scalar.status, 200);
  assert.match(await scalar.text(), /createApiReference/);
  // /api/events 标准 operation.description 在真实 /openapi.json 中也必须覆盖关键 SSE 接入规则（不能只验 200/字段存在）
  const liveOp = (body.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/events"]?.get;
  assert.ok(liveOp, "/openapi.json 必须包含 /api/events GET");
  const liveDesc = String(liveOp.description ?? "");
  assert.match(liveDesc, /Authorization[\s\S]*Bearer/i, "live description 应说明 Authorization: Bearer");
  assert.match(liveDesc, /event:[\s\S]*?data:/i, "live description 应说明 event:/data: 帧格式");
  assert.match(liveDesc, /\{\}/, "live description 应说明 data 载荷为空对象");
  assert.match(liveDesc, /keep-alive/i, "live description 应说明 : keep-alive 心跳");
  assert.match(liveDesc, /Last-Event-ID/, "live description 应说明无 Last-Event-ID / 不重放");
});

test("docs: live GET responses parse against registry schemas (no drift)", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-drift-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  service = await createService(
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
    .filter((e) => !e.sse) // SSE 端点响应是流，不是 JSON schema；safeParse 不适用
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
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const allRoutes = (service.app as unknown as { routes: { method: string; path: string }[] }).routes;
  const served = allRoutes
    .filter((r) => ["GET", "POST", "PUT", "DELETE"].includes(r.method))
    .map((r) => `${r.method.toLowerCase()} ${r.path}`);
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
    assert.ok(
      servedDirectly,
      `注册表登记了 ${key}，但服务端没有对应路由（文档在撒谎）`,
    );
  }
});
