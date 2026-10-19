import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { agentSnapshot, taskDetail, taskView } from "../../src/http/contracts/responses.js";
import { approvalSummary, approvalView } from "../../src/http/contracts/approvals.js";
import { presentJob, presentJobDetail } from "../../src/http/job-presenters.js";
import { createMonitorSchema, taskControlSchema } from "../../src/http/contracts/rest.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import type { AgentSnapshotDto } from "../../src/http/contracts/responses.js";
import type { Job } from "../../src/features/jobs/types.js";

const job: Job = {
  id: "scheduled", prompt: "Reminder", daily: false, enabled: true,
  at: "2030-01-01T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  originThreadId: "local-main",
};

// 先经过 JSON 编解码，覆盖 undefined 字段在真实 HTTP 响应中被省略的行为。
const wireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("task control only accepts target=job and rejects target=task so legacy payloads 400", () => {
  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    assert.equal(taskControlSchema.safeParse({ target: "job", action }).success, true);
    // target=task 是历史后台任务调度，已下线，统一 400。
    assert.equal(taskControlSchema.safeParse({ target: "task", action }).success, false);
    // 缺 target 也是 400，避免收不到字段的客户端误入路由。
    assert.equal(taskControlSchema.safeParse({ action }).success, false);
  }
});

test("creation contracts for remaining domains preserve optional source threads and reject unsafe IDs", () => {
  for (const [schema, input] of [
    [createMonitorSchema, { url: "https://example.com", condition: "change" }],
  ] as const) {
    assert.equal(schema.safeParse(input).success, true);
    for (const originThreadId of ["local-main", "trip_2026", "A".repeat(64)]) {
      const parsed = schema.parse({ ...input, originThreadId });
      assert.equal(parsed.originThreadId, originThreadId);
    }
    for (const originThreadId of ["", "../escape", "/absolute", "-leading", "a b", "会话", "A".repeat(65), null, 42]) {
      assert.equal(schema.safeParse({ ...input, originThreadId }).success, false);
    }
  }
});

