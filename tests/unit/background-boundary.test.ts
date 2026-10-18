import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { createActionService } from "../../src/features/actions/action-service.js";
import { createTools } from "../../src/adapters/pi/tools/index.js";
import type { MonitorService } from "../../src/features/monitors/monitor-service.js";

/**
 * 子代理（subagent）边界单测：createTools 在 isSubagent=true 下裁剪掉会扩张副作用面、
 * 再起子任务、或读取会话专属指令的能力；写文件审批与读工具保持不变。
 *
 * 工具注册表的合法全集由 src/adapters/pi/tools/index.ts 单一权威声明；
 * 本测试只断言裁剪与不可逆集合，不依赖 schedule/monitor 服务的具体行为。
 */

const depsWith = (dir: string, extra: Partial<Parameters<typeof createTools>[0]> = {}) => {
  const memoryFile = join(dir, "memory.json");
  const jobsFile = join(dir, "jobs.json");
  const actionsFile = join(dir, "actions.json");
  return {
    root: dir,
    memory: createMemoryService(createMemoryRepository(memoryFile)),
    jobs: createJobService(createJobRepository(jobsFile)),
    actions: createActionService(createActionRepository(actionsFile)),
    // 此处只需进入装配；后续测试只比对工具名称，不调用它们。
    monitors: {} as MonitorService,
    ...extra,
  };
};

test("subagent assembly excludes subagent/schedule/monitor/instructions and exposes no bash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-subagent-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 主代理父线程：拥有全部可裁剪能力，可与子代理注册结果做差集。
  const foreground = createTools(depsWith(dir)).map((tool) => tool.name);
  // 子代理装配：isSubagent=true 将 instructions/schedule/monitor 一并裁掉；
  // 写文件仍依赖 actions 形成的人工审批闸门（不能借此推断写路径扩大权限）。
  const subagent = createTools(depsWith(dir, { isSubagent: true })).map((tool) => tool.name);
  // 子代理不暴露任何扩张副作用或会话专属能力；bash 从未进入注册表。
  for (const blocked of ["subagent", "schedule", "monitor", "instructions", "bash"]) {
    assert.ok(!subagent.includes(blocked), `subagent must not expose ${blocked}`);
    if (blocked === "bash") {
      assert.ok(!foreground.includes("bash"), "mainline must never expose bash");
    }
  }
  // 子代理可见集合等价于 mainline 减去被裁剪的能力：
  // `subagent` 工具由 session factory 的扩展单独挂载，不进入 createTools。
  assert.deepEqual(
    subagent,
    foreground.filter((name) => !["schedule", "monitor", "instructions"].includes(name)),
  );
  // 写工具与读工具都保留：写仍受 actions 审批控制。
  assert.ok(subagent.includes("write") && subagent.includes("edit"));
  for (const reader of ["read", "grep", "find", "ls", "memory", "currentTime"]) {
    assert.ok(subagent.includes(reader), `subagent must keep ${reader}`);
  }
});
