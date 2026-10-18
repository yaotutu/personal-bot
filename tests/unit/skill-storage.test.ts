import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDataLayout, threadSkillsFile, threadInstructionsFile } from "../../src/adapters/storage/data-layout.js";
import { createSkillRepository } from "../../src/adapters/storage/skill-repository.js";
import { createSkillsService, UnknownSkillError } from "../../src/features/skills/service.js";
import { readThreadInstructions, writeThreadInstructions } from "../../src/adapters/storage/thread-instructions.js";
import { instructionsTool } from "../../src/adapters/pi/tools/instructions.js";

const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "skill-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  const repository = createSkillRepository(layout);
  return { layout, repository, service: createSkillsService(repository) };
};

test("skill overrides only default on missing files and preserve damaged documents", async (t) => {
  const { layout, repository } = await fixture(t);
  assert.deepEqual(await repository.getThreadOverrides("a"), {});
  const file = threadSkillsFile(layout, "a");
  await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
  await mkdir(dirname(file), { recursive: true });
  for (const original of ["{broken", "[]", '{"overrides":{"cron":"yes"}}', '{"overrides":{},"schemaVersion":1}']) {
    await writeFile(file, original);
    await assert.rejects(repository.getThreadOverrides("a"), /Invalid skills-overrides document/);
    await assert.rejects(repository.setThreadOverrides("a", { cron: false }), /Invalid skills-overrides document/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("skill scanning uses pi metadata, fills only absent configs and reports invalid files", async (t) => {
  const { layout, repository } = await fixture(t);
  const directory = join(layout.skillsDir, "custom-meta");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), '---\nname: custom-meta\ndescription: >\n  Multiline skill description\n  parsed by pi.\n---\n# Body\n');
  const catalog = await repository.listSkills();
  assert.equal(catalog.skills.find((skill) => skill.name === "custom-meta")?.defaultEnabled, false);
  assert.match(catalog.skills.find((skill) => skill.name === "custom-meta")!.description, /Multiline skill description parsed by pi/);
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.path.endsWith("config.json")));
  const config = join(directory, "config.json");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  await writeFile(config, "invalid-json");
  const invalid = await repository.listSkills();
  assert.ok(invalid.diagnostics.some((diagnostic) => /original file preserved/.test(diagnostic.message)));
  assert.ok(!invalid.skills.some((skill) => skill.name === "custom-meta"));
  assert.equal(await readFile(config, "utf8"), "invalid-json");
});

test("overrides replace serially with private permissions and unknown names fail visibly", async (t) => {
  const { layout, repository, service } = await fixture(t);
  const writes = Array.from({ length: 12 }, (_, index) => repository.setThreadOverrides("a", { cron: index % 2 === 0 }));
  await Promise.all(writes);
  assert.deepEqual(await repository.getThreadOverrides("a"), { cron: false });
  assert.equal((await stat(threadSkillsFile(layout, "a"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(threadSkillsFile(layout, "a"))), ["skills.json"]);
  await assert.rejects(service.updateThreadOverrides("a", { "unknown-skill": true }), UnknownSkillError);
  await service.updateThreadOverrides("a", {});
  assert.deepEqual(await repository.getThreadOverrides("a"), {});
});

test("thread instructions share an atomic writer and a missing tool argument cannot clear rules", async (t) => {
  const { layout } = await fixture(t);
  const file = threadInstructionsFile(layout, "a");
  assert.equal(await readThreadInstructions(file), "");
  await Promise.all([writeThreadInstructions(file, "first"), writeThreadInstructions(file, "second")]);
  assert.equal(await readThreadInstructions(file), "second");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const tool = instructionsTool(layout, "a");
  const denied = await tool.execute("id", { action: "set" }, undefined, undefined, {} as never);
  assert.equal(denied.isError, true);
  assert.equal(await readThreadInstructions(file), "second");
  await tool.execute("clear", { action: "set", content: "" }, undefined, undefined, {} as never);
  assert.equal(await readThreadInstructions(file), "");
  assert.deepEqual(await readdir(dirname(file)), ["INSTRUCTIONS.md"]);
});
