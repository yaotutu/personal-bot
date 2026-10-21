/**
 * 审批存储 schema 与 repository 测试：只覆盖 storage 域自身（reader 与文件边界）。
 *
 * 不触碰 HTTP/服务/pi；不 mock 算法。验证事项：
 * - 必填关联字段（threadId/runId/toolCallId/subagentId/workspaceSpaceId/activityId）
 *   必须是 string|null，缺省视为损坏；pending 必须 resolvedAt/decidedAt 全为 null；
 *   终态必须 resolvedAt 是合法日期；只有 approved/denied 才允许 decidedAt；
 * - execution 字段只在 status==='approved' 上合法；status 枚举合法；
 *   running/unknown 强制 finishedAt=null；其他终态 finishedAt 是合法日期；
 *   result 是字符串或 null；
 * - repository 在损坏文件上拒绝读、改、并发写都不能静默修复或截断文件。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { InvalidDocumentError, readActionsDocument } from "../../src/adapters/storage/document-schemas.js";
import type { PendingAction } from "../../src/features/actions/types.js";

const at = "2026-10-19T00:00:00.000Z";

/** 构造测试用 PendingAction：默认 pending，所有 nullable 字段置 null。 */
const record = (changes: Partial<PendingAction> = {}): PendingAction => ({
  id: "approval-1",
  kind: "file_write",
  title: "Write draft",
  payload: { path: "draft.md", content: "after" },
  status: "pending",
  revision: 1,
  createdAt: at,
  expiresAt: "2026-10-19T00:05:00.000Z",
  resolvedAt: null,
  decidedAt: null,
  spaceId: null,
  runId: null,
  toolCallId: null,
  subagentId: null,
  workspaceSpaceId: null,
  activityId: null,
  ...changes,
});

