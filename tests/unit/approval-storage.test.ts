import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { InvalidDocumentError, readActionsDocument } from "../../src/adapters/storage/document-schemas.js";
import type { PendingAction } from "../../src/features/actions/types.js";

const at = "2026-10-19T00:00:00.000Z";
const record = (changes: Partial<PendingAction> = {}): PendingAction => ({
  id: "approval-1", kind: "file_write", title: "Write draft",
  payload: { path: "draft.md", originalContent: "before", content: "after", baseVersion: "version-1" },
  status: "pending", createdAt: at, expiresAt: "2026-10-19T00:05:00.000Z", ...changes,
});

test("approval document validates full previews, decision times and independent execution receipts", () => {
  const valid: PendingAction[] = [record()];
  for (const status of ["approved", "denied", "expired", "cancelled"] as const)
    valid.push(record({ id: status, status, decidedAt: at }));
  for (const status of ["running", "succeeded", "failed", "cancelled", "unknown"] as const)
    valid.push(record({
      id: `execution-${status}`, status: "approved", decidedAt: at,
      execution: { status, startedAt: at, finishedAt: status === "running" || status === "unknown" ? null : at, result: status === "running" ? null : "Recorded outcome" },
    }));
  assert.deepEqual(readActionsDocument(valid), valid);
  assert.deepEqual(readActionsDocument([]), []);

  const invalid: unknown[] = [
    {}, { schemaVersion: 1, actions: [] },
    [record({ createdAt: undefined } as unknown as Partial<PendingAction>)],
    [record({ expiresAt: "not-a-date" })],
    [record({ createdAt: "2026-10-19" })],
    [record({ decidedAt: at })],
    [record({ status: "approved" })],
    [record({ status: "denied", decidedAt: "invalid" })],
    [record({ payload: { content: 42 } as unknown as Record<string, string> })],
    [record({ threadId: 42 } as unknown as Partial<PendingAction>)],
    [record({ execution: { status: "running", startedAt: at, finishedAt: null, result: null } })],
    [record({ status: "approved", decidedAt: at, execution: null } as unknown as Partial<PendingAction>)],
  ];
  for (const execution of [
    { status: "success", startedAt: at, finishedAt: at, result: "wrong status" },
    { status: "running", startedAt: at, finishedAt: at, result: null },
    { status: "running", startedAt: at, finishedAt: null, result: "not complete" },
    { status: "failed", startedAt: "invalid", finishedAt: at, result: "failed" },
    { status: "succeeded", startedAt: at, finishedAt: null, result: "not recorded" },
    { status: "unknown", startedAt: at, result: "missing finish field" },
  ]) invalid.push([{ ...record({ status: "approved", decidedAt: at }), execution }]);
  for (const value of invalid) assert.throws(() => readActionsDocument(value), InvalidDocumentError);
});

test("approval repository rejects an invalid record without truncating, rewriting or repairing its document", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "approval-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "actions.json");
  const repository = createActionRepository(file);
  assert.deepEqual(await repository.read(), []);
  await assert.rejects(stat(file), { code: "ENOENT" });

  for (const damaged of [
    "{broken-json",
    JSON.stringify([record(), record({ id: "bad", status: "denied" })]),
    JSON.stringify([record(), { ...record({ id: "bad" }), payload: { content: 123 } }]),
    JSON.stringify([{ ...record({ status: "approved", decidedAt: at }), execution: { status: "succeeded" } }]),
  ]) {
    await writeFile(file, damaged, { mode: 0o600 });
    await assert.rejects(repository.read(), InvalidDocumentError);
    await assert.rejects(repository.update((items) => ({ items: [...items, record()], result: undefined })), InvalidDocumentError);
    assert.equal(await readFile(file, "utf8"), damaged);
  }

  // 修复必须由调用方显式提供合法原件，失败写队列仍能接纳后续操作。
  await writeFile(file, JSON.stringify([record()]), { mode: 0o600 });
  await repository.update((items) => ({ items: [...items, record({ id: "new" })], result: undefined }));
  assert.equal((await repository.read()).length, 2);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
