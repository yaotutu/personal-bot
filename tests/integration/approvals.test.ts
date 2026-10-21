/**
 * 审批 HTTP + 文档回归。每条用例独占 dataDir；不调模型。
 *
 * 真实路径：以 service.actions.submit / decide / markExecuting / finishExecution
 * 落入真实 repository；批量终态数据通过独立临时 dataDir 的 actions.json 直接写入，
 * 让 actions.history 与路由都走生产代码，不再复制分页算法。
 *
 * merge 语义（已对齐 main 为冲突基准，叠加 execution 与 /pending 补充读取）：
 * - 主同步来源仍是 SSE 的 ready.pendingApprovals + approval_pending；
 *   /api/approvals/pending 仅作为补充只读，不能写入或延长授权。
 * - HTTP 审批响应使用 main 的 preview{scope, ownerThreadId, path, before, after,
 *   beforeExists} 形状，不暴露内部 payload 字段。
 * - /api/approvals 接受 cursor/limit/threadId/activityId/status 过滤参数；
 *   游标 base64url 编码，且过滤绑定（换过滤必须从首屏开始）。
 * - /api/approvals/pending 已决定/已执行审批不再出现在 pending 集合。
 * - execution 字段始终存在；未观察到执行时为 null，与 status 平行。
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import {
  approvalDecisionRequest,
  approvalListQuery,
  approvalPage,
  approvalSummary,
  approvalView,
  pendingApprovalsResponse,
  type ApprovalPageDto,
  type ApprovalSummaryDto,
  type ApprovalViewDto,
} from "../../src/http/contracts/approvals.js";
import type { PendingAction } from "../../src/features/actions/types.js";

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
    resolvedAt: string; id: string; threadId?: string; activityId?: string; status?: string;
  };

/**
 * 由 caller 注入的合成审批记录；不要写 services.submit，因为那会让 revision / decidedAt
 * 由服务端生成，难以制造确定的 resolvedAt 排序样本。
 */
