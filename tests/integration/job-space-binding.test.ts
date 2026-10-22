import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createScheduler } from "../../src/features/jobs/scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
};

const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-job-binding-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const releaseGates: (() => void)[] = [];

  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };

  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  });

  service = await createService(config);
  server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const snapshot = async (id: string) => {
    const response = await request(`/api/conversation?spaceId=${id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: { role: string; content?: string }[]; revision: string }>;
  };

  const listed = async (id: string) => {
    const response = await request("/api/spaces");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { spaces?: { id: string }[]; threads?: { id: string }[] };
    return (body.spaces || body.threads || []).some((thread: { id: string }) => thread.id === id);
  };

  return { dir, model, service: () => service!, request, snapshot, listed, releaseGates };
};

test("existing job rebound to a valid new originSpaceId creates target space and runs in that space", async (t) => {
  const h = await fixture(t);
  const initialJob = await h.service().jobs.add("test rebound prompt", false, "2030-01-01T00:00:00.000Z", "local-main");
  const targetSpaceId = "rebound-target";

  assert.equal(await h.listed(targetSpaceId), false);
  await assertMissing(join(h.dir, "sessions", targetSpaceId));

  const modelCallsBefore = h.model.requests.length;

  const patchResp = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", {
    originSpaceId: targetSpaceId,
  });
  assert.equal(patchResp.status, 200);
  const patchedJob = await patchResp.json() as { id: string; originSpaceId?: string };
  assert.equal(patchedJob.originSpaceId, targetSpaceId);

  // 1. 真实空间列表与 sessions 目录已建立
  assert.equal(await h.listed(targetSpaceId), true);
  const targetDirStat = await stat(join(h.dir, "sessions", targetSpaceId));
  assert.ok(targetDirStat.isDirectory());

  // 再改绑已存在空间也成功
  const secondPatch = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", {
    originSpaceId: targetSpaceId,
  });
  assert.equal(secondPatch.status, 200);

  // 调度器触发该任务，等待 jobs.get(id).lastStatus === "completed"
  const pastIso = new Date(Date.now() - 1000).toISOString();
  await h.service().jobs.update(initialJob.id, { at: pastIso });
  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 },
    h.service().jobs,
    await h.service().conversationHub.forSpace("local-main"),
    (id) => h.service().conversationHub.findSpace(id),
  );
  scheduler.start();
  try {
    await until(async () => {
      const stored = await h.service().jobs.get(initialJob.id);
      return stored?.lastStatus === "completed";
    });

    // 目标空间历史中包含 assistant 的 JOB-RAN 输出
    const targetSnap = await h.snapshot(targetSpaceId);
    assert.ok(
      targetSnap.messages.some(
        (m) => m.role === "assistant" && m.content?.includes("JOB-RAN") && m.content?.includes("test rebound prompt"),
      ),
      "target space history must include assistant JOB-RAN reply",
    );

    // 本地 provider 发生调用
    assert.ok(h.model.requests.length > modelCallsBefore, "model requests count must increase");

    // 主空间无误投
    const mainSnap = await h.snapshot("local-main");
    assert.equal(mainSnap.messages.some((m) => m.content?.includes("test rebound prompt")), false);
  } finally {
    await scheduler.close();
  }
});

test("omitting originSpaceId on update preserves existing originSpaceId and does not open extra spaces", async (t) => {
  const h = await fixture(t);
  const targetSpaceId = "custom-origin";
  // 先通过 explicit withSpace 建立空间并添加任务
  await h.service().conversationHub.withSpace(targetSpaceId, async () => undefined);
  const job = await h.service().jobs.add("prompt to preserve", false, "2030-01-01T00:00:00.000Z", targetSpaceId);

  // 捕获更新前的空间列表与 sessions 目录集合
  const beforeSpacesResp = await h.request("/api/spaces");
  const beforeSpaces = ((await beforeSpacesResp.json()) as { spaces?: { id: string }[] }).spaces?.map((s) => s.id).sort();
  const beforeDirs = (await readdir(join(h.dir, "sessions"))).sort();

  // 监听 withSpace 调用次数
  let withSpaceCalls = 0;
  const originalWithSpace = h.service().conversationHub.withSpace;
  h.service().conversationHub.withSpace = async (...args) => {
    withSpaceCalls++;
    return originalWithSpace(...args);
  };
  try {
    const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
      prompt: "updated prompt text",
    });
    assert.equal(patchResp.status, 200);
    const patchedJob = await patchResp.json() as { id: string; prompt: string; originSpaceId?: string };
    assert.equal(patchedJob.prompt, "updated prompt text");
    assert.equal(patchedJob.originSpaceId, targetSpaceId);

    // 验证 withSpace 调用为零，原绑定不变
    assert.equal(withSpaceCalls, 0, "withSpace must not be called when originSpaceId is omitted");

    // 空间列表与 sessions 目录前后完全一致，没有打开或创建任何额外空间
    const afterSpacesResp = await h.request("/api/spaces");
    const afterSpaces = ((await afterSpacesResp.json()) as { spaces?: { id: string }[] }).spaces?.map((s) => s.id).sort();
    const afterDirs = (await readdir(join(h.dir, "sessions"))).sort();

    assert.deepEqual(afterSpaces, beforeSpaces);
    assert.deepEqual(afterDirs, beforeDirs);
  } finally {
    h.service().conversationHub.withSpace = originalWithSpace;
  }
});

test("invalid schedule format, bad input or missing job is rejected before creating target space", async (t) => {
  const h = await fixture(t);
  const nonExistentSpace = "never-created-space";

  // 1. 任务不存在 404，不创建空间
  const missingJobResp = await h.request("/api/jobs/missing-id", "PATCH", {
    originSpaceId: nonExistentSpace,
  });
  assert.equal(missingJobResp.status, 404);
  assert.equal(await h.listed(nonExistentSpace), false);
  await assertMissing(join(h.dir, "sessions", nonExistentSpace));

  // 2. 存在任务，但更新 payload 无效（如非法时刻格式）400，不创建空间
  const job = await h.service().jobs.add("valid prompt", false, "2030-01-01T00:00:00.000Z", "local-main");
  const badScheduleResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    daily: true,
    at: "invalid-hh-mm",
    originSpaceId: nonExistentSpace,
  });
  assert.equal(badScheduleResp.status, 400);
  assert.equal(await h.listed(nonExistentSpace), false);
  await assertMissing(join(h.dir, "sessions", nonExistentSpace));

  // 3. 非法 originSpaceId 400
  const badSpaceIdResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSpaceId: "invalid space name with spaces",
  });
  assert.equal(badSpaceIdResp.status, 400);
});

test("deterministic gate: PATCH returns 409 SPACE_DELETING while target space is being deleted, job remains unchanged and no resurrection occurs", async (t) => {
  const h = await fixture(t);
  const targetSpaceId = "space-to-delete";
  await h.service().conversationHub.withSpace(targetSpaceId, async () => undefined);
  assert.equal(await h.listed(targetSpaceId), true);

  const job = await h.service().jobs.add("prompt original", false, "2030-01-01T00:00:00.000Z", "local-main");

  const deleteEntered = deferred();
  const deleteProceed = deferred();
  const originalRemoveJobs = h.service().jobs.removeByOriginSpaceId;
  h.service().jobs.removeByOriginSpaceId = async (origin) => {
    deleteEntered.resolve();
    await deleteProceed.promise;
    return originalRemoveJobs(origin);
  };
  h.releaseGates.push(deleteProceed.resolve);

  // 开始删除 targetSpaceId
  const deleteReq = h.request(`/api/spaces/${targetSpaceId}`, "DELETE");
  await deleteEntered.promise;

  // 删除进行中，尝试将任务改绑到该空间 -> 必须返回 409 SPACE_DELETING
  const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSpaceId: targetSpaceId,
  });
  assert.equal(patchResp.status, 409);
  const patchBody = await patchResp.json() as { code?: string; error?: string };
  assert.equal(patchBody.code, "SPACE_DELETING");

  // 原任务及其归属不变
  const currentJob = await h.service().jobs.get(job.id);
  assert.equal(currentJob?.originSpaceId, "local-main");

  // 放行删除完成
  deleteProceed.resolve();
  assert.equal((await deleteReq).status, 200);
  h.service().jobs.removeByOriginSpaceId = originalRemoveJobs;

  // 删除完成后无目标空间复活，原任务仍属 local-main
  assert.equal(await h.listed(targetSpaceId), false);
  await assertMissing(join(h.dir, "sessions", targetSpaceId));
});

test("deterministic gate: rebinding enters withSpace first, then DELETE starts; upon rebind completion DELETE cascades the job, directory does not resurrect", async (t) => {
  const h = await fixture(t);
  const targetSpaceId = "rebind-then-delete";
  const job = await h.service().jobs.add("prompt to cascade", false, "2030-01-01T00:00:00.000Z", "local-main");

  const updateEntered = deferred();
  const updateProceed = deferred();
  const originalUpdate = h.service().jobs.update;
  h.service().jobs.update = async (...args) => {
    updateEntered.resolve();
    await updateProceed.promise;
    return originalUpdate(...args);
  };
  h.releaseGates.push(updateProceed.resolve);

  // 包裹 deleteSpace，确保 DELETE 已进入服务端并同步设置了 deleting 门
  const deleteEntered = deferred();
  const originalDeleteSpace = h.service().conversationHub.deleteSpace;
  h.service().conversationHub.deleteSpace = ((id: string, remove: () => Promise<unknown>) => {
    const promise = originalDeleteSpace(id, remove);
    deleteEntered.resolve();
    return promise;
  }) as typeof originalDeleteSpace;

  let removeJobsCalled = false;
  const originalRemoveJobs = h.service().jobs.removeByOriginSpaceId;
  h.service().jobs.removeByOriginSpaceId = async (origin) => {
    removeJobsCalled = true;
    return originalRemoveJobs(origin);
  };

  try {
    // 发起改绑 PATCH，改绑会先进入 withSpace 并挂起在 jobs.update
    const patchReq = h.request(`/api/jobs/${job.id}`, "PATCH", {
      originSpaceId: targetSpaceId,
    });
    await updateEntered.promise;

    // 发起 DELETE 该空间
    const deleteReq = h.request(`/api/spaces/${targetSpaceId}`, "DELETE");

    // 等待 DELETE 到达服务端并进入 deleteSpace（deleting 门已设）
    await deleteEntered.promise;

    // 证明级联等待改绑：此时 withSpace 尚未完成，deleteSpace 内部排队等待，removeByOriginSpaceId 尚未被调用
    assert.equal(removeJobsCalled, false, "removeByOriginSpaceId must wait for in-flight withSpace rebind");

    // 放行 jobs.update
    updateProceed.resolve();

    const [patchResp, deleteResp] = await Promise.all([patchReq, deleteReq]);
    assert.equal(patchResp.status, 200);
    assert.equal(deleteResp.status, 200);

    // 改绑完成后由于 deleteSpace 紧接着执行，该任务被级联删除
    assert.equal(removeJobsCalled, true, "removeByOriginSpaceId must be called during space deletion");
    const jobAfterCascade = await h.service().jobs.get(job.id);
    assert.equal(jobAfterCascade, undefined);

    // 目录不复活
    assert.equal(await h.listed(targetSpaceId), false);
    await assertMissing(join(h.dir, "sessions", targetSpaceId));
  } finally {
    updateProceed.resolve();
    h.service().jobs.update = originalUpdate;
    h.service().jobs.removeByOriginSpaceId = originalRemoveJobs;
    h.service().conversationHub.deleteSpace = originalDeleteSpace;
  }
});

test("deterministic gate: in-flight stale scan snapshot cannot execute after origin space is deleted", async (t) => {
  const h = await fixture(t);
  const targetSpaceId = "stale-scan-origin";

  // 创建并改绑一个已到期任务到 targetSpaceId
  const pastIso = new Date(Date.now() - 1000).toISOString();
  const job = await h.service().jobs.add("stale scan prompt", false, pastIso, "local-main");
  const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSpaceId: targetSpaceId,
  });
  assert.equal(patchResp.status, 200);
  assert.equal(await h.listed(targetSpaceId), true);

  const modelCallsBefore = h.model.requests.length;

  const resolutionEntered = deferred();
  const resolutionProceed = deferred();
  h.releaseGates.push(resolutionProceed.resolve);

  // 独立 scheduler：forSpace 先取得真实的 conversation，但挂起在返回前
  let resolvedOnce = false;
  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 },
    h.service().jobs,
    await h.service().conversationHub.forSpace("local-main"),
    async (spaceId) => {
      const conv = await h.service().conversationHub.findSpace(spaceId);
      if (spaceId === targetSpaceId && !resolvedOnce) {
        resolvedOnce = true;
        resolutionEntered.resolve();
        await resolutionProceed.promise;
      }
      return conv;
    },
  );

  scheduler.start();
  try {
    // 等待 scheduler 扫描到该到期任务并进入 forSpace 解析
    await resolutionEntered.promise;

    // 此时调度器持有该任务快照并已拿到 targetSpace 的 conversation，但在返回给调度器前挂起；
    // 发起真实 HTTP DELETE 删除该空间并级联清理该任务
    const deleteResp = await h.request(`/api/spaces/${targetSpaceId}`, "DELETE");
    assert.equal(deleteResp.status, 200);

    // 确认空间已删除，任务已级联清理
    assert.equal(await h.service().jobs.get(job.id), undefined);
    assert.equal(await h.listed(targetSpaceId), false);
    await assertMissing(join(h.dir, "sessions", targetSpaceId));

    // 放行 forSpace 返回刚才缓存的旧 conversation
    resolutionProceed.resolve();

    // 等待该 tick 真正结束（scheduler 变空闲）
    await until(async () => !scheduler.isBusy());

    // 验证：无新的 provider 请求、主空间无消息、目标目录未复活、jobs 中仍无该项
    assert.equal(h.model.requests.length, modelCallsBefore, "no provider requests should be made for deleted origin");
    const mainSnap = await h.snapshot("local-main");
    assert.equal(mainSnap.messages.some((m) => m.content?.includes("stale scan prompt")), false);
    assert.equal(await h.listed(targetSpaceId), false);
    await assertMissing(join(h.dir, "sessions", targetSpaceId));
    assert.equal(await h.service().jobs.get(job.id), undefined);
  } finally {
    resolutionProceed.resolve();
    await scheduler.close();
  }
});
