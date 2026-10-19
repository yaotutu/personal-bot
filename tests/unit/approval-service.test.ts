import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionService } from "../../src/features/actions/action-service.js";
import type {
  ActionRepository,
  ApprovalChange,
  PendingAction,
} from "../../src/features/actions/types.js";

/**
 * 审批服务的纯单元测试：只使用内存 repository，验证真实的串行读改写语义，
 * 不触碰磁盘、真实实例或工具适配器。时间通过 node:test 的 Date mock 控制。
 */

type MemoryRepository = {
  repository: ActionRepository;
  failNextWrite: () => void;
};

/**
 * 与真实 JSON repository 对齐的最小内存实现：同一实例内串行读改写，
 * 每次读写都做结构化克隆，模拟“持久化结果与调用方对象隔离”的边界。
 * failNextWrite 只在真正提交（change 返回 items）时失败，用于验证写失败不发通知。
 */
const memoryRepository = (initial: PendingAction[] = []): MemoryRepository => {
  let items = structuredClone(initial);
  let tail: Promise<void> = Promise.resolve();
  let failNext = false;
  const repository: ActionRepository = {
    read: async () => {
      await tail;
      return structuredClone(items);
    },
    update: <T>(change: (current: PendingAction[]) => { items?: PendingAction[]; result: T }) => {
      const result = tail.then(() => {
        const next = change(structuredClone(items));
        // 未返回 items 表示纯查询/幂等重放，不产生提交，也不触发写失败。
        if (next.items === undefined) return next.result;
        if (failNext) {
          failNext = false;
          throw new Error("simulated write failure");
        }
        items = structuredClone(next.items);
        return next.result;
      });
      // 单个更新失败不能阻塞后续队列；错误仍原样抛给本次调用方。
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  return {
    repository,
    failNextWrite: () => { failNext = true; },
  };
};

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

/** 构造历史/重启测试所需的完整记录；默认是一条已批准、未过期的审批。 */
const record = (overrides: Partial<PendingAction> & Pick<PendingAction, "id">): PendingAction => ({
  kind: "file_write",
  title: "test approval",
  payload: { path: "note.txt", content: "content" },
  status: "approved",
  createdAt: iso(1_000),
  expiresAt: iso(10_000),
  ...overrides,
});

test("submitting after more than 100 settled approvals retains every record and payload without a time TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const events: ApprovalChange[] = [];
  actions.subscribe((change) => events.push(change));

  const expected = new Map<string, string>();
  for (let index = 0; index < 105; index += 1) {
    const content = `payload-${index}`;
    const action = await actions.submit(
      "file_write",
      `write ${index}`,
      { path: `file-${index}.txt`, content },
      { timeoutMs: 60_000 },
    );
    expected.set(action.id, content);
    assert.equal((await actions.decide(action.id, "approve")).ok, true);
  }
  const pending = await actions.submit(
    "file_edit",
    "pending edit",
    { path: "pending.txt", oldText: "a", newText: "b" },
    { timeoutMs: 10 },
  );

  const all = await actions.list();
  assert.equal(all.length, 106, "history must not be trimmed to a fixed count");
  assert.equal(all.filter((action) => action.status === "approved").length, 105);
  for (const action of all) {
    const content = expected.get(action.id);
    if (content !== undefined) assert.equal(action.payload.content, content);
  }

  // 没有任何后台定时器：时间越过 expiresAt 后记录仍是 pending，只有显式操作才改变状态。
  events.length = 0;
  t.mock.timers.tick(100_000);
  assert.equal(events.length, 0, "time passing alone must not notify or mutate");
  assert.equal((await actions.get(pending.id))?.status, "pending");
  assert.equal((await actions.list()).length, 106);
  assert.deepEqual(await actions.listPending(), [], "expired pending is not offered for approval");
  await actions.reconcileExpired();
  assert.equal((await actions.get(pending.id))?.status, "expired");
  assert.equal(events.length, 1);
});

test("history excludes pending and paginates equal decidedAt/id pairs without gaps or duplicates", async () => {
  const decidedAt = iso(5_000);
  const store = memoryRepository([
    record({ id: "a", status: "approved", decidedAt }),
    record({ id: "b", status: "denied", decidedAt }),
    record({ id: "c", status: "cancelled", decidedAt }),
    record({ id: "d", status: "expired", decidedAt }),
    record({ id: "e", status: "approved", decidedAt }),
    record({ id: "pending", status: "pending" }),
  ]);
  const actions = createActionService(store.repository);

  const first = await actions.history({ limit: 2 });
  assert.deepEqual(first.approvals.map((action) => action.id), ["e", "d"]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, { decidedAt, id: "d" });

  const second = await actions.history({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.approvals.map((action) => action.id), ["c", "b"]);
  assert.equal(second.hasMore, true);
  assert.deepEqual(second.nextCursor, { decidedAt, id: "b" });

  const third = await actions.history({ limit: 2, cursor: second.nextCursor! });
  assert.deepEqual(third.approvals.map((action) => action.id), ["a"]);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);

  const collected = [...first.approvals, ...second.approvals, ...third.approvals];
  assert.deepEqual(collected.map((action) => action.id), ["e", "d", "c", "b", "a"]);
  assert.equal(new Set(collected.map((action) => action.id)).size, collected.length);
  assert.ok(collected.every((action) => action.status !== "pending"));

  // 历史结果不是可回写存储的引用；修改返回值不能改变后续查询。
  collected[0].payload.content = "mutated";
  assert.equal((await actions.get("e"))?.payload.content, "content");
});

test("history rejects a settled approval without a valid decision time instead of inventing one", async () => {
  for (const decidedAt of [undefined, "not-a-date"]) {
    const actions = createActionService(memoryRepository([record({ id: "damaged", decidedAt })]).repository);
    await assert.rejects(actions.history({ limit: 20 }), /Invalid approval decision time/);
    await assert.rejects(actions.history({ limit: 20, threadId: "unrelated" }), /Invalid approval decision time/);
    assert.equal((await actions.get("damaged"))?.decidedAt, decidedAt);
  }
});

test("history applies status, thread and activity filters before cursor pagination", async () => {
  const store = memoryRepository([
    record({ id: "a1", status: "approved", decidedAt: iso(3_000), threadId: "thread-a", activityId: "act-1" }),
    record({ id: "a2", status: "denied", decidedAt: iso(2_000), threadId: "thread-a", activityId: "act-1" }),
    record({ id: "b1", status: "approved", decidedAt: iso(1_000), threadId: "thread-b", activityId: "act-2" }),
    record({ id: "p1", status: "pending", threadId: "thread-a", activityId: "act-1" }),
  ]);
  const actions = createActionService(store.repository);

  assert.deepEqual(
    (await actions.history({ limit: 10, threadId: "thread-a" })).approvals.map((action) => action.id),
    ["a1", "a2"],
  );
  assert.deepEqual(
    (await actions.history({ limit: 10, activityId: "act-2" })).approvals.map((action) => action.id),
    ["b1"],
  );
  assert.deepEqual(
    (await actions.history({ limit: 10, status: "approved" })).approvals.map((action) => action.id),
    ["a1", "b1"],
  );

  const first = await actions.history({ limit: 1, threadId: "thread-a" });
  assert.deepEqual(first.approvals.map((action) => action.id), ["a1"]);
  assert.equal(first.hasMore, true);
  const second = await actions.history({ limit: 1, threadId: "thread-a", cursor: first.nextCursor! });
  assert.deepEqual(second.approvals.map((action) => action.id), ["a2"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("decide is idempotent for the same decision, conflicts on opposite/settled states, and never revives expired or cancelled approvals", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const events: ApprovalChange[] = [];
  actions.subscribe((change) => events.push(change));

  const approved = await actions.submit("file_write", "approve me", { path: "a.txt", content: "a" }, { timeoutMs: 1_000 });
  const first = await actions.decide(approved.id, "approve");
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.approval.status, "approved");
  const decidedAt = (await actions.get(approved.id))!.decidedAt;
  assert.ok(decidedAt);
  assert.equal(events.length, 2, "submit and decide each notify once");

  // 同一决定重发是幂等成功，但不重新提交、不改变 decidedAt、不重复通知。
  const repeated = await actions.decide(approved.id, "approve");
  assert.equal(repeated.ok, true);
  assert.equal((await actions.get(approved.id))!.decidedAt, decidedAt);
  assert.equal(events.length, 2);

  const opposite = await actions.decide(approved.id, "deny");
  assert.equal(opposite.ok, false);
  if (!opposite.ok) assert.equal(opposite.code, "conflict");
  assert.equal((await actions.get(approved.id))!.status, "approved");

  const denied = await actions.submit("file_write", "deny me", { path: "b.txt", content: "b" });
  assert.equal((await actions.decide(denied.id, "deny")).ok, true);
  assert.equal((await actions.decide(denied.id, "deny")).ok, true);
  const deniedApprove = await actions.decide(denied.id, "approve");
  assert.equal(deniedApprove.ok, false);
  if (!deniedApprove.ok) assert.equal(deniedApprove.code, "conflict");
  assert.equal((await actions.get(denied.id))!.status, "denied");

  const missing = await actions.decide("missing", "approve");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not_found");
    assert.equal(typeof missing.message, "string");
  }

  // 过期判断与状态迁移在同一次 repository 更新中完成；冲突结果仍留下 expired 终态。
  const expiring = await actions.submit("file_write", "expire me", { path: "c.txt", content: "c" }, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  const expired = await actions.decide(expiring.id, "approve");
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, "conflict");
  const expiredRecord = (await actions.get(expiring.id))!;
  assert.equal(expiredRecord.status, "expired");
  assert.ok(expiredRecord.decidedAt);
  assert.equal((await actions.decide(expiring.id, "deny")).ok, false);

  const cancelled = await actions.submit("file_write", "cancel me", { path: "d.txt", content: "d" });
  await actions.cancel(cancelled.id);
  const cancelledApprove = await actions.decide(cancelled.id, "approve");
  assert.equal(cancelledApprove.ok, false);
  if (!cancelledApprove.ok) assert.equal(cancelledApprove.code, "conflict");
  assert.equal((await actions.get(cancelled.id))!.status, "cancelled");
});

test("markExecuting claims an approved unexpired approval exactly once; receipts never rewrite the approval status", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const events: ApprovalChange[] = [];
  actions.subscribe((change) => events.push(change));

  const pending = await actions.submit("file_write", "pending", { path: "pending.txt", content: "p" }, { timeoutMs: 1_000 });
  assert.equal(await actions.markExecuting(pending.id), false);
  assert.equal((await actions.get(pending.id))!.execution, undefined);
  await actions.finishExecution(pending.id, "succeeded", "should not happen");
  assert.equal((await actions.get(pending.id))!.execution, undefined);
  assert.equal(events.length, 1, "only submit committed");

  await actions.decide(pending.id, "approve");
  const beforeClaim = events.length;
  assert.equal(await actions.markExecuting(pending.id), true);
  const running = (await actions.get(pending.id))!;
  assert.equal(running.status, "approved");
  assert.equal(running.execution?.status, "running");
  assert.equal(running.execution?.finishedAt, null);
  assert.equal(running.execution?.result, null);
  assert.ok(running.execution?.startedAt);
  assert.equal(events.length, beforeClaim + 1);

  // 第二次 claim 失败且不产生提交/通知，startedAt 保持不变。
  const startedAt = running.execution!.startedAt;
  assert.equal(await actions.markExecuting(pending.id), false);
  assert.equal((await actions.get(pending.id))!.execution?.startedAt, startedAt);
  assert.equal(events.length, beforeClaim + 1);

  // succeeded 回执只改 execution，不把 approved 改写成别的审批状态。
  await actions.finishExecution(pending.id, "succeeded", "committed");
  const succeeded = (await actions.get(pending.id))!;
  assert.equal(succeeded.status, "approved");
  assert.equal(succeeded.execution?.status, "succeeded");
  assert.equal(succeeded.execution?.result, "committed");
  assert.ok(succeeded.execution?.finishedAt);
  const finishedAt = succeeded.execution!.finishedAt;

  // 已结束的执行不能再次改写成 failed。
  await actions.finishExecution(pending.id, "failed", "late failure");
  assert.equal((await actions.get(pending.id))!.execution?.status, "succeeded");
  assert.equal((await actions.get(pending.id))!.execution?.finishedAt, finishedAt);
  assert.equal((await actions.get(pending.id))!.status, "approved");

  const failed = await actions.submit("file_write", "failed", { path: "failed.txt", content: "f" });
  await actions.decide(failed.id, "approve");
  assert.equal(await actions.markExecuting(failed.id), true);
  await actions.finishExecution(failed.id, "failed", "refused");
  const failedRecord = (await actions.get(failed.id))!;
  assert.equal(failedRecord.status, "approved");
  assert.equal(failedRecord.execution?.status, "failed");
  assert.equal(failedRecord.execution?.result, "refused");

  const cancelled = await actions.submit("file_write", "cancelled execution", { path: "cancelled.txt", content: "c" });
  await actions.decide(cancelled.id, "approve");
  assert.equal(await actions.markExecuting(cancelled.id), true);
  await actions.finishExecution(cancelled.id, "cancelled", "aborted");
  const cancelledRecord = (await actions.get(cancelled.id))!;
  assert.equal(cancelledRecord.status, "approved");
  assert.equal(cancelledRecord.execution?.status, "cancelled");

  // 未批准、已拒绝或已过期的审批都不能开始执行。
  const denied = await actions.submit("file_write", "denied", { path: "denied.txt", content: "d" });
  await actions.decide(denied.id, "deny");
  assert.equal(await actions.markExecuting(denied.id), false);
  assert.equal((await actions.get(denied.id))!.execution, undefined);

  const expiring = await actions.submit("file_write", "expired claim", { path: "expired.txt", content: "e" }, { timeoutMs: 10 });
  await actions.decide(expiring.id, "approve");
  t.mock.timers.tick(10);
  assert.equal(await actions.markExecuting(expiring.id), false);
  assert.equal((await actions.get(expiring.id))!.execution, undefined);
});

test("restart cleanup cancels pending and marks running executions unknown without touching terminal states or previews", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository([
    record({ id: "pending", status: "pending", payload: { path: "pending.txt", content: "pending-preview" } }),
    record({ id: "approved", status: "approved", decidedAt: iso(900), payload: { path: "approved.txt", content: "approved-preview" } }),
    record({
      id: "running",
      status: "approved",
      decidedAt: iso(900),
      payload: { path: "running.txt", content: "running-preview" },
      execution: { status: "running", startedAt: iso(950), finishedAt: null, result: null },
    }),
    record({
      id: "succeeded",
      status: "approved",
      decidedAt: iso(900),
      payload: { path: "succeeded.txt", content: "succeeded-preview" },
      execution: { status: "succeeded", startedAt: iso(950), finishedAt: iso(960), result: "ok" },
    }),
    record({ id: "denied", status: "denied", decidedAt: iso(900) }),
    record({ id: "expired", status: "expired", decidedAt: iso(900) }),
    record({ id: "cancelled", status: "cancelled", decidedAt: iso(900) }),
  ]);
  const actions = createActionService(store.repository);
  const events: ApprovalChange[] = [];
  actions.subscribe((change) => events.push(change));
  const before = await actions.list();

  await actions.cancelPending();
  const after = await actions.list();
  const byId = new Map(after.map((action) => [action.id, action]));

  assert.equal(byId.get("pending")!.status, "cancelled");
  assert.ok(byId.get("pending")!.decidedAt);

  const running = byId.get("running")!;
  assert.equal(running.status, "approved");
  assert.equal(running.execution?.status, "unknown");
  assert.equal(running.execution?.finishedAt, null);
  assert.equal(running.execution?.startedAt, iso(950));
  assert.ok(running.execution?.result, "unknown execution carries a verification hint");
  assert.notEqual(running.execution?.status, "succeeded");

  // unknown 是终止事实：迟到的工具回执不能把它推断成成功或失败。
  await actions.finishExecution("running", "succeeded", "late receipt");
  const stillUnknown = (await actions.get("running"))!;
  assert.equal(stillUnknown.execution?.status, "unknown");
  assert.equal(stillUnknown.execution?.finishedAt, null);
  assert.equal(stillUnknown.status, "approved");

  // 已进入终态的记录和所有预览必须原样保留，不能借重启清理覆盖。
  for (const id of ["approved", "succeeded", "denied", "expired", "cancelled"]) {
    assert.deepEqual(byId.get(id), before.find((action) => action.id === id));
  }
  for (const action of after) {
    assert.deepEqual(action.payload, before.find((item) => item.id === action.id)!.payload);
  }

  assert.deepEqual(events.map((event) => event.approval.id).sort(), ["pending", "running"]);

  // 重复清理不产生第二次提交，也不重复通知。
  const snapshot = await actions.list();
  await actions.cancelPending();
  assert.deepEqual(await actions.list(), snapshot);
  assert.equal(events.length, 2);
});

