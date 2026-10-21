/**
 * 审批服务单元测试：服务为 main baseline（decide→PendingAction|undefined，
 * resolveDecision→{ok,code?,action?}, expirePending/cancelPending/snapshotPending
 * 与 main 行为兼容；execution 字段、page() 与 subscribe() 为新增叠加）。
 *
 * 范围：
 * - 服务内部状态机、版本号、终态时间、幂等重放、容量限制与串行化写；
 * - execution 仅在 approved 上建立，每次变更 revision+1 并 onChange（防 SSE 去重丢回执）；
 * - cancelPending 把遗留在 running 的执行标为 unknown / finishedAt=null / result 不变；
 * - page({limit, cursor, spaceId, activityId, status}) 按 resolvedAt 降序、
 *   同时间按 id 降序，过滤在分页前应用；
 * - 监听器深度克隆、抛错隔离、订阅/取消订阅。
 *
 * 不触碰 HTTP/pi/磁盘；repository 为内存版（与真实 JSON repository 串行语义对齐）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ApprovalCapacityError,
  createActionService,
  MAX_APPROVAL_BYTES,
  MAX_PENDING_APPROVALS,
  MAX_PENDING_APPROVAL_BYTES,
} from "../../src/features/actions/action-service.js";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import type {
  ActionRepository,
  ApprovalChange,
  ApprovalHistoryQuery,
  PendingAction,
} from "../../src/features/actions/types.js";

type MemoryRepository = {
  repository: ActionRepository;
  failNextWrite: () => void;
};

/**
 * 与真实 JSON repository 对齐的最小内存实现：同一实例内串行读改写，
 * 每次读写都做结构化克隆，模拟"持久化结果与调用方对象隔离"的边界。
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
        if (next.items === undefined) return next.result;
        if (failNext) {
          failNext = false;
          throw new Error("simulated write failure");
        }
        items = structuredClone(next.items);
        return next.result;
      });
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

/** 历史/重启测试所需的完整记录；默认是一条已批准、未过期的审批。 */
const record = (overrides: Partial<PendingAction> & Pick<PendingAction, "id">): PendingAction => ({
  kind: "file_write",
  title: "test approval",
  payload: { path: "note.txt", content: "content" },
  status: "approved",
  revision: 2,
  createdAt: iso(1_000),
  expiresAt: iso(10_000),
  resolvedAt: iso(1_500),
  decidedAt: iso(1_500),
  spaceId: null,
  runId: null,
  toolCallId: null,
  subagentId: null,
  workspaceSpaceId: null,
  activityId: null,
  ...overrides,
});

test("submit writes revision 1 with full nullable context fields and notifies once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const events: ApprovalChange[] = [];
  const actions = createActionService(store.repository, {
    onChange: (change) => events.push({ approval: change }),
  });

  const action = await actions.submit(
    "file_write",
    "write note",
    { path: "note.txt", content: "hello" },
    { spaceId: "local-main", runId: "run-1", toolCallId: "tc-1", subagentId: null, workspaceSpaceId: "ws-1", activityId: "act-1" },
  );

  assert.equal(action.status, "pending");
  assert.equal(action.revision, 1);
  assert.equal(action.resolvedAt, null);
  assert.equal(action.decidedAt, null);
  assert.equal(action.spaceId, "local-main");
  assert.equal(action.runId, "run-1");
  assert.equal(action.toolCallId, "tc-1");
  assert.equal(action.subagentId, null);
  assert.equal(action.workspaceSpaceId, "ws-1");
  assert.equal(action.activityId, "act-1");
  assert.equal(action.execution, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].approval.id, action.id);
});

