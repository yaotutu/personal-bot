import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import { serviceVersion } from "../../src/bootstrap/service-version.js";
import { healthResponse } from "../../src/http/contracts/responses.js";

/**
 * 文档防漂移契约测试：
 * 1) 生成的 OpenAPI 文档结构完整（每端点有 summary/200 响应 schema）。
 * 2) 免鉴权文档端点（/openapi.json、/docs）真实可达。
 * 3) 无副作用的 GET 端点真实响应能被注册表响应 schema safeParse——
 *    实现改了 schema 没跟（或反之），这里立刻红。
 */

// Activity 的枚举与字段集合是协议契约，测试直接固定预期值；新增/删除状态时必须同步
// features/activities/types.ts、contracts/activities.ts 与本文件，避免生成文档静默漂移。
const ACTIVITY_STATUSES = [
  "running",
  "waiting_approval",
  "waiting_user",
  "awaiting_continuation",
  "completed",
  "failed",
  "stopped",
  "interrupted",
];
const STEP_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "interrupted",
];
const STEP_KINDS = ["execution", "model", "tool", "subagent", "approval", "file_commit"];
const OVERVIEW_FIELDS = [
  "id",
  "threadId",
  "title",
  "goal",
  "deliverable",
  "status",
  "progress",
  "result",
  "runIds",
  "currentRunId",
  "createdAt",
  "updatedAt",
  "finishedAt",
];
const STEP_FIELDS = [
  "id",
  "runId",
  "parentId",
  "kind",
  "title",
  "status",
  "startedAt",
  "finishedAt",
  "result",
];

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

type OpenApiOperation = {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
  responses: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema }>;
      "x-sse-events"?: Record<string, unknown>;
    }
  >;
};

const activityOperations = () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const list = paths["/api/activities"]?.get;
  const detail = paths["/api/activities/{id}"]?.get;
  assert.ok(list, "generated OpenAPI must include GET /api/activities");
  assert.ok(detail, "generated OpenAPI must include GET /api/activities/{id}");
  return { doc, paths, list, detail };
};

const responseSchema = (operation: OpenApiOperation): JsonSchema => {
  const schema = operation.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(schema, "200 response must expose an application/json schema");
  return schema;
};

const queryParameter = (operation: OpenApiOperation, name: string) => {
  const parameter = operation.parameters?.find((item) => item.name === name);
  assert.ok(parameter, `missing query parameter ${name}`);
  return parameter;
};

/**
 * 可空字段在 JSON Schema 中有两种等价写法：`type: ["string","null"]`（zod nullable）
 * 或 `anyOf: [{type:"string"}, {type:"null"}]`（zod optional+nullable 等组合）。
 * 统一归一成排序后的类型集合，测试只关心“确实允许 null”，不锁定生成器的具体写法。
 */
const nullableTypes = (schema: JsonSchema | undefined): string[] => {
  assert.ok(schema, "nullable schema must exist");
  const collect = (item: JsonSchema): string[] =>
    Array.isArray(item.type) ? [...item.type] : item.type ? [item.type] : (item.anyOf ?? []).flatMap(collect);
  return collect(schema).sort();
};

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

test("docs: activity GET endpoints are authenticated read-only JSON operations with no new SSE events", () => {
  const { paths, list, detail } = activityOperations();

  for (const [path, operation] of [
    ["/api/activities", list],
    ["/api/activities/{id}", detail],
  ] as const) {
    // 鉴权写在 operation.security，而不是只靠实现里的中间件；客户端从文档即可知道必须带 Bearer。
    assert.deepEqual(operation.security, [{ bearerAuth: [] }], `${path} must require bearer auth in generated docs`);
    assert.deepEqual(operation.tags, ["活动"], `${path} must stay in the activity tag`);
    assert.ok(operation.summary, `${path} must have a summary`);
    // 两个接口都是普通 JSON GET：200 只有 application/json，不能挂 SSE 事件表。
    assert.deepEqual(Object.keys(operation.responses["200"]?.content ?? {}), ["application/json"], `${path} must be JSON-only`);
    assert.equal(Object.hasOwn(operation.responses["200"] ?? {}, "x-sse-events"), false, `${path} must not expose x-sse-events`);
    assert.match(operation.description ?? "", /不新增 SSE 事件/, `${path} must state that no SSE event is added`);
    assert.match(operation.description ?? "", /只读/, `${path} must be documented as read-only`);
  }

  // 活动域只能有这两个 GET；出现 POST/PUT/DELETE 就说明文档/实现多出了写入口。
  const activityPaths = Object.entries(paths).filter(
    ([path]) => path === "/api/activities" || path.startsWith("/api/activities/"),
  );
  assert.deepEqual(
    Object.fromEntries(activityPaths.map(([path, operations]) => [path, Object.keys(operations).sort()])),
    { "/api/activities": ["get"], "/api/activities/{id}": ["get"] },
    "activity domain must expose GET endpoints only",
  );

  // 本轮不新增活动事件：工作区推送流只承载运行/审批实时状态，不混入 activity 命名空间。
  const workspaceEvents = paths["/api/events"]?.get?.responses["200"]?.["x-sse-events"];
  assert.deepEqual(Object.keys(workspaceEvents ?? {}).sort(), [
    "agent_status_updated",
    "approval_pending",
    "approval_updated",
    "ready",
  ]);
  assert.equal(Object.keys(workspaceEvents ?? {}).some((name) => /activit/i.test(name)), false);
});

