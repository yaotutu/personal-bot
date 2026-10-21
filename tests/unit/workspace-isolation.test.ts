import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isThreadId } from "../../src/features/conversation/validate-input.js";
import {
  createDataLayout,
  ensureThreadLayout,
  ensureThreadWorkspace,
  sharedWorkspaceDir,
  threadWorkspaceDir,
} from "../../src/adapters/storage/data-layout.js";
import { createFileTools } from "../../src/adapters/pi/tools/files.js";
import { createWritableFileTools } from "../../src/adapters/pi/tools/files-writable.js";
import {
  resolveWorkspacePath,
  safeWorkspacePath,
  UnsafeFilePathError,
} from "../../src/adapters/pi/tools/workspace-path.js";
import { createActionService, type ActionService } from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";

/** 串行读改写的内存审批仓库；不触动正式 .pi-muse，仅用于本地测试隔离。 */
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

/** 所有文件工具遵循相同的 pi execute 签名；以 `as never` 跳过 SDK 的 schema 强约束并断言 content/details。 */
type Tools = ReturnType<typeof createFileTools>;
type WriteTools = ReturnType<typeof createWritableFileTools>;
type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; note?: string }>;
  details?: unknown;
  isError?: boolean;
};
const callTool = (tool: Tools[number] | WriteTools[number], params: unknown) =>
  (tool.execute as (id: string, params: unknown, signal: undefined, update: undefined, ctx: never) => Promise<ToolResult>)(
    "test-call", params, undefined, undefined, {} as never,
  );

/** 工具装载统一入口；boundaryDir 限制跨容器链接替换与边界外的父目录回退。 */
const setupTwoThreads = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  await ensureThreadLayout(layout);
  const rootA = threadWorkspaceDir(layout, "local-main");
  const rootB = threadWorkspaceDir(layout, "trip-2026");
  await ensureThreadWorkspace(layout, "local-main");
  await ensureThreadWorkspace(layout, "trip-2026");
  const sharedDir = sharedWorkspaceDir(layout);
  const toolsA = createFileTools(rootA, sharedDir, { boundaryDir: layout.workspaceDir });
  const toolsB = createFileTools(rootB, sharedDir, { boundaryDir: layout.workspaceDir });
  return { directory, layout, rootA, rootB, sharedDir, toolsA, toolsB };
};

const den = (result: { isError?: boolean; details?: unknown }) => {
  assert.equal(result.isError, true);
  const details = result.details as { denied?: boolean };
  assert.equal(details?.denied, true);
};

const findTool = (tools: Tools) => tools.find((tool) => tool.name === "find")!;
const readTool = (tools: Tools) => tools.find((tool) => tool.name === "read")!;
const grepTool = (tools: Tools) => tools.find((tool) => tool.name === "grep")!;
const lsTool = (tools: Tools) => tools.find((tool) => tool.name === "ls")!;

/** 1×1 RGB PNG，IHDR/IDAT/IEND 均包含有效 CRC，保留 pi 原生图片处理链路。 */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

// 1. 所有会话（含 local-main）拥有互不相同的私有并列目录，非法 threadId 必须拒绝。
test("every session gets its own private workspace and invalid ids are refused", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-iso-threads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  await ensureThreadLayout(layout);
  for (const threadId of ["local-main", "trip-2026", "task-feed-1"]) {
    await ensureThreadWorkspace(layout, threadId);
    assert.equal(isThreadId(threadId), true);
  }
  const mainDir = threadWorkspaceDir(layout, "local-main");
  const tripDir = threadWorkspaceDir(layout, "trip-2026");
  const taskDir = threadWorkspaceDir(layout, "task-feed-1");
  assert.notEqual(mainDir, tripDir);
  assert.notEqual(tripDir, taskDir);
  for (const directory of [mainDir, tripDir, taskDir]) {
    const stat = await import("node:fs/promises").then((m) => m.stat(directory));
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
  }
  for (const invalid of ["", "../escape", "with space", "weird/char", "a".repeat(65), "\u0000null"]) {
    assert.equal(isThreadId(invalid), false);
    assert.throws(() => threadWorkspaceDir(layout, invalid), /Invalid threadId/);
  }
});