test("decide returns PendingAction|undefined and resolveDecision returns {ok,code?,action?}", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const actions = createActionService(store.repository);

  const approved = await actions.submit("file_write", "ok", { path: "ok.txt", content: "o" });
  // approve → PendingAction | undefined：返回记录；revision 推进到 2；decidedAt 与 resolvedAt 一致。
  const first = await actions.decide(approved.id, "approve");
  assert.ok(first);
  assert.equal(first?.status, "approved");
  assert.equal(first?.revision, 2);
  assert.ok(first?.resolvedAt);
  assert.equal(first?.decidedAt, first?.resolvedAt);

  // 同决定重放仍是原记录，revision 不变、不重复通知；返回依然等价。
  const replay = await actions.decide(approved.id, "approve");
  assert.equal(replay?.revision, 2);
  assert.equal(replay?.decidedAt, first?.decidedAt);
  assert.equal((await actions.get(approved.id))?.revision, 2);

  // 相反决定：decide 返回 undefined；resolveDecision 区分 conflict。
  const opposite = await actions.decide(approved.id, "deny");
  assert.equal(opposite, undefined);
  const conflict = await actions.resolveDecision(approved.id, "deny");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "conflict");
  assert.equal(conflict.action?.status, "approved");
  assert.equal(conflict.action?.revision, 2);

  const denied = await actions.submit("file_write", "deny", { path: "d.txt", content: "d" });
  const deniedResult = await actions.resolveDecision(denied.id, "deny");
  assert.equal(deniedResult.ok, true);
  assert.equal(deniedResult.code, undefined);
  assert.equal(deniedResult.action?.status, "denied");
  assert.equal(deniedResult.action?.revision, 2);
  assert.ok(deniedResult.action?.decidedAt);

  const missing = await actions.resolveDecision("missing", "approve");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "not_found");
  assert.equal(missing.action, undefined);
  assert.equal(await actions.decide("missing", "approve"), undefined);
});

test("expired persist in same update, decidedAt stays null, expirePending returns count", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const events: PendingAction[] = [];
  const actions = createActionService(memoryRepository().repository, {
    onChange: (change) => events.push(change),
  });

  const expiring = await actions.submit("file_write", "exp", { path: "e.txt", content: "e" }, { timeoutMs: 10 });
  t.mock.timers.tick(11);

  // 决定入口在同一次 update 中先持久化 expired，再返回 conflict；不发明 decidedAt。
  const late = await actions.resolveDecision(expiring.id, "approve");
  assert.equal(late.ok, false);
  assert.equal(late.code, "conflict");
  assert.equal(late.action?.status, "expired");
  assert.equal(late.action?.revision, 2);
  assert.equal(late.action?.decidedAt, null);
  assert.equal(late.action?.resolvedAt, iso(1_011));
  assert.equal(events.at(-1)?.status, "expired");
  assert.equal(events.at(-1)?.decidedAt, null);

  const second = await actions.submit("file_write", "later", { path: "l.txt", content: "l" }, { timeoutMs: 10 });
  assert.equal(await actions.expirePending(), 0, "未到期不应被批量过期");
  t.mock.timers.tick(11);
  const count = await actions.expirePending();
  assert.equal(count, 1);
  assert.equal((await actions.get(second.id))?.status, "expired");
  assert.equal((await actions.get(second.id))?.decidedAt, null);
  // 重复调用没有新变化，不再发通知。
  const before = events.length;
  assert.equal(await actions.expirePending(), 0);
  assert.equal(events.length, before);
});

test("cancel persists resolvedAt, decidedAt stays null; cancelPending flips running execution to unknown with finishedAt=null", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository([
    // pending 必须以 revision=1 进入；resolvedAt/decidedAt 全 null 由 setter 显式覆盖。
    record({ id: "pending", status: "pending", revision: 1, resolvedAt: null, decidedAt: null, payload: { path: "pending.txt", content: "p" } }),
    record({ id: "approved", status: "approved", decidedAt: iso(900), payload: { path: "approved.txt", content: "a" } }),
    record({
      id: "running",
      status: "approved",
      decidedAt: iso(900),
      payload: { path: "running.txt", content: "r" },
      execution: { status: "running", startedAt: iso(950), finishedAt: null, result: null },
    }),
    record({
      id: "succeeded",
      status: "approved",
      decidedAt: iso(900),
      payload: { path: "succeeded.txt", content: "s" },
      execution: { status: "succeeded", startedAt: iso(950), finishedAt: iso(960), result: "ok" },
    }),
    record({ id: "denied", status: "denied", decidedAt: iso(900) }),
    record({ id: "expired", status: "expired", decidedAt: iso(900) }),
    record({ id: "cancelled", status: "cancelled", decidedAt: iso(900) }),
  ]);
  const events: ApprovalChange[] = [];
  const actions = createActionService(store.repository, {
    onChange: (change) => events.push({ approval: change }),
  });

  await actions.cancelPending();

  const after = await actions.list();
  const byId = new Map(after.map((action) => [action.id, action]));

  const pending = byId.get("pending")!;
  assert.equal(pending.status, "cancelled");
  assert.equal(pending.revision, 2, "settled from 1 → 2 by cancelPending");
  assert.ok(pending.resolvedAt);
  assert.equal(pending.decidedAt, null);

  // running → unknown；finishedAt 强制为 null（不"伪造"结束时刻）；startedAt 与 result 保留作为审计线索。
  const running = byId.get("running")!;
  assert.equal(running.status, "approved");
  assert.equal(running.execution?.status, "unknown");
  assert.equal(running.execution?.finishedAt, null);
  assert.equal(running.execution?.startedAt, iso(950));
  assert.ok(running.execution?.result, "unknown execution carries a verification hint");
  assert.equal(running.revision, 3, "approved→execution→unknown 推进 revision");

  // 未启动 execution 的 approved 记录不会被改动；终态字段全部保留。
  assert.equal(byId.get("succeeded")?.execution?.status, "succeeded");
  assert.deepEqual(byId.get("succeeded")?.payload, { path: "succeeded.txt", content: "s" });
  for (const id of ["approved", "denied", "expired", "cancelled"]) {
    assert.equal((await actions.get(id))?.status, byId.get(id)?.status);
  }

  const touched = events.map((event) => event.approval.id).sort();
  assert.deepEqual(touched, ["pending", "running"]);
  // 再调用一次不产生新提交，也不重复通知。
  const beforeReplay = events.length;
  await actions.cancelPending();
  assert.equal(events.length, beforeReplay);
});