test("docs: activity list pins limit range, filter enums, cursor binding and no time-window filtering", () => {
  const { list } = activityOperations();
  const operationDescription = list.description ?? "";
  const parameters = list.parameters ?? [];

  // 参数集合必须精确：多一个未声明过滤（如 since/days）就会让客户端误以为有留存窗口。
  assert.deepEqual(parameters.map((parameter) => parameter.name).sort(), ["cursor", "limit", "status", "threadId"]);
  for (const parameter of parameters) {
    assert.equal(parameter.in, "query", `${parameter.name} must be a query parameter`);
    assert.equal(parameter.required, false, `${parameter.name} must be optional`);
  }

  const limit = queryParameter(list, "limit").schema;
  assert.equal(limit.type, "integer", "limit must be documented as integer, not string");
  assert.equal(limit.default, 20);
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 100);
  assert.match(limit.description ?? "", /默认 20/);
  assert.match(limit.description ?? "", /1–100/);
  assert.match(limit.description ?? "", /400/);

  const cursor = queryParameter(list, "cursor").schema;
  assert.equal(cursor.type, "string");
  assert.equal(cursor.minLength, 1);
  assert.equal(cursor.maxLength, 1024);
  assert.match(cursor.description ?? "", /不透明 base64url/);
  assert.match(cursor.description ?? "", /threadId\/status/);
  assert.match(cursor.description ?? "", /过滤条件与本次不一致返回 400/);

  const threadId = queryParameter(list, "threadId").schema;
  assert.equal(threadId.minLength, 1);
  assert.equal(threadId.maxLength, 64);
  assert.equal(threadId.pattern, "^[a-zA-Z0-9][a-zA-Z0-9_-]*$");
  assert.match(threadId.description ?? "", /只返回该来源会话的活动/);

  const status = queryParameter(list, "status").schema;
  assert.deepEqual(status.enum, ACTIVITY_STATUSES);
  assert.match(status.description ?? "", /只返回该状态的活动/);

  // 行为语义同样属于契约：排序、分页不冻结、严格 400、游标绑定过滤条件。
  for (const rule of [
    /createdAt 降序、同一时间按 id 降序/,
    /limit 默认 20、范围 1–100/,
    /cursor 是上一页返回的不透明 base64url/,
    /绑定生成时的 threadId\/status 过滤条件/,
    /改变过滤后必须从第一页重新开始/,
    /未声明参数、重复参数、非法 limit、非法游标/,
    /一律 400/,
    /分页不冻结/,
    /每次请求读取当前投影/,
    /期间新增活动只可能出现在第一页/,
  ])
    assert.match(operationDescription, rule, `missing list rule in generated docs: ${rule}`);

  // 无 7 天/留存期过滤：参数集合已固定为上面四项，不存在 since/after/before/days 等时间窗口，
  // 且文档明确每次请求读取当前投影，不按留存期裁剪；文档也不得声称存在留存期。
  assert.doesNotMatch(
    parameters.map((parameter) => parameter.name).join(","),
    /since|after|before|days|window|retention/i,
  );
  assert.doesNotMatch(operationDescription, /7\s*天|七天|保留期|retention/i);
  assert.match(operationDescription, /每次请求读取当前投影/);
});

test("docs: activity detail has only the path id parameter and no list-style filters", () => {
  const { detail } = activityOperations();
  assert.deepEqual(
    detail.parameters?.map(({ name, in: location, required }) => ({ name, in: location, required })),
    [{ name: "id", in: "path", required: true }],
    "detail must not accept threadId/status/limit/cursor or any time-window filter",
  );
});

