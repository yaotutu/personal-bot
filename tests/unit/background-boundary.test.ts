import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskRepository } from "../../src/adapters/storage/task-repository.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { createTaskService, TaskQueueFullError } from "../../src/features/tasks/task-service.js";
import { createTools } from "../../src/adapters/pi/tools/index.js";
import type { MonitorService } from "../../src/features/monitors/monitor-service.js";

// 使用真实隔离 repository 验证并发准入；不能用无锁内存假实现掩盖检查位置错误。
test("concurrent task creation admits at most 32 queued/running tasks and frees terminal slots", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-capacity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createTaskService(createTaskRepository(join(dir, "tasks.json")));
  const results = await Promise.allSettled(Array.from({ length: 35 }, () => tasks.create("work", "web")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 32);
  for (const result of results)
    if (result.status === "rejected") assert.ok(result.reason instanceof TaskQueueFullError);
  const first = (await tasks.list())[0];
  await tasks.markRunning(first.id);
  await assert.rejects(tasks.create("overflow", "chat"), TaskQueueFullError);
  await tasks.markFinished(first.id, "succeeded", "done");
  await tasks.create("replacement", "chat");
  assert.equal((await tasks.list()).length, 33);
});

test("retry checks capacity atomically and leaves rejected failed task unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-retry-capacity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createTaskService(createTaskRepository(join(dir, "tasks.json")));
  const failed = await tasks.create("fail", "chat");
  await tasks.markRunning(failed.id);
  await tasks.markFinished(failed.id, "failed");
  await Promise.all(Array.from({ length: 31 }, () => tasks.create("work", "web")));
  // 最后一个空位由 create 和 retry 争用，只有其中之一可以成功。
  const results = await Promise.allSettled([tasks.create("last slot", "web"), tasks.control(failed.id, "retry")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected" && rejection.reason instanceof TaskQueueFullError);
  assert.equal((await tasks.get(failed.id))?.status, "failed");
  const queued = (await tasks.list()).find((task) => task.status === "queued")!;
  await tasks.control(queued.id, "cancel");
  assert.equal((await tasks.control(failed.id, "retry")).ok, true);
});

test("background tool assembly removes work spawning capabilities while keeping foreground tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-background-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createTaskService(createTaskRepository(join(dir, "tasks.json")));
  const deps = {
    root: dir,
    memory: createMemoryService(createMemoryRepository(join(dir, "memory.json"))),
    jobs: createJobService(createJobRepository(join(dir, "jobs.json"))),
    tasks,
    worker: { kick: () => {}, control: tasks.control },
    // 此测试只验证装配；工具 factory 不执行监控服务方法。
    monitors: {} as MonitorService,
  };
  const foreground = createTools({ ...deps, threadId: "local-main" }).map((tool) => tool.name);
  const background = createTools({ ...deps, threadId: "task-server-owned-id" }).map((tool) => tool.name);
  const restricted = ["schedule", "delegate_task", "monitor"];
  assert.ok(restricted.every((name) => foreground.includes(name)));
  assert.deepEqual(background, foreground.filter((name) => !restricted.includes(name)));
  assert.deepEqual(createTools(deps).map((tool) => tool.name), foreground);
});