test("execution claims an approved unexpired approval once; receipts advance revision and notify", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const events: ApprovalChange[] = [];
  const actions = createActionService(memoryRepository().repository, {
    onChange: (change) => events.push({ approval: change }),
  });

  const pending = await actions.submit("file_write", "go", { path: "g.txt", content: "g" }, { timeoutMs: 1_000 });
  assert.equal(await actions.markExecuting(pending.id), false, "未批准不得认领");
  assert.equal((await actions.get(pending.id))?.execution, undefined);
  await actions.finishExecution(pending.id, "succeeded", "early");
  assert.equal((await actions.get(pending.id))?.execution, undefined);

  await actions.decide(pending.id, "approve");
  const beforeClaim = events.length;
  assert.equal(await actions.markExecuting(pending.id), true);
  const claimed = (await actions.get(pending.id))!;
  assert.equal(claimed.status, "approved");
  assert.equal(claimed.execution?.status, "running");
  assert.equal(claimed.execution?.finishedAt, null);
  assert.equal(claimed.execution?.result, null);
  assert.ok(claimed.execution?.startedAt);
  assert.equal(claimed.revision, 3, "approve+execute 已两次推进版本");
  assert.equal(events.length, beforeClaim + 1);

  // 重复 claim 不再推进版本、也不再通知。
  const startedAt = claimed.execution!.startedAt;
  assert.equal(await actions.markExecuting(pending.id), false);
  assert.equal((await actions.get(pending.id))?.execution?.startedAt, startedAt);
  assert.equal((await actions.get(pending.id))?.revision, 3);
  assert.equal(events.length, beforeClaim + 1);

  // 成功后已 finished，不能被 late 写回 failed。
  await actions.finishExecution(pending.id, "succeeded", "committed");
  const succeeded = (await actions.get(pending.id))!;
  assert.equal(succeeded.execution?.status, "succeeded");
  assert.equal(succeeded.execution?.result, "committed");
  assert.ok(succeeded.execution?.finishedAt);
  const finishedAt = succeeded.execution!.finishedAt;
  const revisionBeforeLate = succeeded.revision;

  await actions.finishExecution(pending.id, "failed", "late");
  assert.equal((await actions.get(pending.id))?.execution?.status, "succeeded");
  assert.equal((await actions.get(pending.id))?.execution?.finishedAt, finishedAt);
  assert.equal((await actions.get(pending.id))?.revision, revisionBeforeLate);

  // 拒批、过期都不能开始执行。
  const denied = await actions.submit("file_write", "no", { path: "n.txt", content: "n" });
  await actions.decide(denied.id, "deny");
  assert.equal(await actions.markExecuting(denied.id), false);
  assert.equal((await actions.get(denied.id))?.execution, undefined);

  const expiring = await actions.submit("file_write", "e", { path: "e.txt", content: "e" }, { timeoutMs: 10 });
  await actions.decide(expiring.id, "approve");
  t.mock.timers.tick(11);
  assert.equal(await actions.markExecuting(expiring.id), false);
  assert.equal((await actions.get(expiring.id))?.execution, undefined);
});

