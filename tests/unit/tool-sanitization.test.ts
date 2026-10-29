import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { guardTool } from "../../src/adapters/pi/tools/path-guard.js";

/**
 * guardTool 对 fs 抛出的 ENOENT/ENOTDIR 必须返回受控 "File not found."，
 * 而不是让 SDK 的原始错误信息（如带绝对路径的 Error.message）落到 toolResult，
 * 被下一次模型读取后回显给用户。
 */
const fakeDefinition = (failure: (path: string) => Promise<unknown>): ToolDefinition<any, any> => ({
  name: "read", label: "Read", description: "test", parameters: Type.Object({
    path: Type.String(),
  }),
  execute: async (_id, params) => failure((params as { path: string }).path) as Promise<AgentToolResult<any>>,
});

test("guardTool catches ENOENT and returns controlled File not found instead of leaking the absolute path", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-guard-enoent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = fakeDefinition(async () => {
    const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${root}/secret.txt'`);
    error.code = "ENOENT";
    throw error;
  });
  const guarded = guardTool(definition, root);
  const result = await guarded.execute("call", { path: "secret.txt" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { denied: true });
  // 受控文案内不能携带绝对路径或原始 SDK/Node 错误细节。
  const text = (result.content[0] as { text: string }).text;
  assert.equal(text, "File not found.");
  assert.ok(!text.includes(root));
});

test("guardTool catches ENOTDIR and returns controlled File not found", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-guard-enotdir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = fakeDefinition(async () => {
    const error: NodeJS.ErrnoException = new Error("ENOTDIR: not a directory, scandir '/Users/secret/something'");
    error.code = "ENOTDIR";
    throw error;
  });
  const guarded = guardTool(definition, root);
  const result = await guarded.execute("call", { path: "treat-as-file.txt" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { denied: true });
  assert.equal((result.content[0] as { text: string }).text, "File not found.");
});

test("guardTool rethrows non-ENOENT errors so they fall through to generic sanitization", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-guard-eacces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = fakeDefinition(async () => {
    const error: NodeJS.ErrnoException = new Error("EACCES: permission denied, open '/etc/shadow'");
    error.code = "EACCES";
    throw error;
  });
  const guarded = guardTool(definition, root);
  // EACCES 不是 not-found，guardTool 故意不吞，交给上层 execution.ts 做通用脱敏。
  await assert.rejects(
    () => guarded.execute("call", { path: "blocked.txt" }, undefined, undefined, {} as never),
    (error: NodeJS.ErrnoException) => error.code === "EACCES",
  );
});

test("guardTool still refuses unsafe paths and validates readOnly skill paths", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-guard-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillFile = join(root, "skill-assets", "demo", "SKILL.md");
  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(skillFile, "# demo skill");
  const calls: unknown[] = [];
  const definition: ToolDefinition<any, any> = {
    name: "read", label: "Read", description: "test", parameters: Type.Object({
      path: Type.String(),
    }),
    execute: async (_id, params) => {
      calls.push((params as { path: string }).path);
      return { content: [{ type: "text", text: "skill body" }], details: undefined };
    },
  };
  const guarded = guardTool(definition, root, undefined, {
    readOnlyFiles: [{ path: skillFile, root: dirname(skillFile), boundaryDir: dirname(dirname(skillFile)) }],
  });
  const allowed = await guarded.execute("call", { path: skillFile }, undefined, undefined, {} as never);
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(allowed.content, [{ type: "text", text: "skill body" }]);
  assert.deepEqual(calls, [skillFile]);

  const denied = await guarded.execute("call", { path: "../secret.txt" }, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.details, { denied: true });
  assert.equal((denied.content[0] as { text: string }).text, "Access denied: path is outside the documents directory or contains a symlink.");
});
