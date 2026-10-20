import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createDataLayout,
  threadDreamFile,
  threadInstructionsFile,
  threadSessionsDir,
} from "../../src/adapters/storage/data-layout.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { createDreamRepository } from "../../src/adapters/storage/dream-repository.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { readProfileFile, writeProfileFile } from "../../src/adapters/storage/profile-files.js";
import {
  readThreadInstructions,
  writeThreadInstructions,
} from "../../src/adapters/storage/thread-instructions.js";
import {
  buildDreamInput,
  composePrompt,
  DEFAULT_DREAM_PROMPT,
  fixedRules,
  INSTRUCTIONS_LIMIT,
} from "../../src/features/dream/prompt.js";
import {
  appendInstructions,
  parseProposal,
  planProposal,
} from "../../src/features/dream/proposal.js";
import { purposeChanged, readPurpose, withPurpose } from "../../src/features/dream/purpose.js";
import { createDreamScheduler } from "../../src/features/dream/scheduler.js";
import { createDreamService } from "../../src/features/dream/service.js";
import { BATCH_CHARS, sliceWindow, splitBatches } from "../../src/features/dream/window.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";

const setup = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-dream-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = createDataLayout(dir);
  await mkdir(threadSessionsDir(layout, "local-main"), { recursive: true, mode: 0o700 });
  const memoryRepo = createMemoryRepository(layout.memoryFile);
  const memory = createMemoryService(memoryRepo);
  const identity = createIdentityService(memoryRepo, {
    read: (which) => readProfileFile(which === "soul" ? layout.soulFile : layout.userFile),
    write: (which, content, expected) =>
      writeProfileFile(which === "soul" ? layout.soulFile : layout.userFile, content, expected),
  });
  const repository = createDreamRepository(layout);
  return { dir, layout, memory, identity, repository };
};

test("sliceWindow and splitBatches keep 4k-token overlap across runs and batches", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m-${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `message-${i}-` + "x".repeat(3500),
  }));
  const first = sliceWindow(messages.slice(0, 5), undefined, "compaction summary");
  assert.equal(first.context.length, 0);
  assert.equal(first.fresh.length, 5);
  assert.equal(first.lastId, "m-4");

  // 第二次从 m-4 游标继续：m-4 之前的尾部进入 context，m-5..m-9 进入 fresh。
  const second = sliceWindow(messages, "m-4", "compaction summary");
  assert.ok(second.context.length >= 1 && second.context.length < 5);
  assert.equal(second.context.at(-1)?.id, "m-4");
  assert.deepEqual(second.fresh.map((m) => m.id), ["m-5", "m-6", "m-7", "m-8", "m-9"]);
  assert.equal(second.lastId, "m-9");

  // 游标若因会话重置不存在，回退为从头整理，不静默丢消息。
  const reset = sliceWindow(messages.slice(0, 3), "unknown-cursor");
  assert.equal(reset.fresh.length, 3);

  // 超大批次拆分：后一批 context 取前一批尾部，保持批间重叠。
  const huge = sliceWindow(
    Array.from({ length: 6 }, (_, i) => ({
      id: `big-${i}`,
      role: "user" as const,
      text: "y".repeat(Math.floor(BATCH_CHARS / 2)),
    })),
    undefined,
  );
  const batches = splitBatches(huge);
  assert.ok(batches.length >= 2);
  assert.equal(batches[1]!.context.at(-1)?.id, batches[0]!.fresh.at(-1)?.id);
});