test("docs: activity overview pins eight statuses, explicit registration, delayed completion, resume and deletion semantics", () => {
  const { list } = activityOperations();
  const page = responseSchema(list);
  const overview = page.properties?.activities?.items;
  assert.ok(overview, "list response must embed the activity overview schema");

  // 字段集合与必填项必须精确，nullable 字段也必须显式出现在 required 中。
  assert.deepEqual(Object.keys(overview.properties ?? {}).sort(), [...OVERVIEW_FIELDS].sort());
  assert.deepEqual([...(overview.required ?? [])].sort(), [...OVERVIEW_FIELDS].sort());
  assert.equal(overview.additionalProperties, false, "overview must reject unknown fields");

  const status = overview.properties?.status;
  assert.deepEqual(status?.enum, ACTIVITY_STATUSES, "activity status enum must pin all eight states");
  for (const value of ACTIVITY_STATUSES)
    assert.match(status?.description ?? "", new RegExp(`${value}=`), `status ${value} must be described`);
  // 延迟完成：完成声明不是一轮结束/工具结束的自动结果。
  assert.match(status?.description ?? "", /单次工具结束、子代理返回或一轮回复结束都不会自动置为 completed/);

  const result = overview.properties?.result;
  assert.deepEqual(nullableTypes(result), ["null", "string"]);
  assert.match(result?.description ?? "", /仅在 completed 时非 null/);
  const currentRunId = overview.properties?.currentRunId;
  assert.deepEqual(nullableTypes(currentRunId), ["null", "string"]);
  assert.match(currentRunId?.description ?? "", /无执行中 run 时为 null/);
  const finishedAt = overview.properties?.finishedAt;
  assert.deepEqual(nullableTypes(finishedAt), ["null", "string"]);
  assert.match(finishedAt?.description ?? "", /completed\/failed\/stopped\/interrupted/);
  assert.match(finishedAt?.description ?? "", /未结束时为 null/);
  assert.match(finishedAt?.description ?? "", /崩溃遗留执行无法确定结束时刻时也为 null/);

  for (const field of ["createdAt", "updatedAt"]) {
    const timeSchema: JsonSchema | undefined = overview.properties?.[field];
    assert.equal(timeSchema?.format, "date-time");
    assert.match(timeSchema?.description ?? "", /UTC/);
    assert.match(timeSchema?.description ?? "", /Z 后缀/);
  }

  // 继续原记录：活动 ID 不变，runIds 追加新 run，不新建活动。
  assert.match(overview.properties?.id?.description ?? "", /保持不变，不新建活动/);
  assert.match(overview.properties?.runIds?.description ?? "", /追加新 run，不新建活动/);
  // 删除级联：来源会话删除后活动随之消失。
  assert.match(overview.properties?.threadId?.description ?? "", /随该会话删除而删除/);

  // 显式登记而非每轮自动生成，且概览是只读投影。
  const overviewDescription = overview.description ?? "";
  assert.match(overviewDescription, /显式登记/);
  assert.match(overviewDescription, /不是每轮消息自动创建/);
  assert.match(overviewDescription, /普通交流、解释、澄清和简单查询通常没有记录/);
  assert.match(overviewDescription, /只读投影/);

  const operationDescription = list.description ?? "";
  assert.match(operationDescription, /不是每轮消息自动生成/);
  assert.match(operationDescription, /显式登记/);
  assert.match(operationDescription, /completed 表示主模型已明确声明完成且结果已交付/);
  assert.match(operationDescription, /单次工具结束、子代理返回或一轮回复结束都不会自动完成/);
  assert.match(operationDescription, /awaiting_continuation/);
  assert.match(operationDescription, /需用户明确要求继续/);
  assert.match(operationDescription, /继续同一工作时更新原活动（runIds 追加新 run），不新建活动/);
  assert.match(operationDescription, /活动随来源会话删除而删除/);

  // 列表响应外壳：三字段必填、严格对象，nextCursor 与 hasMore 的互斥语义明确。
  assert.deepEqual(Object.keys(page.properties ?? {}).sort(), ["activities", "hasMore", "nextCursor"]);
  assert.deepEqual([...(page.required ?? [])].sort(), ["activities", "hasMore", "nextCursor"]);
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(nullableTypes(page.properties?.nextCursor), ["null", "string"]);
  assert.match(page.properties?.nextCursor?.description ?? "", /改变过滤后必须从第一页重新开始/);
  assert.match(page.properties?.nextCursor?.description ?? "", /没有更多时为 null/);
  assert.match(page.properties?.hasMore?.description ?? "", /true 时 nextCursor 非 null/);
  assert.match(page.description ?? "", /分页不冻结/);
});