// 2. 双向普通读取/grep/find/ls 不能越私有区，但可通过 shared 别名访问 shared 目录。
test("read/grep/find/ls cannot cross private zones but reach shared via the shared/ alias", async (t) => {
  const { rootA, rootB, sharedDir, toolsA, toolsB } = await setupTwoThreads(t);
  await writeFile(join(rootA, "main-note.md"), "alpha content from local-main");
  await writeFile(join(rootB, "trip-note.md"), "beta content from trip-2026");
  await writeFile(join(sharedDir, "shared-doc.md"), "alpha and beta shared content");
  await mkdir(join(sharedDir, "sub"), { recursive: true });
  await writeFile(join(sharedDir, "sub/inside.md"), "deeper shared content");

  // 私有区互相隔离：所有路径只要越过线程根都被拒绝，无论是父目录跳转还是别名隐藏
  for (const path of ["../trip-2026/trip-note.md", `../${sharedDir.split("/").pop()}/shared-doc.md`, "/etc/passwd"]) {
    den(await callTool(readTool(toolsA), { path }));
  }
  den(await callTool(readTool(toolsA), { path: "../trip-2026/trip-note.md" }));
  den(await callTool(grepTool(toolsA), { pattern: "beta", path: "../trip-2026" }));
  den(await callTool(findTool(toolsA), { pattern: "trip-note.md", path: "../trip-2026" }));
  den(await callTool(lsTool(toolsA), { path: ".." }));

  // 双向守卫对称
  for (const path of ["../local-main/main-note.md", "../shared/shared-doc.md", "/etc/passwd"]) {
    den(await callTool(readTool(toolsB), { path }));
  }
  den(await callTool(grepTool(toolsB), { pattern: "alpha content", path: "../local-main" }));
  den(await callTool(findTool(toolsB), { pattern: "main-note.md", path: "../local-main" }));
  den(await callTool(lsTool(toolsB), { path: ".." }));

  // shared/ 别名正向访问：必须能读能列能搜
  const sharedRead = await callTool(readTool(toolsA), { path: "shared/shared-doc.md" });
  assert.equal(sharedRead.isError, undefined);
  assert.match((sharedRead.content[0].text ?? ""), /alpha and beta shared content/);
  assert.equal((await callTool(readTool(toolsB), { path: "shared/sub/inside.md" })).isError, undefined);
  const sharedLs = await callTool(lsTool(toolsA), { path: "shared" });
  assert.equal(sharedLs.isError, undefined);
  assert.match((sharedLs.content[0].text ?? ""), /shared-doc\.md/);
  assert.match((sharedLs.content[0].text ?? ""), /sub\/?/);
  const sharedGrep = await callTool(grepTool(toolsA), { pattern: "deeper shared", path: "shared" });
  assert.equal(sharedGrep.isError, undefined);
  assert.match((sharedGrep.content[0].text ?? ""), /deeper shared content/);
  const sharedFind = await callTool(findTool(toolsA), { pattern: "**/inside.md", path: "shared" });
  assert.equal(sharedFind.isError, undefined);
  assert.match((sharedFind.content[0].text ?? ""), /inside\.md/);
});

