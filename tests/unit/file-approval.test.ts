import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createActionService, type ActionService } from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";
import { createWritableFileTools } from "../../src/adapters/pi/tools/files-writable.js";

type Tools = ReturnType<typeof createWritableFileTools>;
type Params = { path: string; content: string } | { path: string; oldText: string; newText: string };

/** 模拟真实 repository 的串行读改写和序列化隔离，不触碰用户实例/配置。 */
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
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bounded = <T>(promise: Promise<T>, ms = 500) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation did not finish promptly")), ms);
  })]).finally(() => clearTimeout(timer));
};
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "file-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace");
  await mkdir(root);
  return { directory, root, actions: createActionService(memoryRepository()) };
};
const execute = (tools: Tools, name: "write" | "edit", params: Params, signal?: AbortSignal) =>
  tools.find((tool) => tool.name === name)!.execute("test-call", params as never, signal, undefined, {} as never);

/** 自动决定只用于工具单测提速，仍通过真实审批服务状态机，不绕过 decide。 */
const approving = (
  actions: ActionService,
  beforeApprove: (action: PendingAction) => Promise<void> = async () => {},
): Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution"> => ({
  ...actions,
  submit: async (...args) => {
    const action = await actions.submit(...args);
    await beforeApprove(action);
    await actions.decide(action.id, "approve");
    return action;
  },
});

// 审批状态机：时效与取消必须在 repository 的同一更新中执行。
test("approval records explicit deadline and run ownership; late approve cannot revive it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const actions = createActionService(memoryRepository());
  const action = await actions.submit("file_write", "write", {}, { timeoutMs: 500, spaceId: "thread-a", runId: "run-a" });
  assert.equal(action.expiresAt, new Date(1_500).toISOString());
  assert.equal(action.spaceId, "thread-a");
  assert.equal(action.runId, "run-a");
  t.mock.timers.tick(500);
  assert.equal(await actions.decide(action.id, "approve"), undefined);
  assert.deepEqual(await actions.poll(action.id), { status: "expired" });
  const [expired] = await actions.list();
  // 过期是系统失效而不是人的决定：只写 resolvedAt，decidedAt 必须保持 null。
  assert.equal(expired.status, "expired");
  assert.equal(expired.revision, 2);
  assert.equal(expired.resolvedAt, new Date(1_500).toISOString());
  assert.equal(expired.decidedAt, null);
});

test("approval decision respects the stored deadline and fails closed for invalid deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const actions = createActionService(memoryRepository());
  const action = await actions.submit("file_edit", "edit", {}, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.deepEqual(await actions.poll(action.id), { status: "expired" });
  const { expiresAt: _, ...invalid } = action;
  const restored = createActionService(memoryRepository([invalid as PendingAction]));
  assert.equal(await restored.decide(action.id, "approve"), undefined);
  assert.deepEqual(await restored.poll(action.id), { status: "expired" });
});

test("approval cancellation is terminal and startup cleanup preserves settled decisions", async () => {
  const actions = createActionService(memoryRepository());
  const pending = await actions.submit("file_write", "pending", {});
  const cancelled = await actions.submit("file_write", "cancelled", {});
  const approved = await actions.submit("file_write", "approved", {});
  const denied = await actions.submit("file_edit", "denied", {});
  await actions.decide(approved.id, "approve");
  await actions.decide(denied.id, "deny");
  await actions.cancel(cancelled.id);
  await actions.cancel(cancelled.id);
  await actions.cancel("unknown");
  assert.equal(await actions.decide(cancelled.id, "approve"), undefined);
  await actions.cancelPending();
  const once = await actions.list();
  await actions.cancelPending();
  assert.deepEqual(await actions.list(), once);
  assert.deepEqual(once.map((action) => [action.id, action.status]), [
    [pending.id, "cancelled"], [cancelled.id, "cancelled"], [approved.id, "approved"], [denied.id, "denied"],
  ]);
});

