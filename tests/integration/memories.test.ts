import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { deleteMemoryResponse, memoriesResponse, memoryItem } from "../../src/http/contracts/responses.js";

const createFixture = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "personal-bot-memories-int-"));
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

test("memories REST API: CRUD lifecycle, query parameters, sorting, limits and snapshot decoupling", async (t) => {
  const { request } = await createFixture(t);

  // 1. 未登录鉴权保护
  const unauth = await request("/api/memories", { headers: { Authorization: "" } });
  assert.equal(unauth.status, 401);

  // 2. 初始列表为空
  const initial = await request("/api/memories");
  assert.equal(initial.status, 200);
  const initialData = memoriesResponse.parse(await initial.json());
  assert.deepEqual(initialData.memories, []);

  // 3. 快照解耦验证：GET /api/agent 中不再包含 memories
  const snapshotRes = await request("/api/agent");
  assert.equal(snapshotRes.status, 200);
  const snapshot = await snapshotRes.json();
  assert.equal(Object.hasOwn(snapshot, "memories"), false);

  // 4. 旧接口废弃验证：GET/POST /api/agent/memories 返回 501
  assert.equal((await request("/api/agent/memories")).status, 501);
  assert.equal((await request("/api/agent/memories", { method: "POST", body: JSON.stringify({ text: "a" }) })).status, 501);

  // 5. POST /api/memories 新增记忆
  const addRes1 = await request("/api/memories", {
    method: "POST",
    body: JSON.stringify({ text: "用户喜欢喝美式咖啡", source: "Web UI" }),
  });
  assert.equal(addRes1.status, 200);
  const mem1 = memoryItem.parse(await addRes1.json());
  assert.equal(mem1.text, "用户喜欢喝美式咖啡");
  assert.equal(mem1.source, "Web UI");
  assert.ok(mem1.id);
  assert.ok(mem1.createdAt);
  assert.ok(mem1.updatedAt);

  const addRes2 = await request("/api/memories", {
    method: "POST",
    body: JSON.stringify({ text: "用户每周跑步三次" }),
  });
  assert.equal(addRes2.status, 200);
  const mem2 = memoryItem.parse(await addRes2.json());
  assert.equal(mem2.text, "用户每周跑步三次");
  assert.equal(mem2.source, "Web UI"); // 默认 Web UI

  // 校验参数校验：空文本 400
  assert.equal((await request("/api/memories", { method: "POST", body: JSON.stringify({ text: "   " }) })).status, 400);
  assert.equal((await request("/api/memories", { method: "POST", body: JSON.stringify({}) })).status, 400);

  // 6. GET /api/memories/:id 单项详情
  const detailRes = await request(`/api/memories/${mem1.id}`);
  assert.equal(detailRes.status, 200);
  assert.deepEqual(memoryItem.parse(await detailRes.json()), mem1);
  assert.equal((await request("/api/memories/non-existent-id")).status, 404);

  // 7. GET /api/memories 列表检索
  // 7.1 无参数：返回全部，默认按 updatedAt 降序
  const listAll = memoriesResponse.parse(await (await request("/api/memories")).json());
  assert.equal(listAll.memories.length, 2);
  assert.deepEqual(listAll.memories.map((m) => m.id), [mem2.id, mem1.id]);

  // 7.2 关键词过滤 q
  const searchRes = memoriesResponse.parse(await (await request("/api/memories?q=咖啡")).json());
  assert.equal(searchRes.memories.length, 1);
  assert.equal(searchRes.memories[0].id, mem1.id);

  const searchMiss = memoriesResponse.parse(await (await request("/api/memories?q=不存在的内容")).json());
  assert.equal(searchMiss.memories.length, 0);

  // 7.3 排序与方向：sort=createdAt&order=asc
  const sortAsc = memoriesResponse.parse(await (await request("/api/memories?sort=createdAt&order=asc")).json());
  assert.deepEqual(sortAsc.memories.map((m) => m.id), [mem1.id, mem2.id]);

  // 7.4 limit
  const limitRes = memoriesResponse.parse(await (await request("/api/memories?q=用户&limit=1")).json());
  assert.equal(limitRes.memories.length, 1);

  // 7.5 非法查询参数返回 400
  assert.equal((await request("/api/memories?extra=1")).status, 400);
  assert.equal((await request("/api/memories?limit=99")).status, 400);
  assert.equal((await request("/api/memories?sort=invalid")).status, 400);
  assert.equal((await request("/api/memories?order=invalid")).status, 400);
  assert.equal((await request("/api/memories?q=a&q=b")).status, 400);

  // 8. PATCH /api/memories/:id 修改记忆
  const patchRes = await request(`/api/memories/${mem1.id}`, {
    method: "PATCH",
    body: JSON.stringify({ text: "用户喜欢喝手冲咖啡" }),
  });
  assert.equal(patchRes.status, 200);
  const patched = memoryItem.parse(await patchRes.json());
  assert.equal(patched.id, mem1.id);
  assert.equal(patched.text, "用户喜欢喝手冲咖啡");
  assert.equal(patched.source, mem1.source);
  assert.equal(patched.createdAt, mem1.createdAt);

  // PATCH 参数校验
  assert.equal((await request(`/api/memories/${mem1.id}`, { method: "PATCH", body: JSON.stringify({ text: "" }) })).status, 400);
  assert.equal((await request("/api/memories/non-existent-id", { method: "PATCH", body: JSON.stringify({ text: "new" }) })).status, 404);

  // 9. DELETE /api/memories/:id 删除记忆
  const delRes = await request(`/api/memories/${mem1.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  assert.deepEqual(deleteMemoryResponse.parse(await delRes.json()), { ok: true, id: mem1.id });

  // 再次删除返回 404
  assert.equal((await request(`/api/memories/${mem1.id}`, { method: "DELETE" })).status, 404);
  // 获取已删除条目返回 404
  assert.equal((await request(`/api/memories/${mem1.id}`)).status, 404);

  // 列表仅剩 mem2
  const finalList = memoriesResponse.parse(await (await request("/api/memories")).json());
  assert.equal(finalList.memories.length, 1);
  assert.equal(finalList.memories[0].id, mem2.id);
});
