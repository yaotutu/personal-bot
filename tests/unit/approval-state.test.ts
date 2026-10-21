import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { InvalidDocumentError, readActionsDocument } from "../../src/adapters/storage/document-schemas.js";
import {
  ApprovalCapacityError,
  MAX_APPROVAL_BYTES,
  MAX_PENDING_APPROVALS,
  MAX_PENDING_APPROVAL_BYTES,
  createActionService,
} from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";

/**
 * 审批状态机单测：只覆盖 action 域自身（版本、终态、幂等、容量、持久通知和
 * schema 读取），不经过 HTTP/pi。文件提交与工具轮询的集成断言在
 * file-approval.test.ts；本文件不创建真实实例数据。
 */

/** 模拟真实 repository 的串行读改写与序列化隔离；失败由用例显式注入。 */
const memoryRepository = (initial: PendingAction[] = []): ActionRepository => {
  let items = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: async () => { await tail; return structuredClone(items); },
    update: <T>(change: (items: PendingAction[]) => { items?: PendingAction[]; result: T }) => {
      const result = tail.then(() => {
        const next = change(structuredClone(items));
        if (next.items) items = structuredClone(next.items);
        return next.result;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
};

const tempFile = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "approval-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "actions.json") };
};

const fileBytes = async (file: string): Promise<string | null> => {
  try { return await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const utf8Bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const baseAction = (overrides: Record<string, unknown> = {}): PendingAction => ({
  id: "action-1",
  kind: "file_write",
  title: "写入 note.md",
  payload: { path: "note.md", content: "after", originalContent: "before", baseVersion: "v1", beforeExists: "true" },
  status: "pending",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:05:00.000Z",
  resolvedAt: null,
  decidedAt: null,
  spaceId: null,
  runId: null,
  toolCallId: null,
  subagentId: null,
  workspaceSpaceId: null,
  activityId: null,
  ...overrides,
});

test("pending starts at revision 1; approve settles at revision 2; replay is idempotent and opposite decisions conflict", async () => {
  let notifications = 0;
  const actions = createActionService(memoryRepository(), { onChange: () => { notifications++; } });

  const pending = await actions.submit("file_write", "写入 note.md", { path: "note.md", content: "after" });
  assert.equal(pending.status, "pending");
  assert.equal(pending.revision, 1);
  assert.equal(pending.resolvedAt, null);
  assert.equal(pending.decidedAt, null);
  assert.equal(notifications, 1);

  const approved = await actions.resolveDecision(pending.id, "approve");
  assert.equal(approved.ok, true);
  assert.equal(approved.code, undefined);
  assert.equal(approved.action?.status, "approved");
  assert.equal(approved.action?.revision, 2);
  assert.ok(approved.action?.resolvedAt);
  assert.equal(approved.action?.decidedAt, approved.action?.resolvedAt);
  assert.equal(notifications, 2);

  const stored = await actions.get(pending.id);
  assert.equal(stored?.status, "approved");
  assert.equal(stored?.revision, 2);
  assert.equal(stored?.resolvedAt, approved.action?.resolvedAt);
  assert.equal(stored?.decidedAt, approved.action?.decidedAt);

  // 相同决定重放：返回原记录，不推进 revision、不重复通知、不改写任何持久字段。
  const beforeReplay = await actions.get(pending.id);
  const replay = await actions.resolveDecision(pending.id, "approve");
  assert.equal(replay.ok, true);
  assert.equal(replay.action?.revision, 2);
  assert.equal(replay.action?.resolvedAt, approved.action?.resolvedAt);
  assert.equal(replay.action?.decidedAt, approved.action?.decidedAt);
  assert.deepEqual(await actions.get(pending.id), beforeReplay);
  assert.equal(notifications, 2);
  assert.equal((await actions.decide(pending.id, "approve"))?.revision, 2);

  // 相反决定是冲突而不是新的终态；兼容 decide 入口返回 undefined。
  const conflict = await actions.resolveDecision(pending.id, "deny");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "conflict");
  assert.equal(conflict.action?.status, "approved");
  assert.equal(conflict.action?.revision, 2);
  assert.equal(await actions.decide(pending.id, "deny"), undefined);
  assert.equal(notifications, 2);

  // deny 终态同样 revision 2，且 decidedAt 与 resolvedAt 一致。
  const deniedPending = await actions.submit("file_edit", "编辑 note.md", { path: "note.md" });
  const denied = await actions.resolveDecision(deniedPending.id, "deny");
  assert.equal(denied.ok, true);
  assert.equal(denied.action?.status, "denied");
  assert.equal(denied.action?.revision, 2);
  assert.ok(denied.action?.resolvedAt);
  assert.equal(denied.action?.decidedAt, denied.action?.resolvedAt);
  const deniedReplay = await actions.resolveDecision(deniedPending.id, "deny");
  assert.equal(deniedReplay.ok, true);
  assert.equal(deniedReplay.action?.revision, 2);
  assert.equal(notifications, 4);
});

test("unknown approvals resolve to not_found without notification or side effects", async () => {
  let notifications = 0;
  const actions = createActionService(memoryRepository(), { onChange: () => { notifications++; } });
  const result = await actions.resolveDecision("missing", "approve");
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_found");
  assert.equal(result.action, undefined);
  assert.equal(await actions.decide("missing", "deny"), undefined);
  assert.equal(notifications, 0);
  assert.deepEqual(await actions.history(), []);
});

test("expired, cancelled and cancelPending transitions persist resolvedAt but keep decidedAt null", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const notifications: PendingAction[] = [];
  const repository = memoryRepository();
  const actions = createActionService(repository, { onChange: (action) => { notifications.push(action); } });

  const expiring = await actions.submit("file_write", "expire me", {}, { timeoutMs: 10 });
  t.mock.timers.tick(10);

  // 决定入口在同一个 update 内发现过期：先持久化 expired，再以 conflict 返回。
  const late = await actions.resolveDecision(expiring.id, "approve");
  assert.equal(late.ok, false);
  assert.equal(late.code, "conflict");
  assert.equal(late.action?.status, "expired");
  assert.equal(late.action?.revision, 2);
  assert.equal(late.action?.resolvedAt, new Date(1_010).toISOString());
  assert.equal(late.action?.decidedAt, null);
  const expired = await actions.get(expiring.id);
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.revision, 2);
  assert.equal(expired?.decidedAt, null);
  assert.equal(notifications.at(-1)?.status, "expired");

  // expirePending 只迁移仍然 pending 且已过期的记录；重复调用不产生通知。
  const second = await actions.submit("file_edit", "expire later", {}, { timeoutMs: 10 });
  const beforeExpire = notifications.length;
  assert.equal(await actions.expirePending(), 0);
  assert.equal(notifications.length, beforeExpire);
  t.mock.timers.tick(10);
  assert.equal(await actions.expirePending(), 1);
  assert.equal(notifications.length, beforeExpire + 1);
  assert.equal(notifications.at(-1)?.id, second.id);
  assert.equal(notifications.at(-1)?.status, "expired");
  assert.equal(notifications.at(-1)?.revision, 2);
  assert.equal(notifications.at(-1)?.decidedAt, null);
  const secondExpired = await actions.get(second.id);
  assert.equal(secondExpired?.status, "expired");
  assert.equal(secondExpired?.decidedAt, null);
  assert.equal(await actions.expirePending(), 0);
  assert.equal(notifications.length, beforeExpire + 1);

  // 取消是终态但不是人工决定：resolvedAt 有值，decidedAt 保持 null。
  const cancelled = await actions.submit("file_write", "cancel me", {});
  const cancelNotifications = notifications.length;
  await actions.cancel(cancelled.id);
  const cancelledStored = await actions.get(cancelled.id);
  assert.equal(cancelledStored?.status, "cancelled");
  assert.equal(cancelledStored?.revision, 2);
  assert.ok(cancelledStored?.resolvedAt);
  assert.equal(cancelledStored?.decidedAt, null);
  assert.equal(notifications.length, cancelNotifications + 1);
  await actions.cancel(cancelled.id);
  assert.equal(notifications.length, cancelNotifications + 1);
  assert.equal((await actions.get(cancelled.id))?.revision, 2);

  // 启动清理批量撤销 pending，每个迁移都通知；第二次没有变化也不再通知。
  const firstPending = await actions.submit("file_write", "pending 1", {});
  const secondPending = await actions.submit("file_write", "pending 2", {});
  const beforeCancelPending = notifications.length;
  await actions.cancelPending();
  assert.equal(notifications.length, beforeCancelPending + 2);
  assert.deepEqual(notifications.slice(-2).map((action) => [action.id, action.status, action.revision, action.decidedAt]), [
    [firstPending.id, "cancelled", 2, null],
    [secondPending.id, "cancelled", 2, null],
  ]);
  for (const id of [firstPending.id, secondPending.id]) {
    const storedPending = await actions.get(id);
    assert.equal(storedPending?.status, "cancelled");
    assert.ok(storedPending?.resolvedAt);
    assert.equal(storedPending?.decidedAt, null);
  }
  await actions.cancelPending();
  assert.equal(notifications.length, beforeCancelPending + 2);

  // 新服务实例从同一 repository 读到的已是持久化终态，而不是内存临时判断。
  const restarted = createActionService(repository);
  assert.equal((await restarted.get(firstPending.id))?.status, "cancelled");
  assert.equal((await restarted.get(secondPending.id))?.status, "cancelled");
  assert.equal((await restarted.get(second.id))?.status, "expired");
  assert.equal((await restarted.get(second.id))?.decidedAt, null);

  // poll 也必须在同一更新中持久化过期，而不是只在返回值里报告。
  const polled = await actions.submit("file_write", "poll me", {}, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.deepEqual(await actions.poll(polled.id), { status: "expired" });
  const polledStored = await actions.get(polled.id);
  assert.equal(polledStored?.status, "expired");
  assert.equal(polledStored?.revision, 2);
  assert.equal(polledStored?.decidedAt, null);
});

test("snapshotPending filters expired records without writing or notifying", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  let notifications = 0;
  const actions = createActionService(memoryRepository(), { onChange: () => { notifications++; } });
  const expiring = await actions.submit("file_write", "expire", {}, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  const beforeRead = notifications;
  assert.deepEqual(await actions.snapshotPending(), []);
  assert.deepEqual(await actions.get(expiring.id), { ...expiring, status: "pending" });
  assert.equal(notifications, beforeRead);
  // 读取路径不写盘；只有显式 expirePending 才迁移状态。
  assert.equal((await actions.history())[0].status, "pending");
  assert.equal(await actions.expirePending(), 1);
  assert.equal(notifications, beforeRead + 1);
});

test("capacity rejects oversized, over-count and over-accumulated submissions without changing the repository", async (t) => {
  // 单项超过 1.5MB：拒绝且不写任何内容。
  {
    const { file } = await tempFile(t);
    const actions = createActionService(createActionRepository(file));
    const baseline = await actions.submit("file_write", "baseline", { path: "baseline" });
    const before = await readFile(file, "utf8");
    await assert.rejects(
      actions.submit("file_write", "too large", { content: "x".repeat(MAX_APPROVAL_BYTES) }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalCapacityError);
        assert.equal(error.message, "Approval capacity exceeded; the request was not recorded.");
        // 固定文案不能回显标题或正文片段。
        assert.equal(error.message.includes("too large"), false);
        assert.equal(error.message.includes("xxxxx"), false);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual((await actions.history()).map((action) => action.id), [baseline.id]);
  }

  // pending 数量上限 32：第 33 项拒绝，已有 32 项和文件字节保持不变。
  {
    const { file } = await tempFile(t);
    const actions = createActionService(createActionRepository(file));
    const accepted: PendingAction[] = [];
    for (let index = 0; index < MAX_PENDING_APPROVALS; index++)
      accepted.push(await actions.submit("file_write", `pending-${index}`, { index: String(index) }));
    const before = await readFile(file, "utf8");
    await assert.rejects(actions.submit("file_write", "one too many", {}), ApprovalCapacityError);
    assert.equal(await readFile(file, "utf8"), before);
    const history = await actions.history();
    assert.equal(history.length, MAX_PENDING_APPROVALS);
    assert.deepEqual(history.map((action) => action.id), accepted.map((action) => action.id));
  }

  // pending 累计超过 6MB：4 项约 5.8MB 可接受，第 5 项拒绝且不写盘。
  {
    const { file } = await tempFile(t);
    const actions = createActionService(createActionRepository(file));
    const payload = "x".repeat(1_450_000);
    const accepted: PendingAction[] = [];
    for (let index = 0; index < 4; index++) {
      const action = await actions.submit("file_write", `large-${index}`, { content: payload });
      assert.ok(utf8Bytes(action) <= MAX_APPROVAL_BYTES);
      accepted.push(action);
    }
    const acceptedBytes = accepted.reduce((total, action) => total + utf8Bytes(action), 0);
    assert.ok(acceptedBytes <= MAX_PENDING_APPROVAL_BYTES);
    const before = await readFile(file, "utf8");
    await assert.rejects(actions.submit("file_write", "over total", { content: payload }), ApprovalCapacityError);
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual((await actions.history()).map((action) => action.id), accepted.map((action) => action.id));
  }
});

test("terminal history is not trimmed after 100 records and remains in insertion order", async (t) => {
  const { file } = await tempFile(t);
  const actions = createActionService(createActionRepository(file));
  const created: PendingAction[] = [];
  // 每登记一条立即撤销，避免触发 pending 数量上限，同时形成已处理历史。
  for (let index = 0; index < 105; index++) {
    const action = await actions.submit("file_write", `record-${index}`, { index: String(index) });
    await actions.cancel(action.id);
    created.push(action);
  }

  const history = await actions.history();
  assert.equal(history.length, 105);
  assert.deepEqual(history.map((action) => action.title), created.map((action) => action.title));
  assert.deepEqual(history.map((action) => action.id), created.map((action) => action.id));
  assert.ok(history.every((action) => action.status === "cancelled" && action.revision === 2 && action.resolvedAt && action.decidedAt === null));

  // 追加新记录后旧记录仍然全部保留，不按时间或数量静默裁剪。
  const extra = await actions.submit("file_write", "record-105", { index: "105" });
  const afterAppend = await actions.history();
  assert.equal(afterAppend.length, 106);
  assert.equal(afterAppend.at(-1)?.id, extra.id);
  assert.deepEqual(afterAppend.slice(0, 105).map((action) => action.id), created.map((action) => action.id));
});

test("onChange observes the already-committed document state and callback failures cannot change results", async (t) => {
  const { file } = await tempFile(t);
  const seen: Array<{ id: string; status: string; revision: number; disk: PendingAction[] }> = [];
  const actions = createActionService(createActionRepository(file), {
    onChange: (action) => {
      // 通知在 repository 落盘之后同步发出；回调内直接读文件即可看到同一状态。
      const disk = JSON.parse(readFileSync(file, "utf8")) as PendingAction[];
      seen.push({ id: action.id, status: action.status, revision: action.revision, disk });
      // 修改收到的拷贝不能影响已持久化记录。
      action.status = "cancelled";
      action.payload.path = "mutated";
    },
  });

  const pending = await actions.submit("file_write", "durable", { path: "note.md" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, pending.id);
  assert.equal(seen[0].status, "pending");
  assert.equal(seen[0].revision, 1);
  assert.deepEqual(seen[0].disk.map((action) => [action.id, action.status, action.revision]), [[pending.id, "pending", 1]]);

  const approved = await actions.resolveDecision(pending.id, "approve");
  assert.equal(approved.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].status, "approved");
  assert.equal(seen[1].revision, 2);
  assert.deepEqual(seen[1].disk.map((action) => [action.id, action.status, action.revision, action.decidedAt]), [
    [pending.id, "approved", 2, approved.action?.decidedAt],
  ]);
  const stored = await actions.get(pending.id);
  assert.equal(stored?.status, "approved");
  assert.equal(stored?.payload.path, "note.md");
});

test("a failed repository commit does not notify or leave a document", async (t) => {
  const { directory } = await tempFile(t);
  let notifications = 0;
  const missingParent = join(directory, "missing", "actions.json");
  const actions = createActionService(createActionRepository(missingParent), { onChange: () => { notifications++; } });
  await assert.rejects(actions.submit("file_write", "cannot commit", {}), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
  assert.equal(notifications, 0);
  assert.equal(await fileBytes(missingParent), null);
});

test("synchronous throws and rejected promises from onChange are isolated from committed state", async () => {
  let calls = 0;
  const actions = createActionService(memoryRepository(), {
    onChange: () => {
      calls++;
      if (calls === 1) throw new Error("synchronous notification failure");
      if (calls === 2) return Promise.reject(new Error("asynchronous notification failure"));
    },
  });

  const pending = await actions.submit("file_write", "first", {});
  assert.equal(pending.status, "pending");
  assert.equal(calls, 1);

  const approved = await actions.resolveDecision(pending.id, "approve");
  assert.equal(approved.ok, true);
  assert.equal(approved.action?.status, "approved");
  assert.equal(calls, 2);

  // 让被隔离的 rejected Promise 走完微任务，确认没有未处理拒绝影响后续操作。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await actions.get(pending.id))?.status, "approved");

  const second = await actions.submit("file_write", "second", {});
  assert.equal(second.revision, 1);
  assert.equal((await actions.history()).length, 2);
});

test("actions reader accepts only current records with required revision and consistent terminal timestamps", () => {
  const pending = baseAction();
  assert.deepEqual(readActionsDocument([pending]), [pending]);

  const terminal = baseAction({
    status: "approved",
    revision: 2,
    resolvedAt: "2026-01-01T00:01:00.000Z",
    decidedAt: "2026-01-01T00:01:00.000Z",
  });
  assert.deepEqual(readActionsDocument([terminal]), [terminal]);

  // 旧格式缺少新增字段：整体拒绝，不补默认值。
  const legacy = { ...pending } as Record<string, unknown>;
  for (const field of ["revision", "resolvedAt", "decidedAt", "spaceId", "runId", "toolCallId", "subagentId", "workspaceSpaceId", "activityId"]) {
    const missing = { ...legacy };
    delete missing[field];
    assert.throws(() => readActionsDocument([missing]), InvalidDocumentError, `missing ${field}`);
  }

  const invalid = [
    { ...pending, revision: 0 },
    { ...pending, revision: 1.5 },
    { ...pending, revision: "1" },
    // pending 不允许提前写入终态时间。
    { ...pending, resolvedAt: "2026-01-01T00:01:00.000Z" },
    { ...pending, decidedAt: "2026-01-01T00:01:00.000Z" },
    // 人工终态必须有 decidedAt，且 resolvedAt 必须合法。
    { ...terminal, decidedAt: null },
    { ...terminal, resolvedAt: null },
    { ...terminal, resolvedAt: "not-a-date" },
    // 过期/取消不是人的决定，decidedAt 必须保持 null。
    { ...pending, status: "expired", revision: 2, resolvedAt: "2026-01-01T00:01:00.000Z", decidedAt: "2026-01-01T00:01:00.000Z" },
    { ...pending, status: "cancelled", revision: 2, resolvedAt: "2026-01-01T00:01:00.000Z", decidedAt: "2026-01-01T00:01:00.000Z" },
    // 状态机之外的 kind/status/payload 同样失败关闭。
    { ...pending, kind: "shell" },
    { ...pending, status: "unknown" },
    { ...pending, payload: { path: 1 } },
  ];
  for (const record of invalid) assert.throws(() => readActionsDocument([record]), InvalidDocumentError);
});

test("actions repository rejects a legacy document without rewriting original bytes", async (t) => {
  const { file } = await tempFile(t);
  const { revision: _revision, resolvedAt: _resolvedAt, decidedAt: _decidedAt, ...legacy } = baseAction();
  const source = JSON.stringify([legacy], null, 2) + "\n";
  await writeFile(file, source);
  const repository = createActionRepository(file);
  await assert.rejects(repository.read(), InvalidDocumentError);
  let called = false;
  await assert.rejects(repository.update(() => {
    called = true;
    return { result: undefined };
  }), InvalidDocumentError);
  assert.equal(called, false);
  assert.equal(await readFile(file, "utf8"), source);
});