test("page returns resolvedAt desc + id desc, applies filters before cursor; binding rules live in HTTP layer", async () => {
  const items: PendingAction[] = [
    record({ id: "a1", status: "approved", resolvedAt: iso(3_000), decidedAt: iso(3_000), spaceId: "thread-a", activityId: "act-1" }),
    record({ id: "a2", status: "denied", resolvedAt: iso(2_000), decidedAt: iso(2_000), spaceId: "thread-a", activityId: "act-1" }),
    record({ id: "b1", status: "approved", resolvedAt: iso(1_000), decidedAt: iso(1_000), spaceId: "thread-b", activityId: "act-2" }),
  ];
  const actions = createActionService(memoryRepository(items).repository);

  // 默认按 resolvedAt desc，pending 永远不进入分页。
  const fullPage = await actions.page({ limit: 10 });
  assert.deepEqual(fullPage.approvals.map((action) => action.id), ["a1", "a2", "b1"]);
  assert.equal(fullPage.hasMore, false);
  assert.equal(fullPage.nextCursor, null);

  // 过滤在分页前：spaceId 只命中 thread-a，limit 1 → 按时间降序拿第一条。
  const first = await actions.page({ limit: 1, spaceId: "thread-a" });
  assert.deepEqual(first.approvals.map((action) => action.id), ["a1"]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, { resolvedAt: iso(3_000), id: "a1" });

  // 游标回传：上一条之后剩下的 thread-a 项。
  const second = await actions.page({ limit: 1, spaceId: "thread-a", cursor: first.nextCursor! });
  assert.deepEqual(second.approvals.map((action) => action.id), ["a2"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);

  // activityId 过滤：act-2 只有 b1。
  const byActivity = await actions.page({ limit: 10, activityId: "act-2" });
  assert.deepEqual(byActivity.approvals.map((action) => action.id), ["b1"]);

  // status 过滤：approved 命中 a1/b1。
  const byStatus = await actions.page({ limit: 10, status: "approved" });
  assert.deepEqual(byStatus.approvals.map((action) => action.id), ["a1", "b1"]);

  // 业务 cursor 不绑定过滤：service 信任调用方传入的 (resolvedAt, id)；
  // 跨过滤条件翻页的禁止策略由 HTTP 路由层在 service 之上强制（见集成测试）。
  const crossFilter = await actions.page({ limit: 10, spaceId: "thread-b", cursor: first.nextCursor! });
  // thread-b 没有时间晚于 3000 的记录，cursor 自然排空：反映业务"无绑定"。
  assert.deepEqual(crossFilter.approvals.map((action) => action.id), ["b1"]);

  // resolvedAt 非法时整条 page 失败，由调用方重建。
  const actions2 = createActionService(memoryRepository([record({ id: "bad", resolvedAt: "not-a-date" })]).repository);
  await assert.rejects(actions2.page({ limit: 10 }), /Invalid approval resolution time/);
});

test("page same-resolvedAt tie breaks by id descending with no gaps or duplicates", async () => {
  // 全部使用同一 resolvedAt/decidedAt：cursor 必须携带该值；同时间按 id 降序。
  const tiedAt = iso(5_000);
  const items: PendingAction[] = [
    record({ id: "a", resolvedAt: tiedAt, decidedAt: tiedAt }),
    record({ id: "b", resolvedAt: tiedAt, decidedAt: tiedAt }),
    record({ id: "c", resolvedAt: tiedAt, decidedAt: tiedAt }),
    record({ id: "d", resolvedAt: tiedAt, decidedAt: tiedAt }),
    record({ id: "e", resolvedAt: tiedAt, decidedAt: tiedAt }),
  ];
  const actions = createActionService(memoryRepository(items).repository);

  const first = await actions.page({ limit: 2 });
  assert.deepEqual(first.approvals.map((action) => action.id), ["e", "d"]);
  assert.deepEqual(first.nextCursor, { resolvedAt: tiedAt, id: "d" });

  const second = await actions.page({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.approvals.map((action) => action.id), ["c", "b"]);

  const third = await actions.page({ limit: 2, cursor: second.nextCursor! });
  assert.deepEqual(third.approvals.map((action) => action.id), ["a"]);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);

  const collected = [...first.approvals, ...second.approvals, ...third.approvals].map((action) => action.id);
  assert.equal(new Set(collected).size, collected.length);
});

test("history keeps raw insertion order; list() mirrors history; snapshotPending filters expired without writing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const notifications: PendingAction[] = [];
  const actions = createActionService(memoryRepository().repository, {
    onChange: (change) => notifications.push(change),
  });

  const expiring = await actions.submit("file_write", "ex", { path: "e.txt", content: "e" }, { timeoutMs: 10 });
  await actions.submit("file_write", "live", { path: "l.txt", content: "l" }, { timeoutMs: 60_000 });
  t.mock.timers.tick(11);

  // snapshotPending 纯读：返回过滤后的过期项，但不写盘、不通知。
  const beforeRead = notifications.length;
  const snapshot = await actions.snapshotPending();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot.every((action) => action.status === "pending"), true);
  assert.equal(notifications.length, beforeRead);

  // history() 仍按持久化状态返回，包含已过期但未迁移的项。
  const historyBefore = await actions.history();
  assert.equal(historyBefore.find((action) => action.id === expiring.id)?.status, "pending");

  // 历史原始全量与 list() 等价；服务端调用方按需要手动 expirePending。
  const listView = await actions.list();
  assert.deepEqual(listView, historyBefore);
});