test("purpose helpers and proposal planner enforce session purpose, length limit and non-main routing", () => {
  const formatted = withPurpose("Always sign as Alex.", "处理客户邮件");
  assert.equal(readPurpose(formatted), "处理客户邮件");
  assert.equal(purposeChanged(formatted, formatted + "\nUse formal tone."), false);
  assert.equal(purposeChanged(formatted, "## 会话用途\n被篡改的用途\n\nAlways sign as Alex."), true);

  const parsed = parseProposal({
    changes: [
      { target: "user", text: "喜欢美式咖啡", source: "m1" },
      { target: "soul", text: "回答简短", source: "m1" },
      { target: "instructions", text: "邮件末尾加签名", source: "m2" },
      { target: "memory", op: "add", text: "项目代号 Aurora", source: "m2" },
      { target: "memory", op: "edit", id: "missing-id", text: "bad", source: "m2" },
      { target: "pending", suggestedTarget: "memory", text: "不确定归属", source: "m3" },
    ],
  });
  assert.ok(parsed);

  // 非主会话：USER/SOUL 直接降级为 pending(global_from_session)，不直接写全局文件。
  const nonMainPlan = planProposal(parsed, {
    isMain: false,
    hasPurpose: true,
    existingMemoryIds: new Set(),
    instructions: formatted,
  });
  assert.deepEqual(
    nonMainPlan.apply.map((c) => c.target),
    ["instructions", "memory"],
  );
  assert.deepEqual(
    nonMainPlan.pending.map((p) => [p.suggestedTarget, p.reason]),
    [
      ["user", "global_from_session"],
      ["soul", "global_from_session"],
      ["memory", "ambiguous"],
    ],
  );
  assert.equal(nonMainPlan.rejected.length, 1);
  assert.equal(nonMainPlan.rejected[0]?.reason, "unknown memory id");

  // 未声明会话用途时，instructions 建议降级为 pending(no_purpose)。
  const noPurposePlan = planProposal(
    [{ target: "instructions", text: "rule", source: "m1" }],
    { isMain: true, hasPurpose: false, existingMemoryIds: new Set(), instructions: "" },
  );
  assert.equal(noPurposePlan.apply.length, 0);
  assert.equal(noPurposePlan.pending[0]?.reason, "no_purpose");

  // 超出 2000 字上限的指令修改被拒绝。
  const overLimitPlan = planProposal(
    [{ target: "instructions", text: "x".repeat(INSTRUCTIONS_LIMIT), source: "m1" }],
    { isMain: true, hasPurpose: true, existingMemoryIds: new Set(), instructions: formatted },
  );
  assert.equal(overLimitPlan.apply.length, 0);
  assert.equal(overLimitPlan.rejected[0]?.reason, "instructions too long");

  // 行级去重：重复追加同一句不会膨胀文本。
  const once = appendInstructions(formatted, "邮件末尾加签名");
  assert.equal(appendInstructions(once, "邮件末尾加签名"), once);
});

test("prompt composer keeps fixed safety rules regardless of global inheritance", () => {
  assert.equal(
    composePrompt({ global: "", session: "", inherit: true }),
    DEFAULT_DREAM_PROMPT,
  );
  assert.match(
    composePrompt({ global: "GLOBAL", session: "SESSION", inherit: true }),
    /GLOBAL[\s\S]*Extra guidance[\s\S]*SESSION/,
  );
  assert.equal(
    composePrompt({ global: "GLOBAL", session: "SESSION", inherit: false }),
    "SESSION",
  );
  const rules = fixedRules("处理邮件", false);
  assert.match(rules, /Never save credentials/);
  assert.match(rules, /target=pending, never a direct write/);
  const input = buildDreamInput(
    {
      summary: "summary-text",
      context: [{ id: "c1", role: "user", text: "old" }],
      fresh: [{ id: "f1", role: "user", text: "new" }],
      lastId: "f1",
    },
    { user: "u", soul: "s", instructions: "i", memories: [{ id: "m1", text: "fact" }] },
  );
  assert.match(input, /Earlier context \(already processed; do not extract from it\)/);
  assert.match(input, /New messages \(extract from these\)/);
});

test("profile files and dream repository enforce strict validation, conditional writes and startup reconciliation", async (t) => {
  const { layout, repository } = await setup(t);
  // 1. 仅缺失返回默认，目录当作文件读取必须抛 EISDIR，不伪装成空串。
  assert.equal(await readProfileFile(layout.userFile), "");
  await assert.rejects(readProfileFile(layout.sessionsDir), { code: "EISDIR" });

  // 2. 条件写入：版本匹配才写，版本不匹配返回 false 且保留用户新内容。
  assert.equal(await writeProfileFile(layout.userFile, "v1", ""), true);
  assert.equal(await writeProfileFile(layout.userFile, "stale-dream", ""), false);
  assert.equal(await readProfileFile(layout.userFile), "v1");
  const instFile = threadInstructionsFile(layout, "local-main");
  assert.equal(await writeThreadInstructions(instFile, "inst-v1", ""), true);
  assert.equal(await writeThreadInstructions(instFile, "stale", ""), false);
  assert.equal(await readThreadInstructions(instFile), "inst-v1");

  // 3. dream.json 默认值：local-main 默认开启，其余会话默认关闭，GET 不落盘。
  assert.equal((await repository.read("local-main")).enabled, true);
  assert.equal((await repository.read("other-thread")).enabled, false);
  await assert.rejects(stat(threadDreamFile(layout, "other-thread")), { code: "ENOENT" });

  // 4. 损坏或带 schemaVersion 的 dream.json 必须抛 InvalidDocumentError("dream")。
  const dreamFile = threadDreamFile(layout, "local-main");
  for (const bad of [
    "{broken",
    '{"enabled":true,"inheritGlobalPrompt":true,"pending":[],"schemaVersion":1}',
    '{"enabled":true,"inheritGlobalPrompt":true,"pending":[],"extra":1}',
    '{"enabled":"yes","inheritGlobalPrompt":true,"pending":[]}',
  ]) {
    await writeFile(dreamFile, bad);
    await assert.rejects(repository.read("local-main"), InvalidDocumentError);
    assert.equal(await readFile(dreamFile, "utf8"), bad);
  }

  // 5. 启动校准：崩溃遗留的 running 诚实标记为 failed。
  await writeFile(
    dreamFile,
    JSON.stringify({
      enabled: true,
      inheritGlobalPrompt: true,
      lastRun: {
        at: "2026-10-20T00:00:00.000Z",
        status: "running",
        changed: [],
        processed: 2,
      },
      pending: [],
    }),
  );
  await repository.reconcileOnStart();
  const reconciled = await repository.read("local-main");
  assert.equal(reconciled.lastRun?.status, "failed");
  assert.match(reconciled.lastRun?.error ?? "", /Interrupted by service restart/);
});