test("approval rejects invalid durations", async () => {
  const actions = createActionService(memoryRepository());
  for (const timeoutMs of [0, -1, NaN, Infinity])
    await assert.rejects(actions.submit("file_write", "write", {}, { timeoutMs }));
  assert.deepEqual(await actions.list(), []);
});

test("write approval exposes full content, version and execution context", async (t) => {
  const { root, actions } = await fixture(t);
  const original = "before".repeat(1_000);
  const content = "正文".repeat(1_000);
  await writeFile(join(root, "note.md"), original);
  const tools = createWritableFileTools(root, approving(actions), 5_000, { spaceId: "thread", runId: "run" });
  const result = await execute(tools, "write", { path: "note.md", content });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  assert.deepEqual(action.payload, {
    path: "note.md", originalContent: original, content,
    baseVersion: action.payload.baseVersion, beforeExists: "true",
  });
  assert.notEqual(action.payload.baseVersion, "missing");
  assert.equal(action.spaceId, "thread");
  assert.equal(action.runId, "run");
  assert.equal(action.execution?.status, "succeeded");
  assert.equal(action.revision, 4);
  assert.equal(Date.parse(action.expiresAt) - Date.parse(action.createdAt), 5_000);
  assert.equal(await readFile(join(root, "note.md"), "utf8"), content);
  assert.deepEqual(await readdir(root), ["note.md"]);
});

test("new-file write approval records beforeExists=false with an empty before", async (t) => {
  const { root, actions } = await fixture(t);
  const result = await execute(createWritableFileTools(root, approving(actions), 5_000), "write", { path: "nested/new.md", content: "new" });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  // 新建文件的完整预览：before 为空串，beforeExists 明确为 false，baseVersion 固定为 missing。
  assert.deepEqual(action.payload, {
    path: "nested/new.md", originalContent: "", content: "new",
    baseVersion: "missing", beforeExists: "false",
  });
  assert.equal(await readFile(join(root, "nested/new.md"), "utf8"), "new");
});

test("execution claim failure stops file effects and receipt failure never reports that a committed file is absent", async (t) => {
  const { root, actions } = await fixture(t);
  const refused = { ...approving(actions), markExecuting: async () => false };
  const noClaim = await execute(createWritableFileTools(root, refused, 5_000), "write", { path: "nested/file", content: "no claim" });
  assert.equal(noClaim.isError, true);
  assert.deepEqual(await readdir(root), []);

  const failedClaim = { ...approving(actions), markExecuting: async () => { throw new Error("private storage error"); } };
  await assert.rejects(execute(createWritableFileTools(root, failedClaim, 5_000), "write", { path: "nested/file", content: "claim failed" }));
  assert.deepEqual(await readdir(root), []);

  const lostReceipt = { ...approving(actions), finishExecution: async () => { throw new Error("private storage error"); } };
  const committed = await execute(createWritableFileTools(root, lostReceipt, 5_000), "write", { path: "committed.md", content: "saved" });
  assert.equal(committed.isError, true);
  assert.equal(await readFile(join(root, "committed.md"), "utf8"), "saved");
  assert.deepEqual(await readdir(root), ["committed.md"]);
  const text = committed.content[0];
  assert.equal(text.type, "text");
  if (text.type === "text") {
    assert.match(text.text, /File was committed/);
    assert.doesNotMatch(text.text, /nothing was written|private storage error/);
  }
  const last = (await actions.list()).at(-1)!;
  assert.equal(last.status, "approved");
  assert.equal(last.execution?.status, "running");
  await actions.cancelPending();
  assert.equal((await actions.get(last.id))?.execution?.status, "unknown");
});