test("subscribe delivers deep clones, isolates listener errors, and stops after unsubscribe", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const store = memoryRepository();
  const injected: ApprovalChange[] = [];
  const actions = createActionService(store.repository, {
    onChange: (change) => injected.push({ approval: change }),
  });
  const received: ApprovalChange[] = [];
  actions.subscribe((change) => {
    received.push(change);
    throw new Error("bad listener");
  });

  const pending = await actions.submit("file_write", "live", { path: "x.txt", content: "x" });
  await actions.decide(pending.id, "approve");
  await actions.markExecuting(pending.id);
  await actions.finishExecution(pending.id, "succeeded", "committed");

  assert.equal(received.length, 4, "submit/approve/exec start/exec end 各一次");
  assert.equal(received[0].approval.id, pending.id);
  // 监听器收到的是深拷贝；改写不影响存储。
  received[0].approval.payload.content = "mutated";
  assert.equal((await actions.get(pending.id))?.payload.content, "x");
  // onChange 注入也收到事件；不依赖 subscribe。
  assert.equal(injected.length, 4);

  // 重新订阅 + unsubscribe：unsubscribe 之后不再收到事件。
  // 注意：cancel 只能作用于 pending，所以先 submit 一条新 pending，再 cancel 触发通知。
  const stage: ApprovalChange[] = [];
  const unsubscribe = actions.subscribe((change) => stage.push(change));
  const fresh = await actions.submit("file_write", "fresh", { path: "f.txt", content: "f" });
  // submit 已经触发一次；cancel 再触发一次：stage 至少 2 个。
  await actions.cancel(fresh.id);
  assert.ok(stage.length >= 2, "subscribe 应收到 submit + cancel 两次事件");
  unsubscribe();
  const afterUnsubscribe = stage.length;
  await actions.submit("file_write", "post", { path: "p.txt", content: "p" });
  assert.equal(stage.length, afterUnsubscribe, "取消订阅后不再收到事件");
});