test("POST /api/agent/tasks is not registered in the contract and the unmounted API falls back to 501", async (t) => {
  // 契约源不再包含后台任务创建端点，避免文档/客户端误以为仍可创建。
  assert.equal(
    endpoints.some((endpoint) => endpoint.method === "post" && endpoint.path === "/api/agent/tasks"),
    false,
    "POST /api/agent/tasks 必须从端点注册表移除（后台任务 API 已下线）",
  );
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-tasks-route-501-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  service = await createService(createConfig({
    runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  const headers = {
    Authorization: `Bearer ${service.auth.login()}`,
    "Content-Type": "application/json",
  };
  // 该路径没有挂载任何 Hono handler，由 app.all("/api/*", ...) 兜底返回 501。
  const response = await service.app.request("/api/agent/tasks", {
    method: "POST", headers, body: JSON.stringify({ prompt: "late" }),
  });
  assert.equal(response.status, 501);
});

test("response contracts cover job presenter and wrapped detail without dropping fields", () => {
  const dto = presentJob(job);
  const body = wireValue(dto);
  assert.deepEqual(taskView.strict().parse(body), body);
  const detail = presentJobDetail(job);
  const detailBody = wireValue(detail);
  assert.deepEqual(taskDetail.strict().parse(detailBody), detailBody);
  assert.equal(taskDetail.safeParse({ task: detail.task, events: detail.events }).success, true);
  assert.equal(taskDetail.safeParse({ ...detail.task, events: detail.events }).success, false);
  // kind 收敛后所有合法 taskView.kind === "job"，旧 task 别名应被拒绝。
  assert.equal(taskView.safeParse({ ...dto, kind: "task" }).success, false);
  assert.equal(taskView.safeParse({ ...dto, kind: "document" }).success, false);
});

test("approval contract preserves complete text, cancellation and optional execution context", () => {
  const preview = {
    scope: "thread" as const,
    ownerThreadId: "local-main",
    path: "notes.md",
    before: "旧内容",
    after: "完整待审批文本\n".repeat(200),
    beforeExists: true,
  };
  const legacy = {
    id: "approval",
    revision: 1,
    threadId: "local-main",
    runId: "run-1",
    toolCallId: "tc-1",
    subagentId: null,
    workspaceThreadId: "local-main",
    activityId: null,
    kind: "file_write" as const,
    title: "Write notes",
    status: "pending" as const,
    preview,
    execution: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    resolvedAt: null,
    decidedAt: null,
  };
  for (const status of ["pending", "approved", "denied", "expired", "cancelled"] as const) {
    const action = {
      ...legacy,
      status,
      revision: status === "pending" ? 1 : 2,
      resolvedAt: status === "pending" ? null : "2026-01-01T00:01:00.000Z",
      decidedAt: status === "approved" || status === "denied" ? "2026-01-01T00:01:00.000Z" : null,
    };
    assert.deepEqual(approvalView.strict().parse(action), action);
    // 列表摘要与完整视图同源，只省略 preview；其余字段（含 revision/终态时间）保持一致。
    const { preview: _preview, ...summary } = action;
    if (status === "pending") assert.equal(approvalSummary.safeParse(summary).success, false);
    else assert.deepEqual(approvalSummary.strict().parse(summary), summary);
  }
  assert.equal(approvalView.safeParse({ ...legacy, status: "unknown" }).success, false);
  // scope=shared 时 ownerThreadId 必须为 null；nullable 关联字段不能用空串伪装。
  const shared = { ...legacy, preview: { ...preview, scope: "shared" as const, ownerThreadId: null }, workspaceThreadId: null };
  assert.deepEqual(approvalView.strict().parse(shared), shared);
  assert.equal(approvalView.safeParse({ ...legacy, revision: 0 }).success, false);
  assert.equal(approvalView.safeParse({ ...legacy, preview: { ...preview, ownerThreadId: "" } }).success, false);
});

test("HTTP snapshot matches contract with job-only tasks and no worker projection", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-response-contract-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  // 无模型配置，不发模型请求；只读快照不启动任务。所有文件均留在隔离目录。
  service = await createService(createConfig({
    runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  t.mock.method(service.jobs, "list", async () => [job]);
  // 审批已不在 /api/agent 快照中；仍保留一条完整审批记录，证明快照不混入审批字段。
  const approval = {
    id: "approval", revision: 2, kind: "file_write" as const, title: "Write notes",
    threadId: "local-main", runId: "run-1", toolCallId: null, subagentId: null,
    workspaceThreadId: "local-main", activityId: null,
    preview: { scope: "thread" as const, ownerThreadId: "local-main", path: "notes.md",
      before: "", after: "完整待审批文本\n".repeat(2000), beforeExists: false },
    status: "cancelled" as const, createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    resolvedAt: "2026-01-01T00:01:00.000Z", decidedAt: null,
  };
  t.mock.method(service.actions, "history", async () => [approval]);
  const monitor = {
    id: "monitor", title: "Page", url: "https://example.com", condition: "change" as const,
    intervalMinutes: 30, status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", checks: 1,
    originThreadId: "trip-2026", pendingNotification: { id: "internal", summary: "awaiting delivery" },
  };
  t.mock.method(service.monitors, "list", async () => [monitor]);
  const goal = await service.goals.create({ title: "Learn", milestones: ["Read"] });
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  const response = await service.app.request("/api/agent", { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  // 使用 Web 同一导入路径，编译期检查完整集合类型；无需前端 casts 就能访问各域字段。
  const snapshot: AgentSnapshotDto = agentSnapshot.strict().parse(body);
  assert.deepEqual(snapshot, body);
  assert.deepEqual(snapshot.tasks.map((item) => item.id), [job.id]);
  assert.equal(snapshot.tasks[0].kind, "job");
  assert.equal(Object.hasOwn(body, "notifications"), false);
  // 后台任务域已下线：响应体不再含 worker 字段。
  assert.equal(Object.hasOwn(body, "worker"), false);
  assert.equal(Object.hasOwn(snapshot, "worker"), false);
  assert.equal(snapshot.goals[0].milestones[0].id, goal.milestones[0].id);
  assert.equal(snapshot.monitors[0].originThreadId, "trip-2026");
  assert.equal(Object.hasOwn(body.monitors[0], "pendingNotification"), false);
  // 任务详情路由现在只查 jobs；查询失败返回 404，没有 task 兜底。
  const missing = await service.app.request(`/api/agent/tasks/${job.id}`, { headers });
  assert.equal(missing.status, 404);
  t.mock.method(service.jobs, "get", async () => job);
  const detail = await service.app.request(`/api/agent/tasks/${job.id}`, { headers });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.deepEqual(taskDetail.strict().parse(detailBody), detailBody);
});

// 审批不依赖工作台其他域；历史只取摘要，完整正文只能从 pending 或单项详情取得。
test("approval queries isolate pending previews from workspace failures and historical payloads", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-approval-query-"));
  const service = await createService(createConfig({ runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 } }));
  t.after(async () => { try { await service.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  const content = "完整文件正文".repeat(10000);
  const pending = await service.actions.submit("file_write", "Pending", { path: "pending.md", content, originalContent: "", baseVersion: "missing", beforeExists: "false" });
  const historical = await service.actions.submit("file_write", "Historical", { path: "history.md", content, originalContent: "", baseVersion: "missing", beforeExists: "false" });
  await service.actions.decide(historical.id, "deny");
  const expired = await service.actions.submit("file_write", "Expired", { path: "expired.md", content, originalContent: "", baseVersion: "missing", beforeExists: "false" }, { timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await service.actions.expirePending();
  t.mock.method(service.memory, "list", async () => { throw new Error("unrelated failure"); });
  assert.equal((await service.app.request("/api/agent", { headers })).status, 500);

  // 待审批通过 /api/events 的 ready 事件获取，与快照故障隔离。
  // 读取到完整帧再取消；不假设首块一定包含整个 ready。
  const sseResponse = await service.app.request("/api/events", { headers });
  assert.equal(sseResponse.status, 200);
  const reader = sseResponse.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += typeof value === "string" ? value : decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  assert.ok(text.startsWith("event: ready\n"));
  const readyData = JSON.parse(text.split("\n\n")[0].split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  assert.deepEqual(readyData.pendingApprovals.map((a: { id: string }) => a.id), [pending.id]);
  assert.equal(readyData.pendingApprovals[0].preview.after, content);

  // 历史列表 GET /api/approvals 只包含已处理/失效项，不含 pending，且省略 preview
  const historyResponse = await service.app.request("/api/approvals", { headers });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.approvals.length, 2);
  assert.ok(history.approvals.every((a: object) => !Object.hasOwn(a, "preview")));

  // 详情 GET /api/approvals/:id 返回完整不可变 preview
  const detail = await service.app.request(`/api/approvals/${historical.id}`, { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).preview.after, content);

  // 过期后 POST /api/approvals/:id/decision 返回 409
  const decision = await service.app.request(`/api/approvals/${expired.id}/decision`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decision.status, 409);
});