test("docs: activity detail pins overview plus real-step schema, nullable fields and safe projection", () => {
  const { list, detail } = activityOperations();
  const page = responseSchema(list);
  const detailSchema = responseSchema(detail);

  assert.deepEqual(Object.keys(detailSchema.properties ?? {}).sort(), ["activity", "steps"]);
  assert.deepEqual([...(detailSchema.required ?? [])].sort(), ["activity", "steps"]);
  assert.equal(detailSchema.additionalProperties, false);
  // 列表与详情必须复用同一概览 schema，避免两边字段漂移。
  assert.deepEqual(detailSchema.properties?.activity, page.properties?.activities?.items);

  const steps = detailSchema.properties?.steps;
  const step = steps?.items;
  assert.ok(step, "detail response must embed the step schema");
  assert.match(steps?.description ?? "", /按真实执行顺序/);
  assert.match(steps?.description ?? "", /失败、拒绝、取消、过期与中断/);
  assert.deepEqual(Object.keys(step.properties ?? {}).sort(), [...STEP_FIELDS].sort());
  assert.deepEqual([...(step.required ?? [])].sort(), [...STEP_FIELDS].sort());
  assert.equal(step.additionalProperties, false, "step must reject unknown fields");

  const kind = step.properties?.kind;
  assert.deepEqual(kind?.enum, STEP_KINDS);
  for (const value of STEP_KINDS) assert.match(kind?.description ?? "", new RegExp(`${value}=`), `kind ${value} must be described`);
  const stepStatus = step.properties?.status;
  assert.deepEqual(stepStatus?.enum, STEP_STATUSES);
  for (const value of STEP_STATUSES)
    assert.match(stepStatus?.description ?? "", new RegExp(`${value}=`), `step status ${value} must be described`);

  assert.deepEqual(nullableTypes(step.properties?.parentId), ["null", "string"]);
  assert.match(step.properties?.parentId?.description ?? "", /顶层执行步骤为 null/);
  assert.deepEqual(nullableTypes(step.properties?.finishedAt), ["null", "string"]);
  assert.match(step.properties?.finishedAt?.description ?? "", /仍在运行时为 null/);
  assert.match(step.properties?.finishedAt?.description ?? "", /崩溃中断[\s\S]*也为 null/);
  assert.match(step.properties?.finishedAt?.description ?? "", /继续原活动保留旧中断步骤/);
  assert.deepEqual(nullableTypes(step.properties?.result), ["null", "string"]);
  assert.match(step.properties?.result?.description ?? "", /脱敏/);
  assert.match(step.properties?.result?.description ?? "", /不包含模型内部思维、凭据、原始工具载荷/);

  // 步骤是真实执行事件的安全投影，不允许模型事后编造，也不透出原始参数全文。
  assert.match(step.description ?? "", /真实执行事件/);
  assert.match(step.description ?? "", /不允许模型事后编造/);
  assert.match(step.properties?.title?.description ?? "", /不包含原始工具参数全文/);

  const detailDescription = detail.description ?? "";
  assert.match(detailDescription, /activity 概览与 steps 逐步明细/);
  assert.match(detailDescription, /失败、拒绝、取消、过期与中断如实保留/);
  assert.match(detailDescription, /安全投影/);
  assert.match(detailDescription, /活动不存在或来源会话已删除返回 404/);
  assert.match(detailDescription, /不新增 SSE 事件/);
  assert.match(detailSchema.description ?? "", /活动不存在或所属会话已删除时返回 404/);
});

test("docs: activity endpoints enforce auth and list query/cursor behavior matches the generated contract", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-activity-docs-"));
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

  // 未带 token 时两个 GET 都必须 401，不能返回空列表或 404 掩盖鉴权。
  for (const path of ["/api/activities", "/api/activities/missing"]) {
    const response = await service.app.request(path);
    assert.equal(response.status, 401, `${path} must require auth`);
  }
  const wrongToken = await service.app.request("/api/activities", {
    headers: { Authorization: "Bearer wrong-token" },
  });
  assert.equal(wrongToken.status, 401);

  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  const listEndpoint = endpoints.find((endpoint) => endpoint.method === "get" && endpoint.path === "/api/activities")!;

  const ok = await service.app.request("/api/activities", { headers });
  assert.equal(ok.status, 200);
  assert.ok(listEndpoint.response.safeParse(await ok.json()).success, "empty activity list must match response schema");

  // limit 只接受十进制整数 1–100；重复、未知、空值和越界参数都按契约 400。
  for (const query of ["limit=1", "limit=100", "threadId=local-main", "status=completed"]) {
    const response = await service.app.request(`/api/activities?${query}`, { headers });
    assert.equal(response.status, 200, `${query} should be accepted`);
  }
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=abc", "limit=", "limit=1&limit=2", "unknown=1", "threadId=-bad", "status=bogus"]) {
    const response = await service.app.request(`/api/activities?${query}`, { headers });
    assert.equal(response.status, 400, `${query} should be rejected`);
    assert.equal(typeof ((await response.json()) as { error?: unknown }).error, "string");
  }

  // 游标绑定生成时的过滤条件：结构非法、时间非法或与本次 threadId/status 不一致都 400。
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const bound = encode({ createdAt: "2026-10-18T10:00:00.000Z", id: "act-x", threadId: "local-main", status: "completed" });
  const matched = await service.app.request(`/api/activities?threadId=local-main&status=completed&cursor=${bound}`, { headers });
  assert.equal(matched.status, 200, "cursor with matching filters must be accepted");
  for (const query of [
    `threadId=local-main&cursor=${bound}`,
    `cursor=${bound}`,
    `threadId=local-main&status=completed&cursor=not-a-cursor`,
    `threadId=local-main&status=completed&cursor=${encode({ createdAt: "not-a-date", id: "act-x" })}`,
    `threadId=local-main&status=completed&cursor=${encode({ createdAt: "2026-10-18T10:00:00.000Z", id: "act-x", extra: true })}`,
  ]) {
    const response = await service.app.request(`/api/activities?${query}`, { headers });
    assert.equal(response.status, 400, `cursor mismatch must be rejected: ${query}`);
  }

  // 详情不存在或来源会话已删除时 404，不返回空壳记录。
  const missing = await service.app.request("/api/activities/missing", { headers });
  assert.equal(missing.status, 404);
  assert.equal(typeof ((await missing.json()) as { error?: unknown }).error, "string");
});