// 3. 符号链接（文件、目录、断链）无论直接还是递归访问，都不能跟随到另一会话/实例配置/外部目录/shared/同根环回。
test("symlinks are never dereferenced even when listed or discovered through find", async (t) => {
  const { directory, rootA, rootB, sharedDir, layout, toolsA } = await setupTwoThreads(t);
  const outside = join(directory, "outside");
  const otherRoot = join(rootB, "trip-note.md");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "OUTSIDE-CONTENT");
  await writeFile(join(outside, "deeper.txt"), "OUTSIDE-DEEPER");
  await mkdir(join(outside, "sub"), { recursive: true });
  await writeFile(join(outside, "sub/hidden.md"), "OUTSIDE-HIDDEN");
  await writeFile(otherRoot, "OTHER-SESSION-CONTENT");
  await writeFile(join(layout.root, "config.json"), JSON.stringify({ token: "INSTANCE-CONFIG" }));
  await writeFile(join(sharedDir, "shared-secret.md"), "SHARED-CONTENT");

  // 在 A 的私有目录中创建指向目标的链接；目标内容必须不被任何工具读取。
  await symlink(join(outside, "secret.md"), join(rootA, "link-file"));
  await symlink(outside, join(rootA, "link-dir"));
  await symlink(join(layout.root, "config.json"), join(rootA, "link-config"));
  await symlink(otherRoot, join(rootA, "link-other-session"));
  await symlink(join(sharedDir, "shared-secret.md"), join(rootA, "link-shared"));
  await symlink(rootA, join(rootA, "self-loop"));
  await symlink(join(outside, "does-not-exist"), join(rootA, "broken-link"));

  const denials = ["link-file", "link-dir", "link-config", "link-other-session", "link-shared", "self-loop", "broken-link"];
  for (const path of denials) {
    den(await callTool(readTool(toolsA), { path }));
    den(await callTool(grepTool(toolsA), { pattern: "anything", path }));
    den(await callTool(findTool(toolsA), { pattern: "*", path }));
    den(await callTool(lsTool(toolsA), { path }));
  }
  // find 暴露根名时，链接本身的 fs 名字可能会出现，但目标/后代文件与外部内容不能被列出
  const findResult = await callTool(findTool(toolsA), { pattern: "**/*" });
  assert.equal(findResult.isError, undefined);
  const findOutput = findResult.content[0].text ?? "";
  assert.doesNotMatch(findOutput, /OUTSIDE-CONTENT|OUTSIDE-DEEPER|OUTSIDE-HIDDEN|OTHER-SESSION-CONTENT|INSTANCE-CONFIG|SHARED-CONTENT/);
  for (const forbidden of ["secret.md", "deeper.txt", "hidden.md", "config.json", "trip-note.md", "shared-secret.md"]) {
    assert.doesNotMatch(findOutput, new RegExp(forbidden));
  }

  // 根目录级扫描也必须跳过链接，不能只拦直接访问链接的参数。
  const grepResult = await callTool(grepTool(toolsA), { pattern: "OUTSIDE|OTHER-SESSION|INSTANCE-CONFIG|SHARED-CONTENT", path: "." });
  assert.equal(grepResult.isError, undefined);
  assert.match(grepResult.content[0].text ?? "", /No matches found/);
  const listed = await callTool(lsTool(toolsA), { path: "." });
  assert.equal(listed.isError, undefined);
  assert.doesNotMatch(listed.content[0].text ?? "", /link-|self-loop|broken-link/);
  assert.equal(resolveWorkspacePath(rootA, join(outside, "secret.md"), sharedDir), null);
  await assert.rejects(safeWorkspacePath(rootA, join(outside, "secret.md"), { boundaryDir: layout.workspaceDir }), UnsafeFilePathError);
});