test("edit approval exposes complete before/after and treats replacement syntax literally", async (t) => {
  const { root, actions } = await fixture(t);
  const oldText = "A".repeat(900);
  const newText = "$&$`$'" + "B".repeat(900);
  const original = "prefix:" + oldText + ":suffix";
  const content = "prefix:" + newText + ":suffix";
  await writeFile(join(root, "note.md"), original);
  const result = await execute(createWritableFileTools(root, approving(actions), 5_000), "edit", { path: "note.md", oldText, newText });
  assert.equal(result.isError, undefined);
  const [action] = await actions.list();
  assert.equal(action.payload.oldText, oldText);
  assert.equal(action.payload.newText, newText);
  assert.equal(action.payload.originalContent, original);
  assert.equal(action.payload.content, content);
  assert.equal(action.payload.beforeExists, "true");
  assert.equal(await readFile(join(root, "note.md"), "utf8"), content);
});

test("approval abort before invocation creates neither pending action nor directories", async (t) => {
  const { root, actions } = await fixture(t);
  const signal = AbortSignal.abort();
  const result = await execute(createWritableFileTools(root, actions, 5_000), "write", { path: "nested/file", content: "new" }, signal);
  assert.equal(result.isError, true);
  assert.deepEqual(await actions.list(), []);
  assert.deepEqual(await readdir(root), []);
});

test("approval abort during polling cancels immediately without waiting the two-second sleep", async (t) => {
  const { root, actions } = await fixture(t);
  const polling = deferred<void>();
  const controller = new AbortController();
  const wrapped = { ...actions, poll: async (id: string) => { const result = await actions.poll(id); polling.resolve(); return result; } };
  const result = execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "nested/file", content: "new" }, controller.signal);
  await polling.promise;
  controller.abort();
  assert.equal((await bounded(result)).isError, true);
  assert.equal((await actions.list())[0].status, "cancelled");
  assert.equal(await actions.decide((await actions.list())[0].id, "approve"), undefined);
  assert.deepEqual(await readdir(root), []);
});

test("approval abort also wins over an unresolved poll", async (t) => {
  const { root, actions } = await fixture(t);
  const polling = deferred<void>();
  const controller = new AbortController();
  const wrapped = { ...actions, poll: async () => { polling.resolve(); return new Promise<never>(() => {}); } };
  const result = execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "file", content: "new" }, controller.signal);
  await polling.promise;
  controller.abort();
  assert.equal((await bounded(result)).isError, true);
  assert.equal((await actions.list())[0].status, "cancelled");
});

test("approval abort during submit revokes the newly persisted pending action", async (t) => {
  const { root, actions } = await fixture(t);
  const controller = new AbortController();
  const wrapped = { ...actions, submit: async (...args: Parameters<ActionService["submit"]>) => {
    const action = await actions.submit(...args);
    controller.abort();
    return action;
  } };
  const result = await execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "file", content: "new" }, controller.signal);
  assert.equal(result.isError, true);
  assert.equal((await actions.list())[0].status, "cancelled");
  assert.deepEqual(await readdir(root), []);
});

test("approval already approved but aborted before commit performs no filesystem side effects", async (t) => {
  const { root, actions } = await fixture(t);
  const controller = new AbortController();
  const wrapped = { ...approving(actions), poll: async (id: string) => {
    const decision = await actions.poll(id);
    controller.abort();
    return decision;
  } };
  assert.equal((await execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "nested/file", content: "new" }, controller.signal)).isError, true);
  assert.deepEqual(await readdir(root), []);
});

test("denied or expired approvals never create files", async (t) => {
  const { root, actions } = await fixture(t);
  const denying = { ...actions, submit: async (...args: Parameters<ActionService["submit"]>) => {
    const action = await actions.submit(...args);
    await actions.decide(action.id, "deny");
    return action;
  } };
  assert.equal((await execute(createWritableFileTools(root, denying, 5_000), "write", { path: "file", content: "new" })).isError, true);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const expiring = { ...actions, submit: async (...args: Parameters<ActionService["submit"]>) => {
    const action = await actions.submit(...args);
    t.mock.timers.tick(10);
    return action;
  } };
  assert.equal((await execute(createWritableFileTools(root, expiring, 10), "write", { path: "file", content: "new" })).isError, true);
  assert.deepEqual(await readdir(root), []);
});