test("docs: source routing, deletion, safe errors and deployed code identity are explicit", async () => {
  const doc = buildOpenApiDocument();
  const version = await serviceVersion;
  assert.deepEqual(doc["x-service-version"], version);
  assert.equal(doc.info.version, `${version.version}+${version.sourceHash.slice(0, 12)}`);
  assert.match(doc.info.description, new RegExp(version.sourceHash));
  assert.match(doc.info.description, /dirty=true[\s\S]*sourceHash/);
  type Operation = { description: string };
  const description = (path: string, method: string) => (doc.paths[path][method] as Operation).description;
  // 后台任务创建 API 已下线，注册表中只剩监控：仅断言监控的来源/删除约定。
  for (const path of ["/api/agent/monitors"]) {
    const text = description(path, "post");
    assert.match(text, /仅省略/);
    assert.match(text, /新 ID[\s\S]*建立/);
    assert.match(text, /409 THREAD_DELETING/);
    assert.match(text, /不自动重试/);
    assert.match(text, /不[\s\S]*改投主会话/);
    assert.doesNotMatch(text, /通知进主聊天流|结果以 📡 进主聊天流/);
  }
  // 定时任务控制端点必须把 target 收窄到 job，并显式声明 target=task 已下线。
  const controlText = description("/api/agent/tasks/{id}/control", "post");
  assert.match(controlText, /job/);
  assert.match(controlText, /pause/);
  assert.match(controlText, /不中止正在执行的一轮/);
  assert.match(description("/api/conversation", "get"), /已删除[\s\S]*不创建[\s\S]*列表/);
  assert.match(description("/api/conversation", "get"), /模型上下文与历史前脱敏/);
  assert.match(description("/api/conversation/stop", "post"), /不建立/);
  assert.match(description("/api/threads/{threadId}", "delete"), /新同名会话[\s\S]*任务详情/);
  assert.match(description("/api/health", "get"), /commit[\s\S]*dirty[\s\S]*sourceHash/);
});

test("docs: subagent stays inside the parent run and no background task creation remains", () => {
  const doc = buildOpenApiDocument();
  type Operation = { description: string; responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> };
  const chat = doc.paths["/api/conversation/run"].post as Operation;
  for (const rule of [/subagent/, /最多8项/, /最多4个/, /结果后主模型继续/, /写入仍逐次审批/, /绑定父运行/, /取消并等待子会话清理/])
    assert.match(chat.description, rule);
  const snapshot = doc.paths["/api/agent"].get as Operation;
  assert.match(snapshot.description, /kind=job/);
  assert.match(snapshot.description, /不提供 POST \/api\/agent\/tasks/);
  assert.equal(Object.hasOwn(snapshot.responses["200"].content["application/json"].schema.properties, "worker"), false);
  assert.equal(Object.hasOwn(doc.paths, "/api/agent/tasks"), false);
});

test("docs: notification stream documents the client sync protocol and keeps event namespaces separate", () => {
  const document = buildOpenApiDocument();
  type StreamResponse = { description: string; "x-sse-events": Record<string, { schema: unknown }> };
  type Operation = { description: string; security?: unknown[]; responses: Record<string, StreamResponse> };
  const operation = document.paths["/api/events"].get as Operation;
  // 只检查标准描述，不借助 x-sse-events，防止关键接入规则只在机器扩展里存在。
  const description = operation.description;
  for (const rule of [
    /Authorization: Bearer/, /event:[\s\S]*data:/, /UTF-8/, /空行/,
    /ready[\s\S]*agentStatuses[\s\S]*pendingApprovals/,
    /agent_status_updated/, /approval_pending/, /approval_updated/,
    /GET \/api\/agent\/status\?threadId=/, /GET \/api\/activities/,
    /instanceId[\s\S]*revision/, /\(id, revision\)/,
    /30 秒[\s\S]*keep-alive/,
    /不发送事件 id/, /不支持历史重放/, /忽略 Last-Event-ID/,
    /不会取消聊天/, /服务关闭[\s\S]*结束活跃流/,
    /HTTP 401[\s\S]*重新登录/, /HTTP 503/, /HTTP 429/, /不是聊天增量/, /不负责锁屏系统推送/,
    /8MiB/, /12MiB/, /断流/,
    /本轮不发送记忆（memory）变化通知/, /不新增 jobs\/goals/,
  ]) assert.match(description, rule, `Missing client protocol rule in generated docs: ${rule}`);
  // 旧失效通知协议已下线：不能再出现空 data 或旧事件名。
  assert.doesNotMatch(description, /data: \{\}/);
  assert.doesNotMatch(description, /workspace_updated|actions_updated/);
  assert.ok(operation.security?.length);
  assert.deepEqual(Object.keys(operation.responses["200"]["x-sse-events"]).sort(), [
    "agent_status_updated",
    "approval_pending",
    "approval_updated",
    "ready",
  ]);
  const chat = document.paths["/api/conversation/run"].post as Operation;
  assert.ok(Object.hasOwn(chat.responses["200"]["x-sse-events"], "RUN_FINISHED"));
  for (const name of ["ready", "agent_status_updated", "approval_pending", "approval_updated"])
    assert.ok(!Object.hasOwn(chat.responses["200"]["x-sse-events"], name), `聊天 SSE 不应混入通知事件 ${name}`);
});

