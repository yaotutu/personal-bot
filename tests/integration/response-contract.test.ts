import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { agentSnapshot, pendingAction, taskDetail, taskView } from "../../src/http/contracts/responses.js";
import { presentAsyncTask, presentAsyncTaskDetail, presentJob, presentJobDetail } from "../../src/http/job-presenters.js";
import { createMonitorSchema, createTaskSchema, taskControlSchema } from "../../src/http/contracts/rest.js";
import type { AgentSnapshotDto } from "../../src/http/contracts/responses.js";
import type { Job } from "../../src/features/jobs/types.js";
import type { Task } from "../../src/features/tasks/types.js";

const job: Job = {
  id: "scheduled", prompt: "Reminder", daily: false, enabled: true,
  at: "2030-01-01T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  originThreadId: "local-main",
};
const task: Task = {
  id: "background", prompt: "Background instruction", title: "Background", source: "web",
  status: "succeeded", createdAt: "2026-01-02T00:00:00.000Z",
  startedAt: "2026-01-02T00:01:00.000Z", finishedAt: "2026-01-02T00:02:00.000Z", result: "done",
};

// 先经过 JSON 编解码，覆盖 undefined 字段在真实 HTTP 响应中被省略的行为。
const wireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("task control accepts pause/resume only for jobs and never turns unsupported task actions into cancel", () => {
  for (const target of [undefined, "job", "task"] as const) {
    for (const action of ["pause", "resume", "cancel", "retry"] as const) {
      assert.equal(taskControlSchema.safeParse({ target, action }).success,
        target !== undefined && (target !== "task" || action === "cancel" || action === "retry"));
    }
  }
});

test("creation contracts preserve optional source threads and reject unsafe or invalid IDs", () => {
  for (const [schema, input] of [
    [createTaskSchema, { prompt: "Background work" }],
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

test("response contracts cover both task presenters and wrapped details without dropping fields", () => {
  for (const dto of [presentJob(job), presentAsyncTask(task)]) {
    const body = wireValue(dto);
    assert.deepEqual(taskView.strict().parse(body), body);
  }
  for (const dto of [presentJobDetail(job), presentAsyncTaskDetail(task)]) {
    const body = wireValue(dto);
    assert.deepEqual(taskDetail.strict().parse(body), body);
    // 详情只包含权威任务和事实事件，无空集合占位。
    assert.equal(taskDetail.safeParse({ task: dto.task, events: dto.events }).success, true);
    assert.equal(taskDetail.safeParse({ ...dto.task, events: dto.events }).success, false);
  }
  assert.equal(taskView.safeParse({ ...presentJob(job), kind: "document" }).success, false);
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

test("HTTP snapshot matches contract with nonempty task/action projections and samples worker on every request", async (t) => {
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
  t.mock.method(service.tasks, "list", async () => [task]);
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
  let running = false;
  const isRunning = t.mock.method(service.taskWorker, "isRunning", () => running);
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  for (const next of [false, true, false]) {
    running = next;
    const response = await service.app.request("/api/agent", { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    // 使用 Web 同一导入路径，编译期检查完整集合类型；无需前端 casts 就能访问各域字段。
    const snapshot: AgentSnapshotDto = agentSnapshot.strict().parse(body);
    assert.deepEqual(snapshot, body);
    assert.equal(snapshot.worker.running, running);
    assert.deepEqual(snapshot.tasks.map((item) => item.id), [task.id, job.id]);
    assert.equal(snapshot.tasks[0].kind, "task");
    assert.equal(snapshot.tasks[1].kind, "job");
    assert.equal(Object.hasOwn(body, "notifications"), false);
    assert.equal(snapshot.goals[0].milestones[0].id, goal.milestones[0].id);
    assert.equal(snapshot.monitors[0].originThreadId, "trip-2026");
    assert.equal(Object.hasOwn(body.monitors[0], "pendingNotification"), false);
  }
  assert.equal(isRunning.mock.callCount(), 3);
  const response = await service.app.request(`/api/agent/tasks/${job.id}`, { headers });
  // 使用真实 job 详情路由，单独替换 get 数据来源，不改路由或业务状态。
  assert.equal(response.status, 404);
  t.mock.method(service.jobs, "get", async () => job);
  const detail = await service.app.request(`/api/agent/tasks/${job.id}`, { headers });
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.deepEqual(taskDetail.strict().parse(body), body);
  for (const action of ["pause", "resume"]) {
    const response = await service.app.request(`/api/agent/tasks/${task.id}/control`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action, target: "task" }),
    });
    assert.equal(response.status, 400);
  }
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

test("HTTP task admission and retry return controlled capacity errors without dispatching extra work", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-http-capacity-"));
  const service = await createService(createConfig({ runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 } }));
  t.after(async () => { try { await service.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const headers = { Authorization: `Bearer ${service.auth.login()}`, "Content-Type": "application/json" };
  const failed = await service.tasks.create("failed work", "web");
  await service.tasks.markRunning(failed.id);
  await service.tasks.markFinished(failed.id, "failed");
  await Promise.all(Array.from({ length: 32 }, () => service.tasks.create("queued work", "web")));
  for (const [path, body] of [
    ["/api/agent/tasks", { prompt: "overflow" }],
    [`/api/agent/tasks/${failed.id}/control`, { action: "retry", target: "task" }],
  ] as const) {
    const response = await service.app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /queue|32/i);
  }
  assert.equal((await service.tasks.list()).length, 33);
  assert.equal((await service.tasks.get(failed.id))?.status, "failed");
});
