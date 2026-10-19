import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import {
  approval,
  approvalDecisionSchema,
  approvalsQuerySchema,
  pendingApprovalsResponse,
  type ApprovalDto,
  type ApprovalSummaryDto,
  type ApprovalsPageDto,
} from "../../src/http/contracts/approvals.js";
import type { PendingAction } from "../../src/features/actions/types.js";

/**
 * 审批 HTTP + 文档回归。每条用例独占 dataDir；不调模型。
 * 真实路径：以 service.actions.submit / decide / cancel / markExecuting / finishExecution
 * 落入真实 repository；批量终态数据通过独立临时 dataDir 的 actions.json 直接写入，
 * 让 actions.history 与路由都走生产代码，不再复制分页算法。
 */

type Service = Awaited<ReturnType<typeof createService>>;
type Opened = { service: Service; headers: Record<string, string> };

const APPROVALS_ENDPOINTS = [
  "get /api/approvals",
  "get /api/approvals/pending",
  "get /api/approvals/:id",
  "post /api/approvals/:id/decision",
] as const;

const openService = async (t: TestContext): Promise<Opened> => {
  let dataDir: string | undefined;
  let service: Service | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally { if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
  });
  dataDir = await mkdtemp(join(tmpdir(), "pi-muse-approvals-"));
  service = await createService(createConfig({
    runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  return { service, headers: { Authorization: `Bearer ${service.auth.login()}` } };
};

/**
 * 打开 service 前先把合成记录写入 actions.json：readActionsDocument 校验的格式是裸数组。
 * settled 项在 service.actions.cancelPending 启动收尾时不会被改动（只动 pending 与 running），
 * 因此真实 history 会读到我们注入的数据，覆盖分页/过滤/游标路径而不复制算法。
 */
const openServiceWithActions = async (
  t: TestContext,
  items: PendingAction[],
): Promise<Opened> => {
  let dataDir: string | undefined;
  let service: Service | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally { if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
  });
  dataDir = await mkdtemp(join(tmpdir(), "pi-muse-approvals-"));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "actions.json"), JSON.stringify(items, null, 2));
  service = await createService(createConfig({
    runtime: { dataDir, runTimeoutMs: 3000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  return { service, headers: { Authorization: `Bearer ${service.auth.login()}` } };
};

const decodeCursor = (token: string) =>
  JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
    decidedAt: string; id: string; threadId?: string; activityId?: string; status?: string;
  };

const settled = (overrides: {
  id?: string; status?: PendingAction["status"]; title?: string; kind?: PendingAction["kind"];
  decidedAt: string; createdAt?: string; expiresAt?: string;
  threadId?: string; activityId?: string; execution?: PendingAction["execution"];
}): PendingAction => {
  const id = overrides.id ?? randomUUID();
  return {
    id, kind: overrides.kind ?? "file_write",
    title: overrides.title ?? `title-${id.slice(0, 8)}`,
    payload: { path: `${id}.md`, content: `content-${id}` },
    status: overrides.status ?? "approved",
    createdAt: overrides.createdAt ?? overrides.decidedAt,
    expiresAt: overrides.expiresAt ?? "2030-01-01T00:00:00.000Z",
    ...(overrides.threadId !== undefined ? { threadId: overrides.threadId } : {}),
    ...(overrides.activityId !== undefined ? { activityId: overrides.activityId } : {}),
    decidedAt: overrides.decidedAt,
    ...(overrides.execution !== undefined ? { execution: overrides.execution } : {}),
  };
};

test("approvals: four /api/approvals routes require Bearer auth", async (t) => {
  const { service } = await openService(t);
  for (const [path, method] of [
    ["/api/approvals", "GET"],
    ["/api/approvals/pending", "GET"],
    ["/api/approvals/missing-id", "GET"],
    ["/api/approvals/missing-id/decision", "POST"],
  ] as const) {
    const noAuth = await service.app.request(path, { method });
    assert.equal(noAuth.status, 401, `${method} ${path} no token`);
    const badAuth = await service.app.request(path, {
      method, headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(badAuth.status, 401, `${method} ${path} wrong token`);
  }
});

test("approvals: pending returns full payload preview with execution null", async (t) => {
  const { service, headers } = await openService(t);
  const fullContent = "FULL-CONTENT preview not truncated\n".repeat(2000);
  const action = await service.actions.submit(
    "file_write",
    "Write notes preview",
    { path: "notes.md", content: fullContent },
    { threadId: "local-main" },
  );

  const body = pendingApprovalsResponse.parse(
    await (await service.app.request("/api/approvals/pending", { headers })).json(),
  );
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0]!.id, action.id);
  assert.equal(body.approvals[0]!.status, "pending");
  assert.equal(body.approvals[0]!.payload.path, "notes.md");
  assert.equal(body.approvals[0]!.payload.content, fullContent);
  assert.equal(body.approvals[0]!.payload.content.length, fullContent.length);
  assert.equal(body.approvals[0]!.execution, null);
  assert.match(body.approvals[0]!.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);

  await service.actions.decide(action.id, "approve");
  const after = pendingApprovalsResponse.parse(
    await (await service.app.request("/api/approvals/pending", { headers })).json(),
  );
  assert.equal(after.approvals.length, 0);
});

test("approvals: decision same returns 200, preserves decidedAt, no duplicate actions_updated", async (t) => {
  const { service, headers } = await openService(t);
  const events: string[] = [];
  const unsubscribe = service.workspaceEvents.subscribe({
    notify: (event) => events.push(event), close: () => {},
  });
  t.after(unsubscribe);

  const action = await service.actions.submit(
    "file_write", "Idempotent title",
    { path: "idem.md", content: "IDEM-CONTENT" },
    { threadId: "local-main" },
  );
  assert.equal(events.length, 1, "submit must broadcast exactly one actions_updated");

  const decide = await service.app.request(`/api/approvals/${action.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decide.status, 200);
  const decidedRecord = await decide.json();
  assert.equal(decidedRecord.status, "approved");
  const decidedAt1 = decidedRecord.decidedAt;
  assert.ok(decidedAt1, "approve must set decidedAt");
  assert.equal(events.length, 2, "approve must broadcast one actions_updated");

  const second = await service.app.request(`/api/approvals/${action.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.decidedAt, decidedAt1, "decidedAt must not change on idempotent re-decide");
  assert.equal(events.length, 2, "idempotent re-decide must not broadcast actions_updated");

  const history = await (await service.app.request("/api/approvals", { headers })).json() as ApprovalsPageDto;
  assert.equal(history.approvals.length, 1);
  assert.equal(history.approvals[0]!.id, action.id);
  assert.equal(history.approvals[0]!.status, "approved");
  assert.equal(history.approvals[0]!.decidedAt, decidedAt1);
});

test("approvals: decision - reverse, expired, cancelled return 409; missing 404; bad body 400", async (t) => {
  const { service, headers } = await openService(t);

  const reverse = await service.actions.submit("file_write", "Reverse", { path: "r.md", content: "r" });
  await service.actions.decide(reverse.id, "approve");
  const reverseRes = await service.app.request(`/api/approvals/${reverse.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "deny" }),
  });
  assert.equal(reverseRes.status, 409, "approved→deny must 409");
  assert.equal(typeof (await reverseRes.json()).error, "string");

  const expired = await service.actions.submit(
    "file_write", "Expired", { path: "e.md", content: "e" }, { timeoutMs: 1 },
  );
  await sleep(8);
  const expiredRes = await service.app.request(`/api/approvals/${expired.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(expiredRes.status, 409, "expired must 409");

  const cancelled = await service.actions.submit("file_write", "Cancelled", { path: "c.md", content: "c" });
  await service.actions.cancel(cancelled.id);
  const cancelledRes = await service.app.request(`/api/approvals/${cancelled.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "deny" }),
  });
  assert.equal(cancelledRes.status, 409, "cancelled must 409");

  const missing = await service.app.request(`/api/approvals/${randomUUID()}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(missing.status, 404, "unknown id must 404");
  assert.equal(typeof (await missing.json()).error, "string");

  for (const body of [{}, { decision: "maybe" }, { decision: "approve", extra: true }]) {
    const res = await service.app.request(`/api/approvals/${reverse.id}/decision`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `bad body ${JSON.stringify(body)} must 400`);
  }
  const notJson = await service.app.request(`/api/approvals/${reverse.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: "not-json",
  });
  assert.equal(notJson.status, 400, "malformed JSON must 400");
});

test("approvals: detail returns full snapshot that callers cannot mutate, and 404 for missing", async (t) => {
  const { service, headers } = await openService(t);
  const payload = { path: "detail.md", content: "DETAIL-CONTENT " + "x".repeat(5000) };
  const action = await service.actions.submit("file_write", "Detail preview", payload, {
    threadId: "local-main", runId: "run-detail", activityId: "act-detail",
  });
  await service.actions.decide(action.id, "approve");
  await service.actions.markExecuting(action.id);
  await service.actions.finishExecution(action.id, "succeeded", "EXECUTED-OK");

  const detail = approval.parse(
    await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json(),
  );
  assert.equal(detail.status, "approved");
  assert.deepEqual(detail.payload, payload, "payload returned as-is");
  assert.equal(detail.execution?.status, "succeeded");
  assert.equal(detail.execution?.result, "EXECUTED-OK");
  assert.equal(detail.runId, "run-detail");
  assert.equal(detail.activityId, "act-detail");

  // 调用方改返回值不能反向影响服务端
  (detail.payload as Record<string, string>).content = "mutated";
  const refetch = await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json();
  assert.equal(refetch.payload.content, payload.content);

  const missing = await service.app.request(`/api/approvals/${randomUUID()}`, { headers });
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, "string");
});

test("approvals: history exposes settled summaries only, with execution preserved and no payload", async (t) => {
  const items = [
    settled({ id: "a-approved", status: "approved", decidedAt: "2026-10-19T08:00:00.000Z", title: "approved" }),
    settled({ id: "a-denied", status: "denied", decidedAt: "2026-10-19T07:00:00.000Z", title: "denied" }),
    settled({ id: "a-cancelled", status: "cancelled", decidedAt: "2026-10-19T06:00:00.000Z", title: "cancelled" }),
    settled({ id: "a-expired", status: "expired", decidedAt: "2026-10-19T05:00:00.000Z", title: "expired" }),
  ];
  const { service, headers } = await openServiceWithActions(t, items);

  // pending 不应进入历史：通过真实 submit 验证
  await service.actions.submit("file_write", "P", { path: "p.md", content: "p" });

  const history = await (await service.app.request("/api/approvals", { headers })).json() as ApprovalsPageDto;
  assert.equal(history.approvals.length, 4);
  assert.deepEqual(history.approvals.map((it) => it.id), [
    "a-approved", "a-denied", "a-cancelled", "a-expired",
  ]);
  for (const item of history.approvals as ApprovalSummaryDto[]) {
    assert.equal(Object.hasOwn(item, "payload"), false, "summary must omit payload");
    assert.ok(Object.hasOwn(item, "execution"), "summary must expose execution field");
    assert.equal(item.execution, null, "summary without execution reports null, not success");
    assert.ok(typeof item.decidedAt === "string");
  }
  assert.equal(history.hasMore, false);
  assert.equal(history.nextCursor, null);

  // pending 端点仍真实暴露，不受历史文件注入影响
  const pendingBody = pendingApprovalsResponse.parse(
    await (await service.app.request("/api/approvals/pending", { headers })).json(),
  );
  assert.equal(pendingBody.approvals.length, 1, "pending must still surface via /api/approvals/pending");
});

test("approvals: history pagination orders by decidedAt+id desc; full sweep covers all with no overlap or gap", async (t) => {
  const base = new Date("2026-10-19T00:00:00.000Z").getTime();
  const items: PendingAction[] = [];
  // 7 条不同 time；再 2 条相同 time 验证 id 降序 → 共 9 条
  for (let i = 0; i < 7; i++) {
    items.push(settled({
      id: `id-${String(i).padStart(2, "0")}`,
      decidedAt: new Date(base + i * 1000).toISOString(),
      threadId: i % 2 === 0 ? "t-A" : "t-B",
      activityId: i % 3 === 0 ? "act-X" : "act-Y",
      status: i % 4 === 0 ? "denied" : "approved",
    }));
  }
  items.push(settled({ id: "id-tie-A", decidedAt: "2026-10-19T00:00:30.000Z", status: "approved", threadId: "t-C" }));
  items.push(settled({ id: "id-tie-B", decidedAt: "2026-10-19T00:00:30.000Z", status: "approved", threadId: "t-C" }));
  const { service, headers } = await openServiceWithActions(t, items);

  const expectedAll = items
    .slice()
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || b.id.localeCompare(a.id))
    .map((it) => it.id);
  // 9 条按 limit=3 分三页；逐页收集验证无漏无重
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    pages++;
    const url = cursor ? `/api/approvals?limit=3&cursor=${cursor}` : `/api/approvals?limit=3`;
    const body = await (await service.app.request(url, { headers })).json() as ApprovalsPageDto;
    collected.push(...body.approvals.map((it) => it.id));
    if (!body.hasMore) break;
    assert.ok(typeof body.nextCursor === "string", `page ${pages}: nextCursor must be opaque string`);
    cursor = body.nextCursor;
    assert.ok(pages < 10, "pagination must terminate within 10 pages");
  }
  assert.equal(pages, 3, "9 items / limit 3 = exactly 3 pages");
  assert.deepEqual(collected, expectedAll, "full sweep must equal descending order");
  assert.equal(new Set(collected).size, collected.length, "no overlaps across pages");

  // 单页校验（第一页）：前三条按 (decidedAt desc, id desc)，含两个同时间条目
  const first = await (await service.app.request("/api/approvals?limit=3", { headers })).json() as ApprovalsPageDto;
  assert.deepEqual(first.approvals.map((it) => it.id), ["id-tie-B", "id-tie-A", "id-06"]);
  assert.ok(typeof first.nextCursor === "string");
  const decoded = decodeCursor(first.nextCursor!);
  assert.equal(decoded.decidedAt, items.find((it) => it.id === "id-06")!.decidedAt);
  assert.equal(decoded.id, "id-06");

  const denied = await (await service.app.request("/api/approvals?status=denied", { headers })).json() as ApprovalsPageDto;
  assert.ok(denied.approvals.length >= 1);
  for (const it of denied.approvals) assert.equal(it.status, "denied");

  const byThread = await (await service.app.request("/api/approvals?threadId=t-C", { headers })).json() as ApprovalsPageDto;
  assert.deepEqual(byThread.approvals.map((it) => it.id), ["id-tie-B", "id-tie-A"]);

  const byActivity = await (await service.app.request("/api/approvals?activityId=act-X", { headers })).json() as ApprovalsPageDto;
  for (const it of byActivity.approvals) assert.equal(it.activityId, "act-X");

  assert.equal((await service.app.request("/api/approvals?status=pending", { headers })).status, 400);
  assert.equal((await service.app.request("/api/approvals?threadId=-bad-start", { headers })).status, 400);
});

test("approvals: history strict query rejects duplicates, unknowns, illegal limits, padding/base64url mismatches", async (t) => {
  const { service, headers } = await openService(t);
  const cases: Array<[string, string]> = [
    ["duplicate keys", "limit=1&limit=2"],
    ["unknown key", "since=2026-10-19T00:00:00.000Z"],
    ["limit=0", "limit=0"],
    ["limit=101", "limit=101"],
    ["limit empty", "limit="],
    ["limit non-numeric", "limit=abc"],
    ["limit decimal", "limit=1.5"],
    ["negative space", "limit=-1"],
    // base64url 不接受填充符与 base64+ 非 url-safe 字符
    ["cursor with padding", `cursor=${Buffer.from("{}", "utf8").toString("base64")}`],
    ["cursor uses + (base64)", `cursor=${Buffer.from("{}", "utf8").toString("base64").replace(/=+$/, "")}`],
    ["cursor uses / (base64)", `cursor=${Buffer.from('{"a":"b/c"}', "utf8").toString("base64").replace(/=+$/, "")}`],
    ["cursor non-base64", "cursor=@@not-base64@@"],
    ["cursor bad-utf8", `cursor=${Buffer.from([0xff, 0xfe]).toString("base64url")}`],
    ["cursor empty", "cursor="],
  ];
  for (const [label, qs] of cases) {
    const r = await service.app.request(`/api/approvals?${qs}`, { headers });
    assert.equal(r.status, 400, `${label} (${qs}) must 400`);
  }

  // 合法游标内含过滤条件，但本次查询缺过滤 → 400
  const bind = Buffer.from(JSON.stringify({
    decidedAt: "2026-10-19T00:00:00.000Z", id: "x", threadId: "t-A", status: "approved",
  }), "utf8").toString("base64url");
  assert.equal(
    (await service.app.request(`/api/approvals?cursor=${bind}`, { headers })).status,
    400,
  );
  assert.equal(
    (await service.app.request(`/api/approvals?threadId=t-A&status=denied&cursor=${bind}`, { headers })).status,
    400,
  );

  // 游标结构非法：缺字段、额外字段、bad decidedAt
  for (const obj of [
    { id: "x" },
    { decidedAt: "bad-date", id: "x" },
    { decidedAt: "2026-10-19T00:00:00.000Z", id: "x", bogus: true },
  ]) {
    const token = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    assert.equal(
      (await service.app.request(`/api/approvals?cursor=${token}`, { headers })).status,
      400,
    );
  }

  // 合法过滤 + 合法游标 → 200；提供两条候选保证 cursor 之后还能命中
  const matched = [
    settled({ id: "older", decidedAt: "2026-10-18T23:59:58.000Z", status: "approved", threadId: "t-A" }),
    settled({ id: "newer", decidedAt: "2026-10-18T23:59:59.000Z", status: "approved", threadId: "t-A" }),
  ];
  const opened = await openServiceWithActions(t, matched);
  const ok = await opened.service.app.request(
    `/api/approvals?threadId=t-A&status=approved&cursor=${bind}`,
    { headers: opened.headers },
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json() as ApprovalsPageDto;
  assert.deepEqual(okBody.approvals.map((it) => it.id), ["newer", "older"]);
});

test("approvals: execution running and succeeded are reported, but approved without execution stays approved", async (t) => {
  const { service, headers } = await openService(t);
  const a = await service.actions.submit("file_write", "a", { path: "a.md", content: "a" });
  await service.actions.decide(a.id, "approve");

  const justApproved = await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json() as ApprovalDto;
  assert.equal(justApproved.status, "approved");
  assert.equal(justApproved.execution, null, "approved without execution must report null");

  await service.actions.markExecuting(a.id);
  const running = await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json() as ApprovalDto;
  assert.equal(running.status, "approved");
  assert.equal(running.execution?.status, "running");

  await service.actions.finishExecution(a.id, "succeeded", "OK");
  const succeeded = await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json() as ApprovalDto;
  assert.equal(succeeded.status, "approved");
  assert.equal(succeeded.execution?.status, "succeeded");
  assert.ok(succeeded.execution?.finishedAt);
  assert.equal(succeeded.execution?.result, "OK");

  const history = await (await service.app.request("/api/approvals", { headers })).json() as ApprovalsPageDto;
  const fromHistory = history.approvals.find((it) => it.id === a.id)!;
  assert.equal(fromHistory.status, "approved");
  assert.deepEqual(
    (fromHistory as unknown as { execution: { status: string; result: string } }).execution,
    succeeded.execution,
  );
});

test("approvals: legacy /api/actions is not registered and falls back to 501 with valid auth", async (t) => {
  assert.equal(
    endpoints.some((e) => e.path === "/api/actions"),
    false,
    "endpoint registry must not list /api/actions",
  );
  for (const method of ["GET", "POST"] as const) {
    const { service, headers } = await openService(t);
    const init: RequestInit = method === "POST"
      ? { method, headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }
      : { method, headers };
    const res = await service.app.request("/api/actions", init);
    assert.equal(res.status, 501, `${method} /api/actions with valid auth must 501`);
  }
});

test("approvals: buildOpenApiDocument registers the four routes with parameters, schemas and behavior hints", () => {
  const doc = buildOpenApiDocument();
  const paths = doc.paths as Record<string, Record<string, {
    summary?: string; description?: string; security?: unknown[]; tags?: string[];
    parameters?: { name: string; in: string; required: boolean; schema: { type?: string; enum?: string[]; minimum?: number; maximum?: number; default?: unknown; description?: string } }[];
    requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } } } };
    responses?: Record<string, { content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }> }>;
  }>>;

  for (const expected of APPROVALS_ENDPOINTS) {
    const [method, path] = expected.split(" ");
    const openPath = path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const op = paths[openPath]?.[method as "get"];
    assert.ok(op, `${expected} must exist in generated doc`);
    assert.ok(op.summary, `${expected} needs summary`);
    assert.deepEqual(op.tags, ["审批"]);
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.ok(typeof op.description === "string" && op.description.length > 0,
      `${expected} needs non-empty behavior description`);
  }

  const list = paths["/api/approvals"]!.get!;
  assert.deepEqual(
    (list.parameters ?? []).map((p) => p.name).sort(),
    ["activityId", "cursor", "limit", "status", "threadId"],
  );
  const limitSchema = list.parameters!.find((p) => p.name === "limit")!.schema;
  assert.equal(limitSchema.type, "integer");
  assert.equal(limitSchema.default, 20);
  assert.equal(limitSchema.minimum, 1);
  assert.equal(limitSchema.maximum, 100);
  const statusSchema = list.parameters!.find((p) => p.name === "status")!.schema;
  assert.deepEqual(statusSchema.enum, ["approved", "denied", "expired", "cancelled"]);
  assert.match((statusSchema.description ?? "") + (list.description ?? ""), /pending/);

  const listResponse = list.responses!["200"]!.content["application/json"].schema as {
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(
    Object.keys(listResponse.properties ?? {}).sort(),
    ["approvals", "hasMore", "nextCursor"],
  );
  const summaryItem = (listResponse.properties!.approvals as {
    items: { properties: Record<string, { enum?: string[] }>; required: string[] };
  }).items;
  assert.equal(Object.hasOwn(summaryItem.properties, "payload"), false, "summary item must omit payload");
  assert.deepEqual(summaryItem.properties.status.enum, ["approved", "denied", "expired", "cancelled"]);
  assert.ok(summaryItem.required.includes("decidedAt"));

  const cursorDescription = list.parameters!.find((p) => p.name === "cursor")!.schema.description ?? "";
  assert.match(cursorDescription, /不透明 base64url/);
  const listDescription = list.description ?? "";
  for (const rule of [
    /decidedAt 降序、同一时间按 id 降序/,
    /limit 默认 20、范围 1–100/,
    /cursor.*绑定.*过滤条件/,
    /改变过滤后必须从第一页重新开始/,
    /重复参数、非法 limit、非法游标/,
    /一律 400/,
    /approved.*授权一次提交/,
    /execution=null/,
  ]) assert.match(listDescription, rule, `list description missing: ${rule}`);

  const pending = paths["/api/approvals/pending"]!.get!;
  const pendingProperties = (((pending.responses!["200"]!.content["application/json"].schema as {
    properties: { approvals: { items: { properties: Record<string, unknown> } } };
  }).properties.approvals.items)).properties;
  assert.ok(pendingProperties.payload, "pending item must include full payload");

  const detail = paths["/api/approvals/{id}"]!.get!;
  assert.deepEqual(
    detail.parameters?.map(({ name, in: loc }) => ({ name, in: loc })),
    [{ name: "id", in: "path" }],
  );
  assert.match(detail.description ?? "", /不存在返回 404/);
  assert.match(detail.description ?? "", /execution\s*字段始终存在/);

  const decision = paths["/api/approvals/{id}/decision"]!.post!;
  const reqSchema = decision.requestBody!.content["application/json"].schema;
  assert.deepEqual(Object.keys(reqSchema.properties).sort(), ["decision"]);
  assert.deepEqual(reqSchema.required, ["decision"]);
  assert.equal(reqSchema.additionalProperties, false);
  assert.deepEqual((reqSchema.properties as { decision: { enum: string[] } }).decision.enum, ["approve", "deny"]);
  const desc = decision.description ?? "";
  for (const rule of [
    /同一决定重复提交幂等返回 200/,
    /相反决定、已过期或已取消返回 409/,
    /不存在返回 404/,
    /非法或带额外字段返回 400/,
    /有效期由 expiresAt 决定（默认5分钟）/,
  ]) assert.match(desc, rule, `decision description missing: ${rule}`);
});

test("approvals: registry and Hono route set stay in lockstep", async (t) => {
  const { service } = await openService(t);
  const served = new Set(
    (service.app as unknown as { routes: { method: string; path: string }[] }).routes
      .filter((r) => ["GET", "POST"].includes(r.method))
      .map((r) => `${r.method.toLowerCase()} ${r.path}`),
  );
  for (const expected of APPROVALS_ENDPOINTS) {
    assert.ok(served.has(expected), `Hono must serve ${expected}`);
  }
  for (const endpoint of endpoints) {
    if (!endpoint.path.startsWith("/api/approvals")) continue;
    assert.ok(served.has(`${endpoint.method} ${endpoint.path}`),
      `registry entry ${endpoint.method} ${endpoint.path} must be served`);
  }
});

test("approvals: contracts - approvalsQuerySchema and approvalDecisionSchema reject illegal input", () => {
  assert.equal(approvalsQuerySchema.safeParse({}).success, true);
  assert.equal(approvalsQuerySchema.safeParse({ limit: "5" }).success, true);
  assert.equal(approvalsQuerySchema.safeParse({ limit: "101" }).success, false);
  assert.equal(approvalsQuerySchema.safeParse({ since: "2026-10-19T00:00:00.000Z" }).success, false);
  assert.equal(approvalsQuerySchema.safeParse({ threadId: "-bad" }).success, false);

  assert.equal(approvalDecisionSchema.safeParse({ decision: "approve" }).success, true);
  for (const bad of [
    {},
    { decision: "maybe" },
    { decision: "approve", extra: true },
    { decision: 1 },
  ]) {
    assert.equal(approvalDecisionSchema.safeParse(bad).success, false, `${JSON.stringify(bad)} must be invalid`);
  }
});