test("every successful commit notifies once with a full clone; listener failures and write failures never block or fake commits", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const received: ApprovalChange[] = [];
  const injected: ApprovalChange[] = [];
  const actions = createActionService(store.repository, (change) => {
    injected.push(change);
    throw new Error("injected onChanged failed");
  });
  const good: ApprovalChange[] = [];
  actions.subscribe((change) => {
    received.push(change);
    throw new Error("bad listener failed");
  });
  const unsubscribe = actions.subscribe((change) => {
    good.push(change);
    // 修改收到的克隆不能影响存储，也不能影响其他监听器。
    change.approval.payload.content = "mutated-by-listener";
  });

  const action = await actions.submit("file_write", "write", { path: "note.txt", content: "original" }, { timeoutMs: 60_000 });
  assert.equal((await actions.get(action.id))!.payload.content, "original");
  assert.equal(received.length, 1);
  assert.equal(good.length, 1);
  assert.equal(injected.length, 1);
  assert.notEqual(received[0].approval, good[0].approval);
  assert.notEqual(received[0].approval.payload, good[0].approval.payload);
  assert.notEqual(good[0].approval.payload, (await actions.get(action.id))!.payload);

  await actions.decide(action.id, "approve");
  assert.equal(received.length, 2);
  await actions.markExecuting(action.id);
  assert.equal(received.length, 3);
  assert.equal(received[2].approval.execution?.status, "running");
  // 嵌套 execution 同样是完整克隆。
  received[2].approval.execution!.status = "succeeded";
  assert.equal((await actions.get(action.id))!.execution?.status, "running");

  await actions.finishExecution(action.id, "succeeded", "ok");
  assert.equal(received.length, 4);
  assert.equal(received[3].approval.execution?.status, "succeeded");

  // 幂等/未命中/无变化的更新不提交，也不发通知。
  await actions.decide(action.id, "approve");
  await actions.cancel("missing");
  assert.equal(await actions.markExecuting(action.id), false);
  await actions.finishExecution(action.id, "failed", "late");
  assert.equal(received.length, 4);

  // 取消订阅后不再收到事件。
  unsubscribe();
  const pending = await actions.submit("file_write", "pending", { path: "pending.txt", content: "p" });
  await actions.cancel(pending.id);
  assert.equal(good.length, 4, "unsubscribed listener stops receiving");

  // 写失败：调用方收到 rejection，存储不变，且不产生通知。
  const beforeFailure = await actions.list();
  const eventsBeforeFailure = received.length;
  store.failNextWrite();
  await assert.rejects(actions.submit("file_write", "failing", { path: "fail.txt", content: "f" }));
  assert.deepEqual(await actions.list(), beforeFailure);
  assert.equal(received.length, eventsBeforeFailure);

  // 失败后队列仍然可用，下一次成功提交正常通知。
  await actions.submit("file_write", "after failure", { path: "after.txt", content: "a" });
  assert.equal(received.length, eventsBeforeFailure + 1);
});

