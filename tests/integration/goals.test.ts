import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { deleteGoalResponse, goalView, goalsResponse } from "../../src/http/contracts/responses.js";

const createFixture = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-goals-int-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: {},
      model: { baseUrl: "http://127.0.0.1:9/v1", id: "test-model", apiKey: "k" },
      runtime: {
        dataDir,
        runTimeoutMs: 5000,
        schedulerIntervalMs: 60000,
        monitorScanIntervalMs: 60000,
      },
    }),
  );
  const token = service.auth.login()!;
  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return service!.app.request(path, { ...options, headers });
  };
  return { service, request, dataDir };
};

test("goals REST API: CRUD lifecycle, query parameters, sorting, status transitions, milestones and snapshot decoupling", async (t) => {
  const { request } = await createFixture(t);

  // 1. 未登录鉴权保护
  const unauth = await request("/api/goals", { headers: { Authorization: "" } });
  assert.equal(unauth.status, 401);

  // 2. 初始列表为空
  const initial = await request("/api/goals");
  assert.equal(initial.status, 200);
  const initialData = goalsResponse.parse(await initial.json());
  assert.deepEqual(initialData.goals, []);

  // 3. 快照解耦验证：GET /api/agent 中不再包含 goals
  const snapshotRes = await request("/api/agent");
  assert.equal(snapshotRes.status, 200);
  const snapshot = await snapshotRes.json();
  assert.equal(Object.hasOwn(snapshot, "goals"), false);

  // 4. 旧接口废弃验证：POST /api/agent/goals 返回 501
  assert.equal((await request("/api/agent/goals", { method: "POST", body: JSON.stringify({ title: "a" }) })).status, 501);

  // 5. POST /api/goals 新增目标
  const addRes1 = await request("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title: "完成半程马拉松",
      description: "在年底前完成一次 21km 挑战",
      category: "fitness",
      milestones: ["跑量达 30km/周", "完成 15km 长距离"],
    }),
  });
  assert.equal(addRes1.status, 200);
  const goal1 = goalView.parse(await addRes1.json());
  assert.equal(goal1.title, "完成半程马拉松");
  assert.equal(goal1.category, "fitness");
  assert.equal(goal1.status, "active");
  assert.equal(goal1.milestones.length, 2);
  assert.equal(goal1.milestones[0].done, false);

  const addRes2 = await request("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title: "学习 Rust 语言",
      category: "study",
    }),
  });
  assert.equal(addRes2.status, 200);
  const goal2 = goalView.parse(await addRes2.json());
  assert.equal(goal2.title, "学习 Rust 语言");
  assert.equal(goal2.category, "study");

  // 校验参数校验：空标题 400
  assert.equal((await request("/api/goals", { method: "POST", body: JSON.stringify({ title: "   " }) })).status, 400);
  assert.equal((await request("/api/goals", { method: "POST", body: JSON.stringify({}) })).status, 400);

  // 6. GET /api/goals/:id 单项详情
  const detailRes = await request(`/api/goals/${goal1.id}`);
  assert.equal(detailRes.status, 200);
  assert.deepEqual(goalView.parse(await detailRes.json()), goal1);
  assert.equal((await request("/api/goals/non-existent-id")).status, 404);

  // 7. GET /api/goals 列表与过滤排序
  // 7.1 无参数：返回全部，默认 updatedAt 降序
  const listAll = goalsResponse.parse(await (await request("/api/goals")).json());
  assert.equal(listAll.goals.length, 2);
  assert.deepEqual(listAll.goals.map((g) => g.id), [goal2.id, goal1.id]);

  // 7.2 按 category 过滤
  const fitnessList = goalsResponse.parse(await (await request("/api/goals?category=fitness")).json());
  assert.equal(fitnessList.goals.length, 1);
  assert.equal(fitnessList.goals[0].id, goal1.id);

  // 7.3 按 status 过滤
  const activeList = goalsResponse.parse(await (await request("/api/goals?status=active")).json());
  assert.equal(activeList.goals.length, 2);

  const pausedList = goalsResponse.parse(await (await request("/api/goals?status=paused")).json());
  assert.equal(pausedList.goals.length, 0);

  // 7.4 排序与方向：sort=createdAt&order=asc
  const sortAsc = goalsResponse.parse(await (await request("/api/goals?sort=createdAt&order=asc")).json());
  assert.deepEqual(sortAsc.goals.map((g) => g.id), [goal1.id, goal2.id]);

  // 7.5 非法查询参数返回 400
  assert.equal((await request("/api/goals?extra=1")).status, 400);
  assert.equal((await request("/api/goals?status=invalid")).status, 400);
  assert.equal((await request("/api/goals?sort=invalid")).status, 400);

  // 8. POST /api/goals/:id/milestones/:mid/toggle 切换里程碑
  const mId = goal1.milestones[0].id;
  const toggleRes1 = await request(`/api/goals/${goal1.id}/milestones/${mId}/toggle`, { method: "POST" });
  assert.equal(toggleRes1.status, 200);
  const toggled1 = goalView.parse(await toggleRes1.json());
  assert.equal(toggled1.milestones[0].done, true);
  assert.ok(toggled1.milestones[0].doneAt);

  // 再次切换即取消勾选
  const toggleRes2 = await request(`/api/goals/${goal1.id}/milestones/${mId}/toggle`, { method: "POST" });
  assert.equal(toggleRes2.status, 200);
  const toggled2 = goalView.parse(await toggleRes2.json());
  assert.equal(toggled2.milestones[0].done, false);

  // 不存在的里程碑或目标返回 404
  assert.equal((await request(`/api/goals/${goal1.id}/milestones/missing/toggle`, { method: "POST" })).status, 404);
  assert.equal((await request("/api/goals/missing/milestones/m/toggle", { method: "POST" })).status, 404);

  // 9. PATCH /api/goals/:id 修改目标与状态
  // 9.1 修改标题与分类
  const patchRes1 = await request(`/api/goals/${goal1.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "完成全程马拉松", category: "marathon" }),
  });
  assert.equal(patchRes1.status, 200);
  const patched1 = goalView.parse(await patchRes1.json());
  assert.equal(patched1.title, "完成全程马拉松");
  assert.equal(patched1.category, "marathon");

  // 9.2 修改状态为 completed 自动勾选全部里程碑
  const patchRes2 = await request(`/api/goals/${goal1.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(patchRes2.status, 200);
  const patched2 = goalView.parse(await patchRes2.json());
  assert.equal(patched2.status, "completed");
  assert.ok(patched2.milestones.every((m) => m.done && m.doneAt));

  // 9.3 404 与参数校验
  assert.equal((await request("/api/goals/missing", { method: "PATCH", body: JSON.stringify({ title: "new" }) })).status, 404);
  assert.equal((await request(`/api/goals/${goal1.id}`, { method: "PATCH", body: JSON.stringify({ status: "invalid" }) })).status, 400);

  // 10. DELETE /api/goals/:id 删除目标
  const delRes = await request(`/api/goals/${goal1.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  assert.deepEqual(deleteGoalResponse.parse(await delRes.json()), { ok: true, id: goal1.id });

  // 再次删除返回 404
  assert.equal((await request(`/api/goals/${goal1.id}`, { method: "DELETE" })).status, 404);
  // 再次查询已删除目标返回 404
  assert.equal((await request(`/api/goals/${goal1.id}`)).status, 404);

  // 列表仅剩 goal2
  const finalList = goalsResponse.parse(await (await request("/api/goals")).json());
  assert.equal(finalList.goals.length, 1);
  assert.equal(finalList.goals[0].id, goal2.id);
});