test("DreamService skips overwriting concurrently edited files, keeps cursor on partial failure and resolves pending items", async (t) => {
  const { layout, memory, identity, repository } = await setup(t);
  await mkdir(threadSessionsDir(layout, "work-mail"), { recursive: true, mode: 0o700 });
  await writeThreadInstructions(
    threadInstructionsFile(layout, "work-mail"),
    withPurpose("Keep replies brief.", "处理工作邮件"),
  );

  let concurrentUserEdit = false;
  const service = createDreamService({
    repository,
    notes: {
      readUser: () => readProfileFile(layout.userFile),
      writeUser: async (content) => {
        await identity.saveProfile({ user: content });
      },
      writeUserIfUnchanged: async (content, expected) => {
        if (concurrentUserEdit) {
          await writeProfileFile(layout.userFile, "USER-CONCURRENT-EDIT");
        }
        return identity.writeIfUnchanged("user", content, expected);
      },
      readSoul: () => readProfileFile(layout.soulFile),
      writeSoul: async (content) => {
        await identity.saveProfile({ soul: content });
      },
      writeSoulIfUnchanged: (content, expected) =>
        identity.writeIfUnchanged("soul", content, expected),
      readInstructions: (id) => readThreadInstructions(threadInstructionsFile(layout, id)),
      writeInstructions: async (id, content) => {
        await writeThreadInstructions(threadInstructionsFile(layout, id), content);
      },
      writeInstructionsIfUnchanged: (id, content, expected) =>
        writeThreadInstructions(threadInstructionsFile(layout, id), content, expected),
    },
    memory,
    conversations: {
      listThreadIds: async () => ["local-main", "work-mail"],
      threadExists: async (id) => id === "local-main" || id === "work-mail",
      isThreadBusy: async () => false,
      readTranscript: async (id) => ({
        messages: [{ id: `${id}-m1`, role: "user", text: "hello" }],
      }),
    },
    propose: async () => ({
      ok: true,
      changes: [
        { target: "user", text: "喜欢乌龙茶", source: "m1" },
        { target: "instructions", text: "统一使用中文回复", source: "m1" },
        { target: "memory", op: "add", text: "常用邮箱 work@example.com", source: "m1" },
      ],
    }),
  });

  // 1. 非主会话 work-mail：instructions 与 memory 直接落盘，user 建议进入 pending，不改全局 USER.md。
  const mailRun = await service.runNow("work-mail");
  assert.equal(mailRun.ok, true);
  if (mailRun.ok) {
    assert.equal(mailRun.state.lastRun?.status, "completed");
    assert.equal(mailRun.state.cursor, "work-mail-m1");
    assert.equal(mailRun.state.pending.length, 1);
    assert.equal(mailRun.state.pending[0]?.reason, "global_from_session");
  }
  assert.equal(await readProfileFile(layout.userFile), "");
  assert.match(
    await readThreadInstructions(threadInstructionsFile(layout, "work-mail")),
    /统一使用中文回复/,
  );
  assert.equal((await memory.list()).length, 1);

  // 2. 用户在页面确认该条 pending 写入 USER.md。
  const pendingId = mailRun.ok ? mailRun.state.pending[0]!.id : "";
  const resolved = await service.resolvePending("work-mail", pendingId, {
    action: "apply",
    target: "user",
  });
  assert.equal(resolved.ok, true);
  assert.equal(await readProfileFile(layout.userFile), "喜欢乌龙茶");

  // 3. 主会话整理期间用户在外部并发修改了 USER.md：不覆盖用户新内容，标记 partial 且不推进游标。
  await writeProfileFile(layout.userFile, "初始用户画像");
  concurrentUserEdit = true;
  const mainRun = await service.runNow("local-main");
  assert.equal(mainRun.ok, true);
  if (mainRun.ok) {
    assert.equal(mainRun.state.lastRun?.status, "partial");
    assert.equal(mainRun.state.cursor, undefined);
    assert.match(mainRun.state.lastRun?.error ?? "", /USER\.md was modified concurrently/);
  }
  assert.equal(await readProfileFile(layout.userFile), "USER-CONCURRENT-EDIT");

  const scheduler = createDreamScheduler(service, 60_000);
  scheduler.start();
  await scheduler.close();
});
