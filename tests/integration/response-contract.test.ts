import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { agentSnapshot, pendingAction, taskDetail, taskView } from "../../src/http/contracts/responses.js";
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
  const payload = { path: "notes.md", content: "完整待审批文本\n".repeat(2000), oldText: "旧内容", newText: "新内容" };
  const legacy = {
    id: "approval", kind: "file_write", title: "Write notes", payload,
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:05:00.000Z",
  };
  for (const status of ["pending", "approved", "denied", "expired", "cancelled"] as const) {
    const action = { ...legacy, status };
    assert.deepEqual(pendingAction.strict().parse(action), action);
    const contextual = {
      ...action, expiresAt: "2026-01-01T00:05:00.000Z", threadId: "local-main", runId: "run-1",
      decidedAt: "2026-01-01T00:01:00.000Z",
    };
    assert.deepEqual(pendingAction.strict().parse(contextual), contextual);
  }
  assert.equal(pendingAction.safeParse({ ...legacy, status: "unknown" }).success, false);
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
  const approval = {
    id: "approval", kind: "file_write" as const, title: "Write notes",
    payload: { path: "notes.md", content: "完整待审批文本\n".repeat(2000) },
    status: "cancelled" as const, createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z", threadId: "local-main", runId: "run-1",
  };
  t.mock.method(service.actions, "list", async () => [approval]);
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
  const pending = await service.actions.submit("file_write", "Pending", { path: "pending.md", content });
  const historical = await service.actions.submit("file_write", "Historical", { path: "history.md", content });
  await service.actions.decide(historical.id, "deny");
  const expired = await service.actions.submit("file_write", "Expired", { path: "expired.md", content }, { timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  t.mock.method(service.memory, "list", async () => { throw new Error("unrelated failure"); });
  assert.equal((await service.app.request("/api/agent", { headers })).status, 500);
  const waiting = await service.app.request("/api/actions/pending", { headers });
  assert.equal(waiting.status, 200);
  const body = await waiting.json();
  assert.deepEqual(body.actions.map((action: { id: string }) => action.id), [pending.id]);
  assert.equal(body.actions[0].payload.content, content);
  const history = await (await service.app.request("/api/actions", { headers })).json();
  assert.equal(history.actions.length, 3);
  assert.ok(history.actions.every((action: object) => !Object.hasOwn(action, "payload")));
  const detail = await service.app.request(`/api/actions/${historical.id}`, { headers });
  assert.equal((await detail.json()).payload.content, content);
  const decision = await service.app.request(`/api/actions/${expired.id}/decide`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decision.status, 409);
});
