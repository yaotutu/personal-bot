import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { agentSnapshot, deleteGoalResponse, deleteMemoryResponse, goalsResponse, jobDetail, jobItem, memoriesResponse, memoryItem, monitorItem, monitorsResponse } from "../../src/http/contracts/responses.js";
import { approvalSummary, approvalView } from "../../src/http/contracts/approvals.js";
import { presentJob, presentJobDetail } from "../../src/http/job-presenters.js";
import { presentMonitor } from "../../src/http/monitor-presenters.js";
import { createGoalSchema, createMemorySchema, createMonitorSchema, goalsQuerySchema, jobControlSchema, jobsQuerySchema, memoriesQuerySchema, monitorControlSchema, monitorsQuerySchema, updateGoalSchema, updateJobSchema, updateMemorySchema, updateMonitorSchema } from "../../src/http/contracts/rest.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import type { AgentSnapshotDto } from "../../src/http/contracts/responses.js";
import type { Job } from "../../src/features/jobs/types.js";

const job: Job = {
  id: "scheduled", prompt: "Reminder", daily: false, enabled: true,
  at: "2030-01-01T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  originSpaceId: "local-main",
};

// 先经过 JSON 编解码，覆盖 undefined 字段在真实 HTTP 响应中被省略的行为。
const wireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("job and monitor contracts validate lifecycle actions, updates and query parameters strictly", () => {
  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    assert.equal(jobControlSchema.safeParse({ action }).success, true);
    // 携带未知字段报错（strictObject）
    assert.equal(jobControlSchema.safeParse({ action, extra: 1 }).success, false);
  }
  assert.equal(jobControlSchema.safeParse({ action: "unknown" }).success, false);

  for (const action of ["pause", "resume", "stop"] as const) {
    assert.equal(monitorControlSchema.safeParse({ action }).success, true);
    assert.equal(monitorControlSchema.safeParse({ action, extra: 1 }).success, false);
  }
  assert.equal(monitorControlSchema.safeParse({ action: "cancel" }).success, false);

  assert.equal(updateJobSchema.safeParse({ prompt: "new prompt", daily: true, at: "09:00" }).success, true);
  assert.equal(updateJobSchema.safeParse({ prompt: "" }).success, false);
  assert.equal(updateJobSchema.safeParse({ extra: true }).success, false);

  assert.equal(updateMonitorSchema.safeParse({ title: "New title", url: "https://example.com/new", condition: "change" }).success, true);
  assert.equal(updateMonitorSchema.safeParse({ extra: true }).success, false);

  assert.equal(jobsQuerySchema.safeParse({}).success, true);
  assert.equal(jobsQuerySchema.safeParse({ spaceId: "local-main", sort: "nextRunAt", order: "asc" }).success, true);
  assert.equal(jobsQuerySchema.safeParse({ sort: "invalid" }).success, false);

  assert.equal(monitorsQuerySchema.safeParse({}).success, true);
  assert.equal(monitorsQuerySchema.safeParse({ spaceId: "local-main", sort: "createdAt", order: "desc" }).success, true);
  assert.equal(monitorsQuerySchema.safeParse({ sort: "invalid" }).success, false);

  assert.equal(memoriesQuerySchema.safeParse({}).success, true);
  assert.equal(memoriesQuerySchema.safeParse({ q: "hello", limit: 5, sort: "createdAt", order: "asc" }).success, true);
  assert.equal(memoriesQuerySchema.safeParse({ limit: 99 }).success, false);
  assert.equal(memoriesQuerySchema.safeParse({ extra: 1 }).success, false);
  assert.equal(createMemorySchema.safeParse({ text: "valid fact", source: "test" }).success, true);
  assert.equal(createMemorySchema.safeParse({ text: "   " }).success, false);
  assert.deepEqual(createMemorySchema.parse({ text: "valid", extra: 1 }), { text: "valid" });
  assert.equal(updateMemorySchema.safeParse({ text: "updated" }).success, true);
  assert.equal(updateMemorySchema.safeParse({ text: "" }).success, false);
  assert.equal(deleteMemoryResponse.safeParse({ ok: true, id: "m1" }).success, true);
  assert.equal(deleteMemoryResponse.safeParse({ ok: false, id: "m1" }).success, false);

  assert.equal(goalsQuerySchema.safeParse({}).success, true);
  assert.equal(goalsQuerySchema.safeParse({ status: "active", category: "study", sort: "createdAt", order: "asc" }).success, true);
  assert.equal(goalsQuerySchema.safeParse({ status: "invalid" }).success, false);
  assert.equal(goalsQuerySchema.safeParse({ extra: 1 }).success, false);
  assert.equal(createGoalSchema.safeParse({ title: "Run 5k", milestones: ["Buy shoes"] }).success, true);
  assert.equal(createGoalSchema.safeParse({ title: "" }).success, false);
  assert.equal(updateGoalSchema.safeParse({ title: "Run 10k", status: "completed" }).success, true);
  assert.equal(updateGoalSchema.safeParse({ status: "invalid" }).success, false);
  assert.equal(deleteGoalResponse.safeParse({ ok: true, id: "g1" }).success, true);
  assert.equal(deleteGoalResponse.safeParse({ ok: false, id: "g1" }).success, false);
});