test("concurrent submissions and decisions are serialized without loss or double approval", async () => {
  const store = memoryRepository();
  const actions = createActionService(store.repository);

  // 并发提交全部经过同一 repository 写队列，不能互相覆盖。
  const submitted = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      actions.submit("file_write", `write ${index}`, { path: `${index}.txt`, content: `${index}` })),
  );
  assert.equal(new Set(submitted.map((action) => action.id)).size, 40);
  assert.equal((await actions.list()).length, 40);

  // 对同一 pending 同时批准/拒绝：串行化后只有一个决定成功，另一个是 conflict。
  const pending = await actions.submit("file_write", "race", { path: "race.txt", content: "r" });
  const [approve, deny] = await Promise.all([
    actions.decide(pending.id, "approve"),
    actions.decide(pending.id, "deny"),
  ]);
  assert.equal([approve, deny].filter((result) => result.ok).length, 1);
  const loser = approve.ok ? deny : approve;
  assert.equal(loser.ok, false);
  if (!loser.ok) assert.equal(loser.code, "conflict");
  const settled = (await actions.get(pending.id))!;
  assert.equal(settled.status, approve.ok ? "approved" : "denied");
  assert.ok(settled.decidedAt);

  // 并发 claim 只有一次成功，execution 不会被第二个调用重置 startedAt。
  const claimable = await actions.submit("file_write", "claim race", { path: "claim.txt", content: "c" });
  await actions.decide(claimable.id, "approve");
  const claims = await Promise.all([
    actions.markExecuting(claimable.id),
    actions.markExecuting(claimable.id),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal((await actions.get(claimable.id))!.execution?.status, "running");
});

test("submit snapshots the preview so caller mutations cannot rewrite the stored approval", async () => {
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const payload = { path: "note.txt", content: "original", originalContent: "" };
  const action = await actions.submit("file_write", "write", payload);

  payload.path = "changed-after-submit.txt";
  payload.content = "mutated-after-submit";
  assert.deepEqual((await actions.get(action.id))!.payload, {
    path: "note.txt",
    content: "original",
    originalContent: "",
  });

  // submit 返回的记录是本次提交的快照；调用方改写它也不能回写持久化状态。
  action.payload.content = "mutated-returned-action";
  assert.equal((await actions.get(action.id))!.payload.content, "original");
});