// 4. 把 root/threads 容器/shared 容器替换为符号链接后，初始化必须拒绝；不通过链接为别的会话创建目录。
test("ensuring layout refuses when container or shared is a symlink and never creates directories via a symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-iso-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  // 三个容器先建空目录后再用链接替换为外部目标；初始化必须因为 lstat 是链接而拒绝。
  await mkdir(join(directory, "workspace"), { recursive: true });
  await mkdir(join(directory, "workspace", "threads"), { recursive: true });
  await mkdir(join(directory, "workspace", "shared"), { recursive: true });
  await mkdir(join(directory, "workspace", "threads", "local-main"), { recursive: true });

  // 替换 threads 容器为指向外部的链接：必须抛出，且不能在外部创建任何目录。
  const outsideDecoy = join(directory, "outside-decoy");
  await rm(join(directory, "workspace", "threads"), { recursive: true, force: true });
  await symlink(outsideDecoy, join(directory, "workspace", "threads"));
  await assert.rejects(ensureThreadLayout(layout), /Unsafe workspace directory/);
  const { stat } = await import("node:fs/promises");
  assert.equal(await stat(outsideDecoy).catch(() => null), null);

  // 替换 shared 容器：失败并保留目标目录的现有内容。
  await rm(join(directory, "workspace", "threads"), { recursive: true, force: true });
  await mkdir(join(directory, "workspace", "threads"), { recursive: true });
  const fakeShared = join(directory, "shared-decoy");
  await mkdir(fakeShared);
  await writeFile(join(fakeShared, "pre-existing"), "keep-me");
  await rm(join(directory, "workspace", "shared"), { recursive: true, force: true });
  await symlink(fakeShared, join(directory, "workspace", "shared"));
  await assert.rejects(ensureThreadLayout(layout), /Unsafe workspace directory/);
  assert.equal(await readFile(join(fakeShared, "pre-existing"), "utf8"), "keep-me");

  // 替换某个 threadId 的私有目录为指向外部的链接：ensureThreadWorkspace 必须失败，不得替外部创建子目录。
  await rm(join(directory, "workspace", "shared"), { recursive: true, force: true });
  await mkdir(join(directory, "workspace", "shared"), { recursive: true });
  await rm(join(directory, "workspace", "threads"), { recursive: true, force: true });
  await mkdir(join(directory, "workspace", "threads"), { recursive: true });
  await mkdir(join(directory, "workspace", "threads", "local-main"), { recursive: true });
  const externalTarget = join(directory, "external-thread-decoy");
  await rm(join(directory, "workspace", "threads", "local-main"), { recursive: true, force: true });
  await symlink(externalTarget, join(directory, "workspace", "threads", "local-main"));
  await assert.rejects(ensureThreadWorkspace(layout, "local-main"), /Unsafe workspace directory/);
  assert.equal(await stat(externalTarget).catch(() => null), null);

  // 链接全部清空再初始化，所有容器与 local-main 私有目录都应是真实目录。
  await rm(join(directory, "workspace", "threads", "local-main"), { force: true });
  await rm(join(directory, "workspace", "threads"), { recursive: true, force: true });
  await rm(join(directory, "workspace", "shared"), { recursive: true, force: true });
  await ensureThreadLayout(layout);
  for (const directory of [
    layout.root, layout.sessionsDir, layout.workspaceDir,
    join(layout.workspaceDir, "threads"),
    sharedWorkspaceDir(layout),
    threadWorkspaceDir(layout, "local-main"),
  ]) {
    const stats = await stat(directory);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
  }
});

// 5. readOnlyFiles 只能让精确 SKILL.md 被读；邻居/同目录其他文件、ls/grep/find 都不放宽；符号链接的 SKILL 必须拒绝。
test("readOnlyFiles opens only the exact SKILL.md path; siblings, listing tools and a symlinked SKILL stay locked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-iso-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  await ensureThreadLayout(layout);
  // skills 位置与 thread 容器并列；不能因 readOnlyFiles 解锁兄弟目录
  const skillsBase = join(directory, "skills");
  const skillPath = join(skillsBase, "weather", "SKILL.md");
  const siblingPath = join(skillsBase, "weather", "OTHER.md");
  await mkdir(join(skillsBase, "weather"), { recursive: true });
  await writeFile(skillPath, "# weather skill\nbody");
  await writeFile(siblingPath, "private neighbour");
  // thread 里再放一份普通文件，验证 ls/grep/find 不因 SKILL 路径被读取而扩大视野
  const rootA = threadWorkspaceDir(layout, "local-main");
  await ensureThreadWorkspace(layout, "local-main");
  await writeFile(join(rootA, "inside.md"), "alpha");

  const tools = createFileTools(rootA, sharedWorkspaceDir(layout), {
    boundaryDir: layout.workspaceDir,
    readOnlyFiles: [skillPath],
  });

  // 精确 SKILL.md 路径可读
  const readSkill = await callTool(readTool(tools), { path: skillPath });
  assert.equal(readSkill.isError, undefined);
  const skillText = readSkill.content.map((block) => block.text).join("");
  assert.match(skillText, /weather skill/);

  // 同目录邻居、其他文件名都必须拒绝
  for (const path of [siblingPath, join(skillsBase, "weather", "ABSENT.md"), join(skillsBase, "weather"), join(skillsBase, "OTHER.md")]) {
    den(await callTool(readTool(tools), { path }));
  }
  // ls/grep/find 不能越过 thread 容器看到 skills：列出的是 thread 的内容
  const ls = await callTool(lsTool(tools), { path: "." });
  assert.equal(ls.isError, undefined);
  assert.match((ls.content[0].text ?? ""), /inside\.md/);
  assert.doesNotMatch((ls.content[0].text ?? ""), /SKILL\.md|sibling|weather/);
  const grep = await callTool(grepTool(tools), { pattern: "weather skill", path: "." });
  assert.equal(grep.isError, undefined);
  assert.doesNotMatch((grep.content[0].text ?? ""), /weather skill/);
  const find = await callTool(findTool(tools), { pattern: "**/*.md" });
  assert.equal(find.isError, undefined);
  assert.doesNotMatch((find.content[0].text ?? ""), /SKILL\.md|OTHER\.md|weather/);

  // 把 SKILL.md 换成符号链接（指向 thread 已有文件），read 仍然拒绝访问
  await rm(skillPath);
  await symlink(join(rootA, "inside.md"), skillPath);
  den(await callTool(readTool(tools), { path: skillPath }));
});