// 两个工厂先读同一基线、全部获批后同时提交，确保测试真实覆盖共享队列而非单实例互斥。
for (const name of ["write", "edit"] as const) {
  test(`${name} approvals from separate tools share a canonical workspace path commit queue`, async (t) => {
    const { root, actions } = await fixture(t);
    await writeFile(join(root, "file"), "original");
    const ready = deferred<void>();
    let count = 0;
    const wrapped = approving(actions, async () => { if (++count === 2) ready.resolve(); await ready.promise; });
    const first = createWritableFileTools(root, wrapped, 5_000);
    const second = createWritableFileTools(root, wrapped, 5_000);
    const params = (content: string): Params => name === "write"
      ? { path: "file", content }
      : { path: "file", oldText: "original", newText: content };
    const results = await Promise.all([execute(first, name, params("first")), execute(second, name, params("second"))]);
    assert.equal(results.filter((result) => !result.isError).length, 1);
    assert.equal(results.filter((result) => result.isError).length, 1);
    assert.match(await readFile(join(root, "file"), "utf8"), /^(first|second)$/);
    assert.deepEqual(await readdir(root), ["file"]);
  });

  test(`${name} approval refuses an externally changed version`, async (t) => {
    const { root, actions } = await fixture(t);
    await writeFile(join(root, "file"), "original");
    const wrapped = approving(actions, async () => { await writeFile(join(root, "file"), "external"); });
    const params = name === "write" ? { path: "file", content: "mine" } : { path: "file", oldText: "original", newText: "mine" };
    const result = await execute(createWritableFileTools(root, wrapped, 5_000), name, params);
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(root, "file"), "utf8"), "external");
  });
}

test("new-file write approval refuses a file created while waiting", async (t) => {
  const { root, actions } = await fixture(t);
  const wrapped = approving(actions, async () => { await writeFile(join(root, "file"), "external"); });
  assert.equal((await execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "file", content: "mine" })).isError, true);
  assert.equal(await readFile(join(root, "file"), "utf8"), "external");
});

test("write approval refuses a same-content file replacement with a new inode", async (t) => {
  const { root, actions } = await fixture(t);
  await writeFile(join(root, "file"), "original");
  const wrapped = approving(actions, async () => {
    await writeFile(join(root, "replacement"), "original");
    await rename(join(root, "replacement"), join(root, "file"));
  });
  assert.equal((await execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "file", content: "mine" })).isError, true);
  assert.equal(await readFile(join(root, "file"), "utf8"), "original");
});

test("write and edit reject symlink targets, linked parents and traversal before requesting approval", async (t) => {
  const { directory, root, actions } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "file"), "original");
  await symlink(join(outside, "file"), join(root, "linked-file"));
  await symlink(outside, join(root, "linked-parent"));
  const tools = createWritableFileTools(root, approving(actions), 5_000);
  for (const path of ["linked-file", "linked-parent/file", "../outside/file", join(outside, "file"), ".", ""]) {
    assert.equal((await execute(tools, "write", { path, content: "mine" })).isError, true);
    assert.equal((await execute(tools, "edit", { path, oldText: "original", newText: "mine" })).isError, true);
  }
  assert.deepEqual(await actions.list(), []);
  assert.equal(await readFile(join(outside, "file"), "utf8"), "original");
});

test("approval rechecks a parent directory swapped for an external symlink", async (t) => {
  const { directory, root, actions } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  const wrapped = approving(actions, async () => { await symlink(outside, join(root, "nested")); });
  const result = await execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "nested/file", content: "mine" });
  assert.equal(result.isError, true);
  assert.deepEqual(await readdir(outside), []);
});

test("approval rechecks a target swapped for a symlink after the initial read", async (t) => {
  const { directory, root, actions } = await fixture(t);
  const outside = join(directory, "outside");
  await writeFile(outside, "external");
  await writeFile(join(root, "file"), "original");
  const wrapped = approving(actions, async () => {
    await rm(join(root, "file"));
    await symlink(outside, join(root, "file"));
  });
  const result = await execute(createWritableFileTools(root, wrapped, 5_000), "edit", { path: "file", oldText: "original", newText: "mine" });
  assert.equal(result.isError, true);
  assert.equal(await readFile(outside, "utf8"), "external");
});