test("creation contracts for remaining domains preserve optional source threads and reject unsafe IDs", () => {
  for (const [schema, input] of [
    [createMonitorSchema, { url: "https://example.com", condition: "change" }],
  ] as const) {
    assert.equal(schema.safeParse(input).success, true);
    for (const originSpaceId of ["local-main", "trip_2026", "A".repeat(64)]) {
      const parsed = schema.parse({ ...input, originSpaceId });
      assert.equal(parsed.originSpaceId, originSpaceId);
    }
    for (const originSpaceId of ["", "../escape", "/absolute", "-leading", "a b", "会话", "A".repeat(65), null, 42]) {
      assert.equal(schema.safeParse({ ...input, originSpaceId }).success, false);
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
  assert.deepEqual(jobItem.strict().parse(body), body);
  const detail = presentJobDetail(job);
  const detailBody = wireValue(detail);
  assert.deepEqual(jobDetail.strict().parse(detailBody), detailBody);
  assert.equal(jobDetail.safeParse({ job: detail.job, events: detail.events }).success, true);
  assert.equal(jobDetail.safeParse({ ...detail.job, events: detail.events }).success, false);
  // kind 固定为 "job"，其他别名均被拒绝。
  assert.equal(jobItem.safeParse({ ...dto, kind: "task" }).success, false);
  assert.equal(jobItem.safeParse({ ...dto, kind: "document" }).success, false);
});

test("approval contract preserves complete text, cancellation and optional execution context", () => {
  const preview = {
    scope: "space" as const,
    ownerSpaceId: "local-main",
    path: "notes.md",
    before: "旧内容",
    after: "完整待审批文本\n".repeat(200),
    beforeExists: true,
  };
  const legacy = {
    id: "approval",
    revision: 1,
    spaceId: "local-main",
    runId: "run-1",
    toolCallId: "tc-1",
    subagentId: null,
    workspaceSpaceId: "local-main",
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
  // scope=shared 时 ownerSpaceId 必须为 null；nullable 关联字段不能用空串伪装。
  const shared = {
    ...legacy,
    preview: { ...preview, scope: "shared" as const, ownerSpaceId: null },
    workspaceSpaceId: null,
  };
  assert.deepEqual(approvalView.strict().parse(shared), shared);
  // scope=skill 是实例级资源，不属于任何空间工作区，也不能用 workspace 归属伪装。
  const skill = {
    ...legacy,
    preview: { ...preview, scope: "skill" as const, ownerSpaceId: null, path: "notes/SKILL.md" },
    workspaceSpaceId: null,
  };
  assert.deepEqual(approvalView.strict().parse(skill), skill);
  assert.equal(approvalView.safeParse({ ...legacy, preview: { ...preview, scope: "skill" } }).success, false);
  assert.equal(approvalView.safeParse({ ...shared, preview: { ...shared.preview, ownerSpaceId: "thread-a" } }).success, false);
  assert.equal(approvalView.safeParse({ ...legacy, revision: 0 }).success, false);
  assert.equal(approvalView.safeParse({ ...legacy, preview: { ...preview, ownerSpaceId: "" } }).success, false);
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
    spaceId: "local-main", runId: "run-1", toolCallId: null, subagentId: null,
    workspaceSpaceId: "local-main", activityId: null,
    preview: { scope: "space" as const, ownerSpaceId: "local-main", path: "notes.md",
      before: "", after: "完整待审批文本\n".repeat(2000), beforeExists: false },
    status: "cancelled" as const, createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    resolvedAt: "2026-01-01T00:01:00.000Z", decidedAt: null,
  };
  t.mock.method(service.actions, "history", async () => [approval]);
  const monitor = {
    id: "monitor", title: "Page", url: "https://example.com", condition: "change" as const,
    intervalMinutes: 30, status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", checks: 1,
    originSpaceId: "trip-2026", pendingNotification: { id: "internal", summary: "awaiting delivery" },
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
  assert.equal(Object.hasOwn(body, "tasks"), false);
  assert.equal(Object.hasOwn(body, "notifications"), false);
  // 后台任务域已下线：响应体不再含 worker 字段。
  assert.equal(Object.hasOwn(body, "worker"), false);
  assert.equal(Object.hasOwn(snapshot, "worker"), false);
  assert.equal(Object.hasOwn(body, "goals"), false);
  assert.equal(Object.hasOwn(snapshot, "goals"), false);
  assert.equal(Object.hasOwn(body, "monitors"), false);
  assert.equal(Object.hasOwn(snapshot, "monitors"), false);
  assert.equal(Object.hasOwn(body, "memories"), false);
  assert.equal(Object.hasOwn(snapshot, "memories"), false);

  const goalsRes = await service.app.request("/api/goals", { headers });
  assert.equal(goalsRes.status, 200);
  const goalsBody = await goalsRes.json();
  assert.deepEqual(goalsResponse.strict().parse(goalsBody), goalsBody);
  assert.deepEqual(goalsBody.goals.map((item: { id: string }) => item.id), [goal.id]);
  assert.equal(goalsBody.goals[0].milestones[0].id, goal.milestones[0].id);

  const monitorsRes = await service.app.request("/api/monitors", { headers });
  assert.equal(monitorsRes.status, 200);
  const monitorsBody = await monitorsRes.json();
  assert.deepEqual(monitorsBody.monitors.map((item: { id: string }) => item.id), [monitor.id]);
  assert.equal(monitorsBody.monitors[0].originSpaceId, "trip-2026");
  assert.equal(Object.hasOwn(monitorsBody.monitors[0], "pendingNotification"), false);

  const jobsRes = await service.app.request("/api/jobs", { headers });
  assert.equal(jobsRes.status, 200);
  const jobsBody = await jobsRes.json();
  assert.deepEqual(jobsBody.jobs.map((item: { id: string }) => item.id), [job.id]);
  assert.equal(jobsBody.jobs[0].kind, "job");

  // 任务详情路由现在查 /api/jobs/:id；查询失败返回 404。
  const missing = await service.app.request(`/api/jobs/${job.id}`, { headers });
  assert.equal(missing.status, 404);
  t.mock.method(service.jobs, "get", async () => job);
  const detail = await service.app.request(`/api/jobs/${job.id}`, { headers });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.deepEqual(jobDetail.strict().parse(detailBody), detailBody);

  const memoriesRes = await service.app.request("/api/memories", { headers });
  assert.equal(memoriesRes.status, 200);
  const memoriesBody = await memoriesRes.json();
  assert.deepEqual(memoriesResponse.strict().parse(memoriesBody), { memories: [] });
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
  t.mock.method(service.identity, "get", async () => { throw new Error("unrelated failure"); });
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