test("docs: /api/events SSE schema is text/event-stream with four directly usable state events", () => {
  const doc = buildOpenApiDocument();
  const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/events"]?.get;
  assert.ok(op);
  const ok = (op.responses as Record<string, Record<string, unknown>>)["200"];
  // 200 必须声明 text/event-stream 媒体类型
  const content = (ok.content as Record<string, Record<string, unknown>>)["text/event-stream"];
  assert.ok(content, "200 必须声明 text/event-stream content");
  // 事件表恰好四种，且都是可直接展示的状态载荷，不再是空对象失效通知。
  const table = ok["x-sse-events"] as Record<string, { description: string; schema: Record<string, unknown> }>;
  assert.ok(table, "必须声明 x-sse-events 事件契约");
  assert.deepEqual(Object.keys(table).sort(), [
    "agent_status_updated",
    "approval_pending",
    "approval_updated",
    "ready",
  ]);
  for (const [name, entry] of Object.entries(table)) {
    assert.equal(entry.schema.type, "object", `${name} schema.type 必须是 object`);
    assert.notDeepEqual((entry.schema.properties ?? {}) as Record<string, unknown>, {}, `${name} 必须携带真实状态字段`);
    assert.ok(entry.description.length > 0, `${name} 必须有可读描述`);
  }
  // ready 是完整替换集合；增量事件顶层都带 instanceId。
  const ready = table.ready.schema;
  assert.deepEqual(Object.keys(ready.properties as object).sort(), ["agentStatuses", "instanceId", "pendingApprovals", "serverTime"]);
  for (const name of ["agent_status_updated", "approval_pending", "approval_updated"])
    assert.ok(Object.hasOwn(table[name].schema.properties as object, "instanceId"), `${name} 顶层必须带 instanceId`);
  // 审批新增推完整预览；审批终态推轻量投影（不含 title/kind/preview）。
  const pendingProps = Object.keys(table.approval_pending.schema.properties as object);
  assert.ok(pendingProps.includes("preview"));
  const updatedProps = Object.keys(table.approval_updated.schema.properties as object);
  for (const omitted of ["title", "kind", "preview"])
    assert.ok(!updatedProps.includes(omitted), `approval_updated 不应包含 ${omitted}`);
  // 聊天 SSE 仍走独立事件表，不混入通知事件
  const runOp = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/conversation/run"]?.post;
  const runTable = (runOp?.responses as Record<string, Record<string, Record<string, unknown>>>)["200"]?.["x-sse-events"];
  assert.ok(runTable, "聊天 SSE 必须有自己独立的事件表");
  const runNames = Object.keys(runTable as object);
  for (const name of ["ready", "agent_status_updated", "approval_pending", "approval_updated"]) {
    assert.ok(!runNames.includes(name), `聊天 SSE 事件表不应混入通知事件 ${name}`);
  }
});

