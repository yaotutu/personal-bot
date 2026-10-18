import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadSubagentRoles } from "../../src/adapters/storage/subagent-roles.js";

/**
 * 子代理角色发现单测：只验证 src/adapters/storage/subagent-roles.ts 的边界。
 *
 * 关键事实：
 * - userDirectory 缺失（ENOENT）不抛错，回退到 4 个内置资产。
 * - userDirectory 可以新增同名覆盖，不允许 `model` 字段、空 prompt、空描述、坏 tools。
 * - 文件或目录的 symlink 一律拒绝，绝对路径与上层 `.pi` 不被自动发现。
 * - 错误消息不输出 user frontmatter/body 内容（避免把 prompt 当 stderr 暴露）。
 *
 * 本测试不调用模型，仅依赖文件系统；pnpm exec tsx --test 可独立运行。
 */

type RoleParts = {
  name: string;
  description?: string;
  tools?: string;
  model?: string;
  body?: string;
};

const roleYaml = ({ name, description = "Role description provided by tests.", tools, model, body = "## Body\n\ndo work" }: RoleParts) => {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (tools !== undefined) lines.push(`tools: ${tools}`);
  if (model !== undefined) lines.push(`model: ${model}`);
  lines.push("---", "", body);
  return lines.join("\n");
};

const tmpDir = async (t: { after: (fn: () => Promise<void>) => void }, prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const EXPECTED_BUILTIN_NAMES = ["planner", "reviewer", "scout", "worker"];

test("missing user directory falls back to the 4 built-in roles without throwing", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-missing-");
  const missing = join(root, "absent");
  const roles = await loadSubagentRoles(missing);
  assert.deepEqual(roles.map((role) => role.name).sort(), EXPECTED_BUILTIN_NAMES);
  for (const role of roles) {
    assert.equal(typeof role.description, "string");
    assert.ok(role.description.trim().length > 0, "description must not be empty");
    assert.ok(role.systemPrompt.trim().length > 0, "systemPrompt must not be empty");
  }
});

test("user directory adds a new role and may override a same-named built-in", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-add-");
  await writeFile(join(root, "guide.md"), roleYaml({ name: "guide", description: "guide role for tests" }));
  await writeFile(join(root, "scout.md"), roleYaml({ name: "scout", description: "fast structured recon replacement" }));
  const roles = await loadSubagentRoles(root);
  // 用户覆盖同名角色时 Map.set 替换条目，最终名集合仍是 5 个（4 内置 + 1 新增），
  // 用户版 `scout` 取代内置版的 description/systemPrompt。
  const names = roles.map((role) => role.name).sort();
  assert.deepEqual(names, ["guide", "planner", "reviewer", "scout", "worker"]);
  const scout = roles.find((role) => role.name === "scout");
  assert.equal(scout?.description, "fast structured recon replacement");
  assert.ok(scout && scout.systemPrompt.includes("do work"));
});

test("user role with model frontmatter is rejected so role never inherits an external model", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-model-");
  await writeFile(join(root, "expensive.md"), roleYaml({ name: "expensive", model: "claude-opus-4-1" }));
  await assert.rejects(loadSubagentRoles(root), /Invalid subagent definition/);
});

test("user role with empty body or empty description is rejected", async (t) => {
  const emptyBody = await tmpDir(t, "personal-bot-roles-empty-body-");
  await writeFile(join(emptyBody, "void.md"), roleYaml({ name: "void", body: "   \n  " }));
  await assert.rejects(loadSubagentRoles(emptyBody), /Invalid subagent definition/);

  const emptyDesc = await tmpDir(t, "personal-bot-roles-empty-desc-");
  await writeFile(join(emptyDesc, "silent.md"), roleYaml({ name: "silent", description: "   " }));
  await assert.rejects(loadSubagentRoles(emptyDesc), /Invalid subagent definition/);
});

test("user role with malformed tools is rejected (non-list / identifier-shaped list)", async (t) => {
  const csvBad = await tmpDir(t, "personal-bot-roles-tools-csv-");
  await writeFile(join(csvBad, "toolbreak.md"), roleYaml({ name: "toolbreak", tools: "123, bad one" }));
  await assert.rejects(loadSubagentRoles(csvBad), /Invalid subagent definition/);

  const listBad = await tmpDir(t, "personal-bot-roles-tools-list-");
  await writeFile(join(listBad, "toolnum.md"),
    "---\nname: toolnum\ndescription: bad tools frontmatter\ntools: 42\n---\n# body\n");
  await assert.rejects(loadSubagentRoles(listBad), /Invalid subagent definition/);

  const listShape = await tmpDir(t, "personal-bot-roles-tools-shape-");
  await writeFile(join(listShape, "toolshape.md"),
    '---\nname: toolshape\ndescription: bad tools list shape\ntools: ["bad name"]\n---\n# body\n');
  await assert.rejects(loadSubagentRoles(listShape), /Invalid subagent definition/);
});

test("user directory passed as a symlink is rejected as an invalid directory", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-dir-symlink-");
  const real = join(root, "real");
  await mkdir(real);
  await writeFile(join(real, "x.md"), roleYaml({ name: "realrole" }));
  const link = join(root, "link");
  await symlink(real, link);
  await assert.rejects(loadSubagentRoles(link), /Invalid subagent directory/);
});

test("a role file that is itself a symlink is rejected as an invalid definition", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-file-symlink-");
  const real = join(root, "real.md");
  await writeFile(real, roleYaml({ name: "real" }));
  const link = join(root, "link.md");
  await symlink(real, link);
  await assert.rejects(loadSubagentRoles(root), /Invalid subagent definition/);
});

test("rejection messages do not leak description, body or file content", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-leak-");
  const marker = "SECRET-MARKER-XYZ-1234567890";
  // 让角色因 model 字段被拒绝，从而真正进入 reject 路径。
  await writeFile(join(root, "leak.md"), roleYaml({
    name: "leaky",
    description: `${marker}-description`,
    body: `${marker}-body\nSECRET-AGENT-DETAIL`,
    model: "external-secret-model",
  }));
  await assert.rejects(loadSubagentRoles(root), (error: Error) => {
    assert.ok(!error.message.includes(`${marker}-description`), "frontmatter description leaked");
    assert.ok(!error.message.includes(`${marker}-body`), "body leaked");
    assert.ok(!error.message.includes("SECRET-AGENT-DETAIL"), "body content leaked");
    assert.ok(!error.message.includes("external-secret-model"), "model value leaked");
    assert.ok(!error.message.includes("/private"), "absolute tmp path leaked");
    assert.match(error.message, /^Invalid subagent/);
    return true;
  });
});

test("function only reads the supplied user directory; tmp/.pi/agents neighbours are ignored", async (t) => {
  const root = await tmpDir(t, "personal-bot-roles-isolated-");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", "leak.md"), roleYaml({ name: "leak", description: "must not be read" }));
  await mkdir(join(root, "subagents"), { recursive: true });
  await writeFile(join(root, "subagents", "leak2.md"), roleYaml({ name: "leak2", description: "must not be read either" }));
  const roles = await loadSubagentRoles(root);
  assert.deepEqual(roles.map((role) => role.name).sort(), EXPECTED_BUILTIN_NAMES);
});