test("edit rejects empty, missing and overlapping oldText without requesting approval", async (t) => {
  const { root, actions } = await fixture(t);
  await writeFile(join(root, "file"), "aaa");
  const tools = createWritableFileTools(root, approving(actions), 5_000);
  for (const oldText of ["", "missing", "aa"])
    assert.equal((await execute(tools, "edit", { path: "file", oldText, newText: "new" })).isError, true);
  assert.deepEqual(await actions.list(), []);
  assert.equal(await readFile(join(root, "file"), "utf8"), "aaa");
});

test("write and edit enforce 100KB in UTF-8 on the complete resulting file", async (t) => {
  const { root, actions } = await fixture(t);
  await writeFile(join(root, "file"), "a".repeat(99_999) + "x");
  const tools = createWritableFileTools(root, approving(actions), 5_000);
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "x", newText: "中" })).isError, true);
  assert.equal((await execute(tools, "write", { path: "other", content: "中".repeat(33_334) })).isError, true);
  assert.deepEqual(await actions.list(), []);
  assert.equal((await execute(tools, "edit", { path: "file", oldText: "x", newText: "y" })).isError, undefined);
  assert.equal(Buffer.byteLength(await readFile(join(root, "file"), "utf8")), 100_000);
});

test("approved request that expires before the commit cannot create a directory or file", async (t) => {
  const { root, actions } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const wrapped = { ...approving(actions), poll: async (id: string) => {
    const decision = await actions.poll(id);
    t.mock.timers.tick(10);
    return decision;
  } };
  const result = await execute(createWritableFileTools(root, wrapped, 10), "write", { path: "nested/file", content: "mine" });
  assert.equal(result.isError, true);
  const message = result.content[0];
  assert.equal(message.type, "text");
  if (message.type === "text") assert.match(message.text, /expired/);
  assert.deepEqual(await readdir(root), []);
});

test("write approvals for a missing file cannot both create and overwrite it", async (t) => {
  const { root, actions } = await fixture(t);
  const ready = deferred<void>();
  let count = 0;
  const wrapped = approving(actions, async () => { if (++count === 2) ready.resolve(); await ready.promise; });
  const results = await Promise.all(["first", "second"].map((content) =>
    execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "nested/file", content })));
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.equal(results.filter((result) => result.isError).length, 1);
  assert.match(await readFile(join(root, "nested/file"), "utf8"), /^(first|second)$/);
  assert.deepEqual(await readdir(join(root, "nested")), ["file"]);
});

test("write and edit approvals for the same baseline share a commit queue", async (t) => {
  const { root, actions } = await fixture(t);
  await writeFile(join(root, "file"), "original");
  const ready = deferred<void>();
  let count = 0;
  const wrapped = approving(actions, async () => { if (++count === 2) ready.resolve(); await ready.promise; });
  const results = await Promise.all([
    execute(createWritableFileTools(root, wrapped, 5_000), "write", { path: "file", content: "written" }),
    execute(createWritableFileTools(root, wrapped, 5_000), "edit", { path: "file", oldText: "original", newText: "edited" }),
  ]);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.equal(results.filter((result) => result.isError).length, 1);
  assert.match(await readFile(join(root, "file"), "utf8"), /^(written|edited)$/);
});

test("write rejects a workspace root alias before asking for approval", async (t) => {
  const { directory, root, actions } = await fixture(t);
  const alias = join(directory, "alias");
  const outside = join(directory, "outside");
  await mkdir(outside);
  await symlink(root, alias);
  const tools = createWritableFileTools(alias, approving(actions), 5_000);
  const result = await execute(tools, "write", { path: "file", content: "mine" });
  assert.equal(result.isError, true);
  assert.deepEqual(await actions.list(), []);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await readdir(outside), []);
});