test("docs: approvals replace legacy actions endpoints and pin strict list/detail/decision semantics", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description?: string;
    security?: unknown[];
    parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
    requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
    responses: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;

  // 旧审批入口必须从注册表与文档中彻底消失，不保留兼容 reader。
  for (const legacy of ["/api/actions/pending", "/api/actions", "/api/actions/{id}", "/api/actions/{id}/decide"])
    assert.equal(Object.hasOwn(paths, legacy), false, `legacy approval path must be gone: ${legacy}`);
  assert.deepEqual(
    Object.keys(paths).filter((path) => path === "/api/approvals" || path.startsWith("/api/approvals/")).sort(),
    ["/api/approvals", "/api/approvals/pending", "/api/approvals/{id}", "/api/approvals/{id}/decision"],
    "approval domain exposes history, supplementary pending, detail and decision",
  );

  const list = paths["/api/approvals"]!.get!;
  assert.deepEqual(list.security, [{ bearerAuth: [] }]);
  assert.deepEqual(list.parameters?.map((parameter) => parameter.name).sort(), ["activityId", "cursor", "limit", "status", "threadId"]);
  for (const parameter of list.parameters ?? []) {
    assert.equal(parameter.in, "query");
    assert.equal(parameter.required, false);
  }
  const limit = queryParameter(list as never, "limit").schema;
  assert.equal(limit.type, "integer");
  assert.equal(limit.default, 20);
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, 100);
  assert.match(limit.description ?? "", /默认 20/);
  assert.match(limit.description ?? "", /1–100/);
  assert.match(queryParameter(list as never, "cursor").schema.description ?? "", /不透明/);
  for (const rule of [/只返回已处理\/失效审批的摘要/, /不含 preview/, /当前 pending 不在此列表/, /resolvedAt/, /分页不冻结/, /长期保留/])
    assert.match(list.description ?? "", rule, `missing approval list rule: ${rule}`);

  // 历史列表摘要省略 preview，但保留身份、revision、终态与时间。
  const page = responseSchema(list as never);
  assert.deepEqual(Object.keys(page.properties ?? {}).sort(), ["approvals", "hasMore", "nextCursor"]);
  assert.deepEqual([...(page.required ?? [])].sort(), ["approvals", "hasMore", "nextCursor"]);
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(nullableTypes(page.properties?.nextCursor), ["null", "string"]);
  const summary = page.properties?.approvals?.items;
  assert.ok(summary);
  assert.equal(Object.hasOwn(summary.properties ?? {}, "preview"), false, "summary must omit preview");
  assert.equal(Object.hasOwn(summary.properties ?? {}, "revision"), true, "summary must keep revision");

  // 详情返回完整视图，字段与必填项精确；preview 全文不截断。
  const detail = paths["/api/approvals/{id}"]!.get!;
  const view = responseSchema(detail as never);
  const viewFields = [
    "activityId", "createdAt", "decidedAt", "execution", "expiresAt", "id", "kind", "preview", "resolvedAt",
    "revision", "runId", "status", "subagentId", "threadId", "title", "toolCallId", "workspaceThreadId",
  ];
  assert.deepEqual(Object.keys(view.properties ?? {}).sort(), viewFields);
  assert.deepEqual([...(view.required ?? [])].sort(), viewFields);
  assert.equal(view.additionalProperties, false);
  assert.deepEqual(view.properties?.status?.enum, ["pending", "approved", "denied", "expired", "cancelled"]);
  assert.match(view.properties?.status?.description ?? "", /expired=超过 expiresAt 自动失效/);
  assert.match(view.properties?.status?.description ?? "", /expired\/cancelled 不是人的决定，decidedAt 保持 null/);
  assert.deepEqual(nullableTypes(view.properties?.decidedAt), ["null", "string"]);
  assert.deepEqual(nullableTypes(view.properties?.resolvedAt), ["null", "string"]);
  const preview = view.properties?.preview;
  assert.deepEqual(Object.keys(preview?.properties ?? {}).sort(), ["after", "before", "beforeExists", "ownerThreadId", "path", "scope"]);
  assert.equal(preview?.additionalProperties, false);
  assert.match(preview?.properties?.before?.description ?? "", /不截断/);
  assert.match(view.description ?? "", /1\.5MB/);
  assert.match(view.description ?? "", /6MB/);
  assert.match(view.description ?? "", /最多 32 项/);
  assert.match(detail.description ?? "", /不存在返回 404/);

  // 决定请求严格只接受 approve/deny；409 携带当前完整审批视图。
  const decision = paths["/api/approvals/{id}/decision"]!.post!;
  assert.equal(decision.requestBody?.required, true);
  const request = decision.requestBody?.content["application/json"]?.schema;
  assert.deepEqual(Object.keys(request?.properties ?? {}), ["decision"]);
  assert.deepEqual(request?.properties?.decision?.enum, ["approve", "deny"]);
  assert.equal(request?.additionalProperties, false);
  const conflict = decision.responses["409"]?.content?.["application/json"]?.schema;
  assert.deepEqual(Object.keys(conflict?.properties ?? {}).sort(), ["approval", "error"]);
  assert.deepEqual([...(conflict?.required ?? [])].sort(), ["approval", "error"]);
  assert.deepEqual(Object.keys(conflict?.properties?.approval?.properties ?? {}).sort(), viewFields);
  assert.ok(Object.hasOwn(conflict?.properties?.approval?.properties ?? {}, "preview"));
  for (const rule of [/幂等返回 200/, /revision 不变/, /不再次执行/, /相反决定[\s\S]*409/, /未知 id 返回 404/, /请求体非法返回 400/, /401/])
    assert.match(decision.description ?? "", rule, `missing decision rule: ${rule}`);
});