// 6. PNG 文件读取仍返回 image 类型内容（即便 sandbox 拒绝进入 vision model 渲染）。
test("reading a valid PNG file returns an image content block", async (t) => {
  const { rootA, toolsA } = await setupTwoThreads(t);
  const pngPath = join(rootA, "logo.png");
  await writeFile(pngPath, PNG_1X1);
  const result = await callTool(readTool(toolsA), { path: "logo.png" });
  assert.equal(result.isError, undefined);
  const block = result.content.find((content) => content.type === "image");
  assert.ok(block, "expected an image block for a PNG read");
  assert.equal(block?.mimeType, "image/png");
  assert.ok(block?.data && block.data.length > 0, "image block should carry non-empty base64 data");
});

// 7. 两个会话对同一 shared 文件并发提交审批，只能有一个真正写入。
test("two sessions approving the same shared file only let one commit, even when versions race", async (t) => {
  const { directory, layout, rootA, rootB, sharedDir } = await setupTwoThreads(t);
  await writeFile(join(sharedDir, "note.md"), "original");
  const repository = memoryRepository();
  const actions = createActionService(repository);

  // 两个动作并发提交审批；同时落定后 commitFile 的共享队列让第一个提交，第二个因版本号变化被拒。
  const ready = deferred<void>();
  let count = 0;
  const approving: Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution"> = {
    markExecuting: actions.markExecuting,
    finishExecution: actions.finishExecution,
    submit: async (...args: Parameters<ActionService["submit"]>) => {
      const action = await actions.submit(...args);
      if (++count === 2) ready.resolve();
      await ready.promise;
      await actions.decide(action.id, "approve");
      return action;
    },
    poll: actions.poll,
    cancel: actions.cancel,
  };
  const factoryA = createWritableFileTools(rootA, approving, 5_000, { spaceId: "local-main", runId: "run-a" }, sharedDir, layout.workspaceDir);
  const factoryB = createWritableFileTools(rootB, approving, 5_000, { spaceId: "trip-2026", runId: "run-b" }, sharedDir, layout.workspaceDir);
  const writeTool = (tools: WriteTools) => tools.find((tool) => tool.name === "write")!;
  const results = await Promise.all([
    callTool(writeTool(factoryA), { path: "shared/note.md", content: "from-A" }),
    callTool(writeTool(factoryB), { path: "shared/note.md", content: "from-B" }),
  ]);
  const wins = results.filter((result) => !result.isError);
  const losses = results.filter((result) => result.isError === true);
  assert.equal(wins.length, 1, "exactly one session should commit a clean approval");
  assert.equal(losses.length, 1, "the racing approval must be refused for version change");
  // shared 目录只多出一个 note.md，内容来自赢的会话
  const newContent = await readFile(join(sharedDir, "note.md"), "utf8");
  assert.match(newContent, /^(from-A|from-B)$/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(sharedDir)).sort(), ["note.md"]);
  const decided = await actions.list();
  // 两个 pending 都进入 approved/denied 流程：失败者是基线版本变更被拒绝，不是被人 deny
  assert.equal(decided.length, 2);
  for (const action of decided) {
    assert.equal(action.status === "approved" || action.status === "denied", true);
  }
});
