import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { waitForTest } from "../support/http-client.js";
import type { ConversationInput } from "../../src/features/conversation/types.js";
import { randomUUID } from "node:crypto";
import type { ActivitiesPageDto, ActivityDetailDto } from "../../src/http/contracts/activities.js";

const input = (text: string, threadId = "local-main", runId = `run-${Date.now()}`): ConversationInput => ({
  threadId,
  runId,
  expectedRevision: "empty",
  message: { id: `user-${randomUUID()}`, content: text },
});

test("activity-integration: ordinary conversation does not register any activity", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-ordinary-"));
  t.after(async () => {
    await service?.close();
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
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  // 普通闲聊
  const runRes = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("你好，今天天气怎么样？")),
  });
  assert.equal(runRes.status, 200);
  await runRes.text();

  // 查询 activities 必须为空
  const listRes = await service.app.request("/api/activities", { headers });
  assert.equal(listRes.status, 200);
  const data = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(data.activities.length, 0);
  assert.equal(data.hasMore, false);
  assert.equal(data.nextCursor, null);
});

test("activity-integration: autonomous activity registration, execution, steps and completion", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-full-"));
  t.after(async () => {
    await service?.close();
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
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  // 发起交办工作
  const runRes = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("活动交办调研 Pi 生态圈并生成报告")),
  });
  assert.equal(runRes.status, 200);
  const sseText = await runRes.text();
  assert.match(sseText, /已为您完成交办工作/);

  // 查询 activities 列表
  const listRes = await service.app.request("/api/activities", { headers });
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(list.activities.length, 1);
  const act = list.activities[0]!;
  assert.equal(act.title, "调研 Pi 生态圈");
  assert.equal(act.goal, "梳理生态现状与核心组件");
  assert.equal(act.deliverable, "调研报告文档");
  assert.equal(act.status, "completed");
  assert.equal(act.result, "交付成果：已完成调研总结报告");
  assert.ok(act.finishedAt);

  // 查询 activity 详情
  const detailRes = await service.app.request(`/api/activities/${act.id}`, { headers });
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as ActivityDetailDto;
  assert.equal(detail.activity.id, act.id);
  assert.equal(detail.activity.status, "completed");

  // 必须记录真实步骤明细
  assert.ok(detail.steps.length >= 2);
  const execStep = detail.steps.find((s) => s.kind === "execution");
  assert.ok(execStep);
  assert.equal(execStep.status, "succeeded");

  const modelStep = detail.steps.find((s) => s.kind === "model");
  assert.ok(modelStep);
  assert.equal(modelStep.status, "succeeded");

  // 查询不存在的 ID 必须 404
  const notFound = await service.app.request("/api/activities/non-existent-id", { headers });
  assert.equal(notFound.status, 404);
});

test("activity-integration: activity with subagent step nesting", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-subagent-"));
  t.after(async () => {
    await service?.close();
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
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  const runRes = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("活动交办 活动子代理")),
  });
  assert.equal(runRes.status, 200);
  await runRes.text();

  const listRes = await service.app.request("/api/activities", { headers });
  const list = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(list.activities.length, 1);
  const act = list.activities[0]!;

  const detailRes = await service.app.request(`/api/activities/${act.id}`, { headers });
  const detail = (await detailRes.json()) as ActivityDetailDto;

  // 确认记录了 subagent 步骤
  const subagentStep = detail.steps.find((s) => s.kind === "subagent");
  assert.ok(subagentStep, "Should record subagent step");
  assert.equal(subagentStep.status, "succeeded");
});