test("docs: agent status query is read-only, requires both ids and shares the run status contract", () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    description?: string;
    security?: unknown[];
    parameters?: { name: string; in: string; required: boolean; schema: JsonSchema }[];
    responses: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  };
  const paths = doc.paths as unknown as Record<string, Record<string, Operation>>;
  const operation = paths["/api/agent/status"]!.get!;
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  assert.deepEqual(
    operation.parameters?.map(({ name, in: location, required }) => ({ name, in: location, required })),
    [
      { name: "threadId", in: "query", required: true },
      { name: "runId", in: "query", required: true },
    ],
    "both ids are required query parameters; no undeclared parameters",
  );
  assert.match(operation.description ?? "", /只读/);
  assert.match(operation.description ?? "", /运行结束后的最终终态/);
  assert.match(operation.description ?? "", /普通 chat 可能没有登记 Activity[\s\S]*activityId 为 null/);
  assert.match(operation.description ?? "", /GET \/api\/activities/);
  assert.match(operation.description ?? "", /不建立会话、不创建目录/);
  assert.match(operation.description ?? "", /instanceId/);
  assert.match(operation.description ?? "", /revision/);
  assert.match(operation.description ?? "", /运行不存在或已被清理返回 404/);

  const response = responseSchema(operation as never);
  assert.deepEqual(Object.keys(response.properties ?? {}).sort(), ["instanceId", "status"]);
  assert.deepEqual([...(response.required ?? [])].sort(), ["instanceId", "status"]);
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties?.instanceId?.format, "uuid");
  const status = response.properties?.status;
  assert.equal(status?.additionalProperties, false);
  assert.deepEqual(status?.properties?.status?.enum, ["running", "succeeded", "failed", "cancelled"]);
  assert.deepEqual(nullableTypes(status?.properties?.activityId), ["null", "string"]);
  assert.match(status?.properties?.activityId?.description ?? "", /普通 chat 未登记活动时为 null/);
  // 运行状态只携带审批 ID 引用，不内嵌审批完整视图（完整内容走 approval_pending / 详情接口）。
  assert.equal(status?.properties?.pendingApprovalIds?.items?.type, "string");
  assert.match(status?.properties?.pendingApprovalIds?.description ?? "", /approval_pending/);
  assert.doesNotMatch(JSON.stringify(status), /"preview"/, "run status must not embed approval preview");
  // 运行状态与 ready/agent_status_updated 共用同一 schema，避免三处字段漂移。
  const events = paths["/api/events"]!.get!.responses["200"] as unknown as {
    "x-sse-events": Record<string, { schema: JsonSchema }>;
  };
  assert.deepEqual(events["x-sse-events"]?.ready?.schema.properties?.agentStatuses?.items, status);
  // 增量事件 = 同一运行状态 + 顶层 instanceId；只比较业务字段，避免锁死 $ref/内联写法。
  const updated = events["x-sse-events"]?.agent_status_updated?.schema;
  assert.equal(updated?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(updated?.properties ?? {}).filter((key) => key !== "instanceId").sort(),
    Object.keys(status?.properties ?? {}).sort(),
  );
  assert.equal(updated?.properties?.instanceId?.format, "uuid");
});

test("docs: snapshot points approvals at the SSE stream and keeps the existing read aggregation", () => {
  const doc = buildOpenApiDocument();
  const snapshot = doc.paths["/api/agent"].get as unknown as { description: string };
  assert.match(snapshot.description, /GET \/api\/events/);
  assert.match(snapshot.description, /ready\.pendingApprovals/);
  assert.doesNotMatch(snapshot.description, /GET \/api\/actions\/pending/);
  // 快照读取仍保留既有聚合，不因审批迁移顺带删除。
  const schema = responseSchema(snapshot as never);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["goals", "identity", "memories", "monitors", "tasks"]);
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
  const health = await service.app.request("/api/health");
  const healthBody = healthResponse.parse(await health.json());
  assert.deepEqual(healthBody.serviceVersion, (body as unknown as { "x-service-version": unknown })["x-service-version"]);
  assert.deepEqual(healthBody.serviceVersion, await serviceVersion);
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
  assert.match(liveDesc, /agent_status_updated[\s\S]*approval_pending[\s\S]*approval_updated/i, "live description 应说明四类事件");
  assert.match(liveDesc, /keep-alive/i, "live description 应说明 : keep-alive 心跳");
  assert.match(liveDesc, /Last-Event-ID/, "live description 应说明无 Last-Event-ID / 不重放");
  assert.doesNotMatch(liveDesc, /workspace_updated|actions_updated/, "旧失效通知事件不得保留");
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
  // 无路径参数、无必填查询参数的 GET 才可直接请求；/api/agent/status 需要 threadId+runId，
  // 单独在下方验证其 400/404 语义，不能用一个缺参请求冒充成功响应。
  const cases: { path: string }[] = endpoints
    .filter((e) => e.method === "get" && !e.path.includes(":") || e.path === "/api/health")
    .filter((e) => !e.sse) // SSE 端点响应是流，不是 JSON schema；safeParse 不适用
    .filter((e) => e.path !== "/api/agent/status")
    .map((e) => ({ path: e.path }));
  // conversation 需要查询参数；单独加。
  for (const { path } of cases) {
    const response = await service.app.request(path, { headers });
    assert.equal(response.status, 200, `${path} should be 200`);
    const endpoint = endpoints.find((e) => e.path === path && e.method === "get")!;
    const parsed = endpoint.response.safeParse(await response.json());
    assert.ok(parsed.success, `${path} response drifted from schema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 200)}`);
  }
  // 运行状态查询：缺参 400、未声明参数 400、不存在的 run 404；均不得建立会话或目录。
  for (const query of ["", "?threadId=local-main", "?runId=run-1", "?threadId=local-main&runId=run-1&extra=1"]) {
    const response = await service.app.request(`/api/agent/status${query}`, { headers });
    assert.equal(response.status, 400, `/api/agent/status${query} should be 400`);
  }
  const missingStatus = await service.app.request("/api/agent/status?threadId=local-main&runId=missing-run", { headers });
  assert.equal(missingStatus.status, 404);
  assert.equal(typeof ((await missingStatus.json()) as { error?: unknown }).error, "string");
  const approvalPage = await service.app.request("/api/approvals", { headers });
  assert.equal(approvalPage.status, 200);
  const approvalEndpoint = endpoints.find((e) => e.path === "/api/approvals" && e.method === "get")!;
  assert.ok(approvalEndpoint.response.safeParse(await approvalPage.json()).success, "empty approval page must match schema");
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