const settled = (overrides: {
  id?: string; status?: PendingAction["status"]; title?: string; kind?: PendingAction["kind"];
  decidedAt: string; createdAt?: string; expiresAt?: string;
  threadId?: string; activityId?: string; execution?: PendingAction["execution"];
}): PendingAction => {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    kind: overrides.kind ?? "file_write",
    title: overrides.title ?? `title-${id.slice(0, 8)}`,
    payload: { path: `${id}.md`, content: `content-${id}` },
    status: overrides.status ?? "approved",
    revision: overrides.status === "approved" && overrides.execution ? 3 : 2,
    createdAt: overrides.createdAt ?? overrides.decidedAt,
    expiresAt: overrides.expiresAt ?? "2030-01-01T00:00:00.000Z",
    resolvedAt: overrides.decidedAt,
    // 只有 approved/denied 才允许 decidedAt；其他终态保持 null。
    decidedAt: overrides.status === "denied" || overrides.status === "approved" ? overrides.decidedAt : null,
    threadId: overrides.threadId ?? null,
    runId: null,
    toolCallId: null,
    subagentId: null,
    workspaceThreadId: null,
    activityId: overrides.activityId ?? null,
    ...(overrides.execution ? { execution: overrides.execution } : {}),
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

test("approvals: /pending returns full preview shape, not raw payload, and disappears after decide", async (t) => {
  const { service, headers } = await openService(t);
  const fullContent = "FULL-CONTENT preview not truncated\n".repeat(2000);
  const action = await service.actions.submit(
    "file_write",
    "Write notes preview",
    {
      path: "notes.md",
      content: fullContent,
      originalContent: "OLD-CONTENT",
      beforeExists: "true",
      baseVersion: "v1",
    },
    { threadId: "local-main", workspaceThreadId: "local-main" },
  );

  const raw = await (await service.app.request("/api/approvals/pending", { headers })).json();
  const body = pendingApprovalsResponse.parse(raw);

  assert.equal(body.approvals.length, 1);
  const record = body.approvals[0] as ApprovalViewDto;
  assert.equal(record.id, action.id);
  assert.equal(record.status, "pending");
  assert.equal(record.resolvedAt, null);
  assert.equal(record.decidedAt, null);
  // HTTP 用 main 的 preview 形状：before/after/path/beforeExists/scope/ownerThreadId
  // 内部 payload 不可见。
  assert.equal(typeof record.preview, "object");
  assert.equal(record.preview.path, "notes.md");
  assert.equal(record.preview.before, "OLD-CONTENT");
  assert.equal(record.preview.after, fullContent);
  assert.equal(record.preview.after.length, fullContent.length);
  assert.equal(record.preview.beforeExists, true);
  assert.equal(record.preview.scope, "space");
  assert.equal(record.preview.ownerThreadId, "local-main");
  assert.equal(Object.hasOwn(record, "payload"), false, "/pending must not expose raw payload");
  // execution 始终存在；pending 时为 null。
  assert.equal(record.execution, null);
  assert.match(record.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);

  await service.actions.decide(action.id, "approve");
  const after = pendingApprovalsResponse.parse(
    await (await service.app.request("/api/approvals/pending", { headers })).json(),
  );
  assert.equal(after.approvals.length, 0, "decided items must leave /pending");
});

test("approvals: decision same returns 200, preserves decidedAt, no duplicate actions_updated notification", async (t) => {
  const { service, headers } = await openService(t);
  const events: unknown[] = [];
  const unsubscribe = service.workspaceEvents.subscribe({
    notify: (event) => events.push(event), close: () => {},
  });
  t.after(unsubscribe);

  const action = await service.actions.submit(
    "file_write", "Idempotent title",
    { path: "idem.md", content: "IDEM-CONTENT", originalContent: "" },
    { threadId: "local-main", workspaceThreadId: "local-main" },
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

  // 决定端通过 GET /api/approvals/:id 返回的详情与决定结果一致。
  const detail = approvalView.parse(
    await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json(),
  );
  assert.equal(detail.id, action.id);
  assert.equal(detail.status, "approved");
  assert.equal(detail.decidedAt, decidedAt1);
  assert.equal(detail.preview.path, "idem.md");
  assert.equal(detail.preview.after, "IDEM-CONTENT");
});

test("approvals: decision - reverse, expired, cancelled return 409; missing 404; bad body 400", async (t) => {
  const { service, headers } = await openService(t);

  const reverse = await service.actions.submit("file_write", "Reverse", {
    path: "r.md", content: "r", originalContent: "",
  });
  await service.actions.decide(reverse.id, "approve");
  const reverseRes = await service.app.request(`/api/approvals/${reverse.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "deny" }),
  });
  assert.equal(reverseRes.status, 409, "approved→deny must 409");
  assert.equal(typeof (await reverseRes.json()).error, "string");

  const expired = await service.actions.submit(
    "file_write", "Expired", { path: "e.md", content: "e", originalContent: "" }, { timeoutMs: 1 },
  );
  await sleep(8);
  const expiredRes = await service.app.request(`/api/approvals/${expired.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(expiredRes.status, 409, "expired must 409");

  const cancelled = await service.actions.submit(
    "file_write", "Cancelled", { path: "c.md", content: "c", originalContent: "" },
  );
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

test("approvals: detail returns full preview with execution appearing only after markExecuting, immutable to callers", async (t) => {
  const { service, headers } = await openService(t);
  const action = await service.actions.submit(
    "file_write", "Detail preview",
    { path: "detail.md", content: "DETAIL-CONTENT " + "x".repeat(5000), originalContent: "" },
    { threadId: "local-main", runId: "run-detail", activityId: "act-detail" },
  );
  await service.actions.decide(action.id, "approve");

  // execute 前 execution 必须为 null，且 HTTP 不暴露 payload 字段。
  const preExec = approvalView.parse(
    await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json(),
  );
  assert.equal(preExec.status, "approved");
  assert.equal(preExec.execution, null, "execution only after markExecuting");
  assert.equal(preExec.preview.path, "detail.md");
  assert.equal(preExec.preview.after, "DETAIL-CONTENT " + "x".repeat(5000));
  assert.equal(preExec.runId, "run-detail");
  assert.equal(preExec.activityId, "act-detail");
  assert.equal(Object.hasOwn(preExec, "payload"), false, "detail must not expose payload");

  await service.actions.markExecuting(action.id);
  await service.actions.finishExecution(action.id, "succeeded", "EXECUTED-OK");

  const post = approvalView.parse(
    await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json(),
  );
  assert.equal(post.status, "approved");
  assert.equal(post.execution?.status, "succeeded");
  assert.equal(post.execution?.result, "EXECUTED-OK");
  assert.ok(post.execution?.finishedAt);

  // 调用方改返回值不能反向影响服务端。
  (post.preview as unknown as { after: string }).after = "mutated";
  const refetch = await (await service.app.request(`/api/approvals/${action.id}`, { headers })).json();
  assert.equal(refetch.preview.after, "DETAIL-CONTENT " + "x".repeat(5000));

  const missing = await service.app.request(`/api/approvals/${randomUUID()}`, { headers });
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, "string");
});

test("approvals: /api/approvals exposes settled summaries only, omits preview, includes execution=null fields", async (t) => {
  const items = [
    settled({ id: "a-approved", status: "approved", decidedAt: "2026-10-19T08:00:00.000Z", title: "approved" }),
    settled({ id: "a-denied", status: "denied", decidedAt: "2026-10-19T07:00:00.000Z", title: "denied" }),
    settled({ id: "a-cancelled", status: "cancelled", decidedAt: "2026-10-19T06:00:00.000Z", title: "cancelled" }),
    settled({ id: "a-expired", status: "expired", decidedAt: "2026-10-19T05:00:00.000Z", title: "expired" }),
  ];
  const { service, headers } = await openServiceWithActions(t, items);

  // 现场新提交一条 pending：它不能进入历史，但能进入 /pending。
  await service.actions.submit(
    "file_write", "P", { path: "p.md", content: "p", originalContent: "" },
  );

  const history = approvalPage.parse(
    await (await service.app.request("/api/approvals", { headers })).json(),
  );
  assert.equal(history.approvals.length, 4);
  assert.deepEqual(history.approvals.map((it) => it.id), [
    "a-approved", "a-denied", "a-cancelled", "a-expired",
  ]);
  for (const item of history.approvals as ApprovalSummaryDto[]) {
    assert.equal(Object.hasOwn(item, "preview"), false, "summary must omit preview");
    assert.equal(Object.hasOwn(item, "payload"), false, "summary must omit payload");
    assert.equal(Object.hasOwn(item, "execution"), true, "summary must expose execution field");
    assert.equal(item.execution, null, "summary without execution reports null, not success");
    // approved/denied 必带 decidedAt；expired/cancelled 为 null。
    if (item.status === "approved" || item.status === "denied") {
      assert.ok(typeof item.decidedAt === "string");
    } else {
      assert.equal(item.decidedAt, null);
    }
  }
  assert.equal(history.hasMore, false);
  assert.equal(history.nextCursor, null);

  // pending 端点仍真实暴露；不受历史文件注入影响。
  const pendingBody = pendingApprovalsResponse.parse(
    await (await service.app.request("/api/approvals/pending", { headers })).json(),
  );
  assert.equal(pendingBody.approvals.length, 1, "/pending must still surface live pending");
});

test("approvals: /api/approvals orders resolvedAt desc + id desc; full sweep covers all with no overlap or gap", async (t) => {
  const base = new Date("2026-10-19T00:00:00.000Z").getTime();
  const items: PendingAction[] = [];
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

  // 按 resolvedAt desc + id desc 排序：自然时间大的更靠前；相同时 id 大的靠前。
  const expectedAll = items
    .slice()
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "") || b.id.localeCompare(a.id))
    .map((it) => it.id);
  const collected: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    pages++;
    const url = cursor ? `/api/approvals?limit=3&cursor=${cursor}` : `/api/approvals?limit=3`;
    const body = approvalPage.parse(
      await (await service.app.request(url, { headers })).json(),
    );
    collected.push(...body.approvals.map((it) => it.id));
    if (!body.hasMore) break;
    assert.ok(typeof body.nextCursor === "string", `page ${pages}: nextCursor must be opaque string`);
    cursor = body.nextCursor;
    assert.ok(pages < 10, "pagination must terminate within 10 pages");
  }
  assert.equal(pages, 3, "9 items / limit 3 = exactly 3 pages");
  assert.deepEqual(collected, expectedAll, "full sweep must equal descending order");
  assert.equal(new Set(collected).size, collected.length, "no overlaps across pages");

  // 首页校验：id-tie-B (id-tie-A) 之前两条同时间按 id desc；接下来是 06。
  const first = approvalPage.parse(
    await (await service.app.request("/api/approvals?limit=3", { headers })).json(),
  );
  assert.deepEqual(first.approvals.map((it) => it.id), ["id-tie-B", "id-tie-A", "id-06"]);
  assert.ok(typeof first.nextCursor === "string");
  const decoded = decodeCursor(first.nextCursor!);
  const last = items.find((it) => it.id === "id-06")!;
  assert.equal(decoded.resolvedAt, last.resolvedAt);
  assert.equal(decoded.id, "id-06");

  // 过滤在分页前应用；status 过滤、threadId 过滤、activityId 过滤必须保持顺序与时间不变。
  const denied = approvalPage.parse(
    await (await service.app.request("/api/approvals?status=denied", { headers })).json(),
  );
  assert.ok(denied.approvals.length >= 1);
  for (const it of denied.approvals) assert.equal(it.status, "denied");

  const byThread = approvalPage.parse(
    await (await service.app.request("/api/approvals?threadId=t-C", { headers })).json(),
  );
  assert.deepEqual(byThread.approvals.map((it) => it.id), ["id-tie-B", "id-tie-A"]);

  const byActivity = approvalPage.parse(
    await (await service.app.request("/api/approvals?activityId=act-X", { headers })).json(),
  );
  for (const it of byActivity.approvals) assert.equal(it.activityId, "act-X");

  // pending 不是合法 status 过滤值：必须 400。
  assert.equal((await service.app.request("/api/approvals?status=pending", { headers })).status, 400);
  // 不合法 threadId 格式必须 400。
  assert.equal((await service.app.request("/api/approvals?threadId=-bad-start", { headers })).status, 400);
});

test("approvals: /api/approvals strict query rejects duplicates, unknowns, illegal limits, padding/base64url mismatches", async (t) => {
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
    // base64url 不接受 padding、非 url-safe 字符、非 base64 输入。
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

  // 游标携带 filter binding：本次查询缺过滤或过滤条件不一致 → 400。
  const bind = Buffer.from(JSON.stringify({
    resolvedAt: "2026-10-19T00:00:00.000Z", id: "x", threadId: "t-A", status: "approved",
  }), "utf8").toString("base64url");
  assert.equal((await service.app.request(`/api/approvals?cursor=${bind}`, { headers })).status, 400);
  assert.equal(
    (await service.app.request(`/api/approvals?threadId=t-A&status=denied&cursor=${bind}`, { headers })).status,
    400,
  );

  // 游标结构非法：缺字段、额外字段、bad resolvedAt。
  for (const obj of [
    { id: "x" },
    { resolvedAt: "bad-date", id: "x" },
    { resolvedAt: "2026-10-19T00:00:00.000Z", id: "x", bogus: true },
  ]) {
    const token = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    assert.equal((await service.app.request(`/api/approvals?cursor=${token}`, { headers })).status, 400);
  }

  // 合法过滤 + 合法游标：完整匹配；服务能继续翻页。
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
  const okBody = approvalPage.parse(await ok.json());
  assert.deepEqual(okBody.approvals.map((it) => it.id), ["newer", "older"]);
});

test("approvals: execution running and succeeded are reported, but approved without execution stays approved", async (t) => {
  const { service, headers } = await openService(t);
  const a = await service.actions.submit(
    "file_write", "a", { path: "a.md", content: "a", originalContent: "" },
  );
  await service.actions.decide(a.id, "approve");

  // 仅批准：execution 仍为 null，status 保持 approved。
  const justApproved = approvalView.parse(
    await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json(),
  );
  assert.equal(justApproved.status, "approved");
  assert.equal(justApproved.execution, null, "approved without execution must report null");

  await service.actions.markExecuting(a.id);
  const running = approvalView.parse(
    await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json(),
  );
  assert.equal(running.status, "approved");
  assert.equal(running.execution?.status, "running");
  assert.equal(running.execution?.finishedAt, null);

  await service.actions.finishExecution(a.id, "succeeded", "OK");
  const succeeded = approvalView.parse(
    await (await service.app.request(`/api/approvals/${a.id}`, { headers })).json(),
  );
  assert.equal(succeeded.status, "approved");
  assert.equal(succeeded.execution?.status, "succeeded");
  assert.ok(succeeded.execution?.finishedAt);
  assert.equal(succeeded.execution?.result, "OK");

  // 历史摘要里 execution 字段始终存在；未观察到执行时为 null。
  const history = approvalPage.parse(
    await (await service.app.request("/api/approvals", { headers })).json(),
  );
  const fromHistory = history.approvals.find((it) => it.id === a.id)! as ApprovalSummaryDto;
  assert.equal(fromHistory.status, "approved");
  assert.equal(fromHistory.execution?.status, "succeeded");
  assert.equal(fromHistory.execution?.result, "OK");
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
    ["activityId", "cursor", "limit", "spaceId", "status", "threadId"],
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
  assert.equal(Object.hasOwn(summaryItem.properties, "preview"), false, "summary item must omit preview");
  assert.equal(Object.hasOwn(summaryItem.properties, "payload"), false, "summary item must omit payload");
  assert.deepEqual(summaryItem.properties.status.enum, ["approved", "denied", "expired", "cancelled"]);
  assert.ok(summaryItem.required.includes("decidedAt"));

  const cursorDescription = list.parameters!.find((p) => p.name === "cursor")!.schema.description ?? "";
  assert.match(cursorDescription, /不透明 base64url/);
  const listDescription = list.description ?? "";
  for (const rule of [
    /resolvedAt[\s\S]*降序[\s\S]*id 降序/,
    /limit 默认 20、范围 1–100/,
    /cursor.*绑定.*过滤/,
    /改变过滤后必须从第一页重新开始/,
    /重复参数/,
    /一律 400/,
    /execution=null/,
  ]) assert.match(listDescription, rule, `list description missing: ${rule}`);

  // /pending：每条记录的 preview 字段必须存在，不暴露 payload。
  const pending = paths["/api/approvals/pending"]!.get!;
  const pendingProperties = (((pending.responses!["200"]!.content["application/json"].schema as {
    properties: { approvals: { items: { properties: Record<string, unknown> } } };
  }).properties.approvals.items)).properties;
  assert.ok(pendingProperties.preview, "pending item must include preview");
  assert.equal(pendingProperties.payload, undefined, "pending item must not expose payload");

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
    /相同.*重复提交.*幂等.*200/,
    /相反.*expired.*cancelled.*409/,
    /未知.*id.*404/,
    /请求体.*非法.*400/,
    /有效期.*expiresAt/,
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

test("approvals: contracts - approvalListQuery and approvalDecisionRequest reject illegal input", () => {
  // approvalListQuery 必须 strict：未声明字段 → false；limit 字符串→数字；范围 1-100；其他过滤必合法。
  assert.equal(approvalListQuery.safeParse({}).success, true);
  assert.equal(approvalListQuery.safeParse({ limit: "5" }).success, true);
  assert.equal(approvalListQuery.safeParse({ limit: "101" }).success, false);
  assert.equal(approvalListQuery.safeParse({ limit: 0 }).success, false);
  assert.equal(approvalListQuery.safeParse({ since: "2026-10-19T00:00:00.000Z" }).success, false);
  assert.equal(approvalListQuery.safeParse({ threadId: "-bad" }).success, false);
  assert.equal(approvalListQuery.safeParse({ status: "pending" }).success, false);
  assert.equal(approvalListQuery.safeParse({ status: "approved" }).success, true);
  assert.equal(approvalListQuery.safeParse({ activityId: "" }).success, false);

  assert.equal(approvalDecisionRequest.safeParse({ decision: "approve" }).success, true);
  for (const bad of [
    {},
    { decision: "maybe" },
    { decision: "approve", extra: true },
    { decision: 1 },
  ]) {
    assert.equal(approvalDecisionRequest.safeParse(bad).success, false, `${JSON.stringify(bad)} must be invalid`);
  }
});

// 校验在 strict mode 下 approvalSummary / approvalView / pendingApprovalsResponse / approvalPage 解析器的
// 关键字段：preview 必须存在、execution 必须存在；allowextras 严格不允许多余字段。
test("approvals: zod schemas confirm wire shapes", () => {
  const pendingItem = {
    id: "id",
    revision: 1,
    spaceId: null,
    threadId: null,
    runId: null,
    toolCallId: null,
    subagentId: null,
    workspaceSpaceId: null,
    workspaceThreadId: null,
    activityId: null,
    kind: "file_write" as const,
    title: "t",
    status: "pending" as const,
    preview: {
      scope: "space" as const,
      ownerSpaceId: "owner",
      ownerThreadId: "owner",
      path: "p",
      before: "",
      after: "a",
      beforeExists: false,
    },
    execution: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-06T00:00:00.000Z",
    resolvedAt: null,
    decidedAt: null,
  };
  approvalView.parse(pendingItem);

  const summaryItem = {
    ...pendingItem,
    status: "approved" as const,
    revision: 2,
    resolvedAt: "2026-01-02T00:00:00.000Z",
    decidedAt: "2026-01-02T00:00:00.000Z",
    execution: { status: "succeeded" as const, startedAt: "2026-01-02T00:00:01.000Z", finishedAt: "2026-01-02T00:00:02.000Z", result: "ok" },
  };
  // approvalSummary 不含 preview，但允许 execution；status 必须为终态之一。
  const { preview: _preview, ...withoutPreview } = summaryItem;
  approvalSummary.parse(withoutPreview);

  // pending status 不会进入 approvalSummary（status enum 不含 pending）。
  assert.equal(approvalSummary.safeParse({ ...withoutPreview, status: "pending" }).success, false);

  // append 不允许（strict 模式）。
  assert.equal(approvalView.safeParse({ ...pendingItem, leak: true }).success, false);
});