test("action document accepts valid pending and terminal records including execution on approved", () => {
  const valid: PendingAction[] = [record()];

  // 四种 human/auto 终态：除 approved/denied 之外 decidedAt 必须为 null。
  for (const status of ["approved", "denied", "expired", "cancelled"] as const) {
    const decidedAt = status === "approved" || status === "denied" ? at : null;
    valid.push(record({
      id: `terminal-${status}`,
      status,
      revision: 2,
      resolvedAt: at,
      decidedAt,
    }));
  }

  // execution 仅允许挂在 approved 上：每个 status 都验证一遍。
  for (const status of ["running", "succeeded", "failed", "cancelled", "unknown"] as const) {
    valid.push(record({
      id: `execution-${status}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: {
        status,
        startedAt: at,
        // 仍在执行或中断后无法确认：finishedAt 必为 null；终态则必须是合法日期。
        finishedAt: status === "running" || status === "unknown" ? null : at,
        // 进行中的结果必为 null；已终态则允许任意字符串摘要（含 null 表示无附加信息）。
        result: status === "running" ? null : "Recorded outcome",
      },
    }));
  }

  assert.deepEqual(readActionsDocument(valid), valid);
  assert.deepEqual(readActionsDocument([]), []);

  // 文件不存在/不可读语义由 repository 处理；reader 接受裸数组。
  const ok = readActionsDocument(valid);
  assert.equal(ok.length, valid.length);
});

test("action document rejects records missing mandatory nullable context fields or breaking status/time invariants", () => {
  const invalid: unknown[] = [
    {},
    { schemaVersion: 1, actions: [] },
    // 缺 createdAt / expiresAt
    [record({ createdAt: undefined as unknown as string })],
    [record({ expiresAt: "not-a-date" })],
    [record({ expiresAt: "2026-10-19" })], // 只有日期、无时间部分：canonical ISO 失效
    // pending 上不应有 decidedAt / resolvedAt
    [record({ decidedAt: at })],
    // 终态但缺 resolvedAt
    [record({ status: "approved" })],
    // denied/approved 缺 decidedAt 等于人工决定缺失
    [record({ status: "denied", decidedAt: "invalid" })],
    // payload 不是字符串键值
    [record({ payload: { content: 42 } as unknown as Record<string, string> })],
    // 必填关联字段类型非法
    [record({ spaceId: 42 as unknown as string | null })],
    [record({ runId: 42 as unknown as string | null })],
    [record({ toolCallId: 42 as unknown as string | null })],
    [record({ subagentId: 42 as unknown as string | null })],
    [record({ workspaceSpaceId: 42 as unknown as string | null })],
    [record({ activityId: 42 as unknown as string | null })],
  ];

  for (const value of invalid) {
    assert.throws(() => readActionsDocument(value), InvalidDocumentError, `expected reject: ${JSON.stringify(value)}`);
  }
});

test("action document allows execution only on approved status with valid started/finished/result invariants", () => {
  // execution 挂在非 approved 上：必须被 reader 拒绝，避免把执行事实误标为批准。
  for (const status of ["pending", "denied", "expired", "cancelled"] as const) {
    // pending 没有 decidedAt；denied 有人工决定需要 decidedAt；expired/cancelled 都保持 null。
    const decidedAt = status === "denied" ? at : null;
    const bogus = record({
      id: `on-${status}`,
      status,
      resolvedAt: status === "pending" ? null : at,
      decidedAt,
      execution: { status: "succeeded", startedAt: at, finishedAt: at, result: "ok" },
    });
    assert.throws(() => readActionsDocument([bogus]), InvalidDocumentError, `${status} must not carry execution`);
  }

  // execution 自身形状：状态枚举、startedAt 必为 ISO，finishedAt/null 约束，result 字符串或 null。
  const invalidExecution = [
    { status: "success", startedAt: at, finishedAt: at, result: "wrong status" },
    { status: "running", startedAt: at, finishedAt: at, result: null },
    { status: "running", startedAt: at, finishedAt: null, result: "not complete" },
    { status: "failed", startedAt: "invalid", finishedAt: at, result: "failed" },
    { status: "succeeded", startedAt: at, finishedAt: null, result: "not recorded" },
    { status: "unknown", startedAt: at, result: "missing finish field" },
  ];
  for (const execution of invalidExecution) {
    const bogus = record({
      id: `bad-exec-${(execution.status ?? "unknown").replace(/\W+/g, "_")}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: execution as unknown as PendingAction["execution"],
    });
    assert.throws(() => readActionsDocument([bogus]), InvalidDocumentError, `bad execution: ${JSON.stringify(execution)}`);
  }

  // running / unknown 必须 finishedAt=null；非空字符串视为损坏。
  for (const status of ["running", "unknown"] as const) {
    const bogus = record({
      id: `running-${status}`,
      status: "approved",
      revision: 3,
      resolvedAt: at,
      decidedAt: at,
      execution: {
        status,
        startedAt: at,
        finishedAt: "2026-10-19T00:01:00.000Z", // 必须为 null
        result: status === "running" ? null : "verify manually",
      },
    });
    assert.throws(() => readActionsDocument([bogus]), InvalidDocumentError, `${status} must keep finishedAt null`);
  }
});

test("approval repository rejects an invalid record without truncating, rewriting or repairing its document", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "approval-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "actions.json");
  const repository = createActionRepository(file);
  assert.deepEqual(await repository.read(), []);
  await assert.rejects(stat(file), { code: "ENOENT" });

  // 任一种坏文件：read/update 都必须立刻报错且不修改文件。
  const cases: string[] = [
    "{broken-json",
    JSON.stringify([record(), record({ id: "bad", status: "denied" })]),
    JSON.stringify([record(), { ...record({ id: "bad" }), payload: { content: 123 } }]),
    JSON.stringify([{ ...record({ status: "approved", decidedAt: at }), execution: { status: "succeeded" } }]),
    JSON.stringify([{ ...record({ id: "exec-on-pending" }), execution: { status: "running", startedAt: at, finishedAt: null, result: null } }]),
  ];
  for (const damaged of cases) {
    await writeFile(file, damaged, { mode: 0o600 });
    await assert.rejects(repository.read(), InvalidDocumentError, "damaged doc must throw on read");
    await assert.rejects(
      repository.update((items) => ({ items: [...items, record()], result: undefined })),
      InvalidDocumentError,
      "damaged doc must throw on update",
    );
    // 文件保持原样：拒绝时不悄悄重写或截断损坏内容。
    assert.equal(await readFile(file, "utf8"), damaged);
  }

  // 修复后写队列仍然可用。
  await writeFile(file, JSON.stringify([record()]), { mode: 0o600 });
  await repository.update((items) => ({ items: [...items, record({ id: "next" })], result: undefined }));
  assert.equal((await repository.read()).length, 2);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("approval repository round-trips records with execution by parsing and preserving the execution block", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "approval-storage-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "actions.json");
  const repository = createActionRepository(file);

  const withExecution = record({
    id: "approved-executed",
    status: "approved",
    revision: 3,
    resolvedAt: at,
    decidedAt: at,
    execution: { status: "succeeded", startedAt: at, finishedAt: at, result: "ok" },
  });

  await repository.update((items) => ({ items: [withExecution], result: undefined }));
  const read = await repository.read();
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], withExecution);
  // 多次读取不会改写文件内容（除时间戳/mtime 外）。
  await repository.read();
  assert.equal((await repository.read()).length, 1);
  assert.deepEqual((await repository.read())[0].execution, withExecution.execution);
});