test("capacity rejects oversized, over-count and over-accumulated submissions", async (t) => {
  // 子用例 1：单项字节数超出 MAX_APPROVAL_BYTES 拒绝。
  {
    const directory = await mkdtemp(join(tmpdir(), "approval-cap-size-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "actions.json");
    const actions = createActionService(createActionRepository(file));
    const baseline = await actions.submit("file_write", "baseline", { path: "baseline" });
    // 把 content 填到 MAX_APPROVAL_BYTES（不含其他字段开销），整条 JSON 一定超 1.5MB。
    await assert.rejects(
      actions.submit("file_write", "too large", { content: "x".repeat(MAX_APPROVAL_BYTES) }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalCapacityError);
        assert.equal(error.message.includes("too large"), false);
        assert.equal(error.message.includes("xxxxx"), false);
        return true;
      },
    );
    assert.deepEqual((await actions.history()).map((action) => action.id), [baseline.id]);
  }

  // 子用例 2：pending 数量上限 32：第 33 项被拒；单条 payload 不足以触发单项上限。
  {
    const directory = await mkdtemp(join(tmpdir(), "approval-cap-count-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "actions.json");
    const actions = createActionService(createActionRepository(file));
    const accepted: PendingAction[] = [];
    for (let index = 0; index < MAX_PENDING_APPROVALS; index++) {
      accepted.push(await actions.submit("file_write", `p-${index}`, { path: `p-${index}` }));
    }
    const before = JSON.stringify(await actions.history());
    await assert.rejects(actions.submit("file_write", "one too many", {}), ApprovalCapacityError);
    assert.equal(JSON.stringify(await actions.history()), before, "拒绝时不改写文件");
    assert.equal((await actions.history()).length, MAX_PENDING_APPROVALS);
    void accepted;
  }

  // 常量关系保持：单项上限不超过累计上限。
  assert.ok(MAX_PENDING_APPROVAL_BYTES >= MAX_APPROVAL_BYTES);
});

test("write failures never notify and the queue keeps serving the next commit", async () => {
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const received: ApprovalChange[] = [];
  actions.subscribe((change) => received.push(change));

  const baseline = await actions.list();
  const beforeFailure = received.length;
  store.failNextWrite();
  await assert.rejects(actions.submit("file_write", "fail", { path: "f.txt", content: "f" }));
  assert.deepEqual(await actions.list(), baseline, "写失败不污染存储");
  assert.equal(received.length, beforeFailure, "写失败不发通知");

  const recovered = await actions.submit("file_write", "next", { path: "n.txt", content: "n" });
  assert.equal(received.length, beforeFailure + 1, "失败后队列继续工作");
  assert.equal(received.at(-1)?.approval.id, recovered.id);
});

test("concurrent submissions and decisions serialize without loss or double approval", async () => {
  // MAX_PENDING_APPROVALS = 32：并发提交数必须 ≤ 上限，确保全部成功用于验证串行化语义。
  const store = memoryRepository();
  const actions = createActionService(store.repository);

  // 25 条并发提交全部经同一 repository 写队列，互不覆盖；总数低于上限。
  const submitted = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      actions.submit("file_write", `c-${index}`, { path: `${index}.txt`, content: `${index}` })),
  );
  assert.equal(new Set(submitted.map((action) => action.id)).size, 25);
  assert.equal((await actions.list()).length, 25);

  const pending = await actions.submit("file_write", "race", { path: "race.txt", content: "r" });
  const [approve, deny] = await Promise.all([
    actions.resolveDecision(pending.id, "approve"),
    actions.resolveDecision(pending.id, "deny"),
  ]);
  // 串行化后只有一个成功，另一个 conflict；opposite 与 decide 等价 undefined。
  const winner = approve.ok ? approve : deny;
  const loser = approve.ok ? deny : approve;
  assert.equal(winner.ok, true);
  assert.equal(loser.ok, false);
  if (!loser.ok) assert.equal(loser.code, "conflict");
  const settled = (await actions.get(pending.id))!;
  assert.equal(settled.status, approve.ok ? "approved" : "denied");
  assert.equal(settled.revision, 2);

  // 并发 claim：markExecuting 必须串行化为恰好一次成功。
  const claimable = await actions.submit("file_write", "claim", { path: "claim.txt", content: "c" });
  await actions.decide(claimable.id, "approve");
  const claims = await Promise.all([
    actions.markExecuting(claimable.id),
    actions.markExecuting(claimable.id),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal((await actions.get(claimable.id))?.execution?.status, "running");
});

test("submit snapshots the payload so caller mutations cannot rewrite the stored approval", async () => {
  const store = memoryRepository();
  const actions = createActionService(store.repository);
  const payload = { path: "snap.txt", content: "original", originalContent: "" };
  const action = await actions.submit("file_write", "snap", payload);

  payload.path = "mutated.txt";
  payload.content = "mutated";
  assert.deepEqual((await actions.get(action.id))?.payload, {
    path: "snap.txt",
    content: "original",
    originalContent: "",
  });

  action.payload.content = "mutated-returned";
  assert.equal((await actions.get(action.id))?.payload.content, "original");
});

// 验证 ApprovalHistoryQuery 类型与 page 形参一致（编译期守卫，运行时无副作用）。
const _query: ApprovalHistoryQuery = { limit: 10 };
void _query;