test("activity-integration: stop marks activity stopped and resume continues under same ID", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-stop-resume-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 10000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  // 1. 发起交办并中途 Stop
  const runId = "run-stop-test";
  const runPromise = service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("活动交办 活动停止", "local-main", runId)),
  });

  // 只在登记已落盘且模型进入挂起请求后 Stop，不用固定延迟猜执行阶段。
  await waitForTest(async () => {
    const response = await service.app.request("/api/activities", { headers });
    const page = (await response.json()) as ActivitiesPageDto;
    return model.requests.length >= 2 && page.activities.some((item) => item.currentRunId === runId);
  }, "registered activity and pending model request");

  // 触发 Stop
  const stopRes = await service.app.request("/api/conversation/stop", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "local-main", runId }),
  });
  assert.equal(stopRes.status, 200);

  const runRes = await runPromise;
  await runRes.text();

  // 查询活动状态：必须为 stopped
  const listRes = await service.app.request("/api/activities", { headers });
  const list = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(list.activities.length, 1);
  const act = list.activities[0]!;
  assert.equal(act.status, "stopped");
  assert.ok(act.finishedAt);

  // 2. 第二轮继续原活动
  const convRes = await service.app.request("/api/conversation?threadId=local-main", { headers });
  const conv = (await convRes.json()) as { revision: string };
  const secondInput = {
    ...input(`活动继续 ${act.id}`, "local-main", "run-resume-test"),
    expectedRevision: conv.revision,
  };
  const resumeRes = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(secondInput),
  });
  assert.equal(resumeRes.status, 200);
  await resumeRes.text();

  // 再次查询：活动状态更新为 completed，ID 保持一致，保留两轮运行的 ID 记录
  const afterListRes = await service.app.request("/api/activities", { headers });
  const afterList = (await afterListRes.json()) as ActivitiesPageDto;
  assert.equal(afterList.activities.length, 1);
  const resumedAct = afterList.activities[0]!;
  assert.equal(resumedAct.id, act.id);
  assert.equal(resumedAct.status, "completed");
  assert.deepEqual(resumedAct.runIds, ["run-stop-test", "run-resume-test"]);

  // 详情保留了两轮的执行步骤
  const detailRes = await service.app.request(`/api/activities/${act.id}`, { headers });
  const detail = (await detailRes.json()) as ActivityDetailDto;
  const executionSteps = detail.steps.filter((s) => s.kind === "execution");
  assert.equal(executionSteps.length, 2);
  assert.equal(executionSteps[0]?.status, "cancelled");
  assert.equal(executionSteps[1]?.status, "succeeded");
});

test("activity-integration: thread deletion cascade deletes its activities", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-cascade-"));
  t.after(async () => {
    await service?.close();
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
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  const customThread = "custom-thread-1";
  const runRes = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("活动交办调研 Pi 生态圈", customThread)),
  });
  assert.equal(runRes.status, 200);
  await runRes.text();

  const listRes = await service.app.request(`/api/activities?threadId=${customThread}`, { headers });
  const list = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(list.activities.length, 1);
  const actId = list.activities[0]!.id;

  // 删除该会话
  const delRes = await service.app.request(`/api/threads/${customThread}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(delRes.status, 200);

  // 删除后，该会话的活动必须立刻消失
  const afterListRes = await service.app.request(`/api/activities?threadId=${customThread}`, { headers });
  const afterList = (await afterListRes.json()) as ActivitiesPageDto;
  assert.equal(afterList.activities.length, 0);

  // 详情返回 404
  const detailRes = await service.app.request(`/api/activities/${actId}`, { headers });
  assert.equal(detailRes.status, 404);
});

test("activity-integration: activity with write approval records approval and file_commit steps", async (t) => {
  const model = await createFakeModel();
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-activity-write-"));
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 10000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}` };

  // 触发活动交办 + 写文件
  const runPromise = service.app.request("/api/conversation/run", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input("活动交办 活动写文件")),
  });

  // 审批依真实 pending 状态观察，不因机器负载误判尚未登记的请求。
  const pendingActionId = await waitForTest(async () => {
    const action = (await service.actions.history()).find((a) => a.status === "pending");
    return action?.id;
  }, "pending activity write approval");

  // 人工批准该写入
  const decideRes = await service.app.request(`/api/approvals/${pendingActionId}/decision`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decideRes.status, 200);

  const runRes = await runPromise;
  await runRes.text();

  // 查询详情，验证 approval 步骤和 file_commit 步骤
  const listRes = await service.app.request("/api/activities", { headers });
  const list = (await listRes.json()) as ActivitiesPageDto;
  assert.equal(list.activities.length, 1);
  const act = list.activities[0]!;

  const detailRes = await service.app.request(`/api/activities/${act.id}`, { headers });
  const detail = (await detailRes.json()) as ActivityDetailDto;

  const approvalStep = detail.steps.find((s) => s.kind === "approval");
  assert.ok(approvalStep, "Should record approval step");
  assert.equal(approvalStep.status, "succeeded");

  const commitStep = detail.steps.find((s) => s.kind === "file_commit");
  assert.ok(commitStep, "Should record file_commit step");
  assert.equal(commitStep.status, "succeeded");
});
