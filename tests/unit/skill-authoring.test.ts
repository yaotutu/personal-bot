import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createActionService } from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createSkillRepository } from "../../src/adapters/storage/skill-repository.js";
import { createSkillsService } from "../../src/features/skills/service.js";
import { createSkillsTool } from "../../src/adapters/pi/tools/skills.js";
import { presentApproval } from "../../src/http/approval-presenters.js";

const validSkill = `---\nname: recipe-helper\ndescription: Collect and apply the user's recipe preferences.\n---\n# Recipe helper\nUse metric units.\n`;

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

const fixture = async (t: TestContext, writable = true) => {
  const root = await mkdtemp(join(tmpdir(), "skill-authoring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  const repository = createSkillRepository(layout);
  const service = createSkillsService(repository);
  const actions = createActionService(memoryRepository());
  const tool = createSkillsTool({
    layout,
    skills: service,
    actions,
    timeoutMs: 5_000,
    saveEnabled: writable,
    spaceId: "local-main",
  });
  return { root, layout, repository, service, actions, tool };
};

const approving = (
  actions: ReturnType<typeof createActionService>,
  beforeApprove: (action: PendingAction) => Promise<void> = async () => {},
) => {
  const submit = async (...args: Parameters<typeof actions.submit>) => {
    const action = await actions.submit(...args);
    await beforeApprove(action);
    await actions.decide(action.id, "approve");
    return action;
  };
  return { ...actions, submit };
};

const denying = (actions: ReturnType<typeof createActionService>) => ({
  ...actions,
  submit: async (...args: Parameters<typeof actions.submit>) => {
    const action = await actions.submit(...args);
    await actions.decide(action.id, "deny");
    return action;
  },
});

const call = async (
  tool: ReturnType<typeof createSkillsTool>,
  params: Parameters<typeof tool.execute>[1],
  signal?: AbortSignal,
) => tool.execute("test-call", params, signal, undefined, {} as never);

const text = (result: Awaited<ReturnType<typeof call>>) => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text tool result");
  return block.text;
};

test("skills save validates with pi, creates default-off instance skill, and previews skill scope", async (t) => {
  const { layout, service, actions, tool } = await fixture(t);
  const approvingTool = createSkillsTool({
    layout,
    skills: service,
    actions: approving(actions),
    timeoutMs: 5_000,
    saveEnabled: true,
    spaceId: "local-main",
  });
  const result = await call(approvingTool, { action: "save", name: "recipe-helper", content: validSkill });
  assert.notEqual(result.isError, true);
  assert.equal(await readFile(join(layout.skillsDir, "recipe-helper", "SKILL.md"), "utf8"), validSkill);
  assert.deepEqual(JSON.parse(await readFile(join(layout.skillsDir, "recipe-helper", "config.json"), "utf8")), { defaultEnabled: false });
  const listed = await service.describeAuthoring("local-main");
  assert.deepEqual(listed.skills.find((skill) => skill.name === "recipe-helper"), {
    name: "recipe-helper",
    description: "Collect and apply the user's recipe preferences.",
    source: "user",
    defaultEnabled: false,
    enabled: false,
  });
  const [action] = await actions.list();
  assert.equal(action.kind, "file_write");
  assert.equal(action.workspaceSpaceId, null);
  assert.equal(presentApproval(action).preview.scope, "skill");
  assert.equal(presentApproval(action).preview.path, "recipe-helper/SKILL.md");
  assert.match(text(result), /defaultEnabled=false/);
});

test("built-in overwrite lands only in the instance copy and remains disabled by default", async (t) => {
  const { layout, actions, service, tool } = await fixture(t);
  const builtin = await serviceBuiltInWriteFile();
  const content = validSkill.replace("recipe-helper", "write");
  void tool;
  const approvingTool = createSkillsTool({
    layout,
    skills: service,
    actions: approving(actions),
    timeoutMs: 5_000,
    saveEnabled: true,
    spaceId: "local-main",
  });
  const result = await call(approvingTool, { action: "save", name: "write", content });
  assert.notEqual(result.isError, true);
  assert.equal(await readFile(join(layout.skillsDir, "write", "SKILL.md"), "utf8"), content);
  assert.notEqual(await readFile(builtin, "utf8"), content);
  const [action] = await actions.list();
  const view = presentApproval(action);
  assert.equal(view.preview.scope, "skill");
  assert.equal(view.preview.ownerSpaceId, null);
});

test("skill save rejects invalid names, files, formats, symlinks, code, and config edits before approval", async (t) => {
  const { layout, actions, tool } = await fixture(t);
  const invalid = [
    { action: "save" as const, name: "Bad_Name", content: validSkill },
    { action: "save" as const, name: "recipe-helper", file: "../SKILL.md", content: "x" },
    { action: "save" as const, name: "recipe-helper", file: "references/code.ts", content: "x" },
    { action: "save" as const, name: "recipe-helper", file: "config.json", content: "{}" },
    { action: "save" as const, name: "recipe-helper", content: "---\nname: other\ndescription: Bad name.\n---\n" },
    { action: "save" as const, name: "recipe-helper", content: "---\ndescription: Missing name.\n---\n" },
    { action: "save" as const, name: "recipe-helper", content: "---\ndescription: Body name is not metadata.\n---\nname: recipe-helper\n" },
    { action: "save" as const, name: "recipe-helper", file: "references/nested/SKILL.md", content: "# nested skill\n" },
    { action: "save" as const, name: "recipe-helper", content: "a\ud800" },
  ];
  for (const params of invalid) assert.equal((await call(tool, params)).isError, true);

  const existing = join(layout.skillsDir, "linked-skill");
  await mkdir(join(existing, "references"), { recursive: true });
  await writeFile(join(existing, "SKILL.md"), validSkill.replace("recipe-helper", "linked-skill"));
  await symlink(join(layout.root, "outside.txt"), join(existing, "references", "note.md"));
  assert.equal((await call(tool, { action: "read", name: "linked-skill", file: "references/note.md" })).isError, true);
  assert.equal((await call(tool, {
    action: "save",
    name: "linked-skill",
    file: "references/note.md",
    content: "replacement",
  })).isError, true);
  assert.deepEqual(await actions.list(), []);
  assert.equal((await lstat(join(existing, "references", "note.md"))).isSymbolicLink(), true);
});

test("skill resources require an existing valid instance skill and reject invalid UTF-8", async (t) => {
  const { layout, actions, service, tool } = await fixture(t);
  assert.equal((await call(tool, {
    action: "save",
    name: "write",
    file: "references/new.md",
    content: "orphan",
  })).isError, true);

  const skillDir = join(layout.skillsDir, "recipe-helper");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), validSkill);
  await writeFile(join(skillDir, "config.json"), JSON.stringify({ defaultEnabled: false }));
  await writeFile(join(skillDir, "references", "broken.md"), Buffer.from([0xff, 0xfe, 0x00]));
  assert.equal((await call(tool, { action: "read", name: "recipe-helper", file: "references/broken.md" })).isError, true);
  assert.equal((await call(tool, {
    action: "save",
    name: "recipe-helper",
    file: "references/broken.md",
    content: "replacement",
  })).isError, true);
  assert.deepEqual(await actions.list(), []);

  const approvingTool = createSkillsTool({
    layout,
    skills: service,
    actions: approving(actions),
    timeoutMs: 5_000,
    saveEnabled: true,
    spaceId: "local-main",
  });
  const result = await call(approvingTool, {
    action: "save",
    name: "recipe-helper",
    file: "references/tips.md",
    content: "valid resource",
  });
  assert.notEqual(result.isError, true);
  assert.equal(await readFile(join(skillDir, "references", "tips.md"), "utf8"), "valid resource");
});

test("skill saves share deny, cancellation, and file-version approval semantics", async (t) => {
  const first = await fixture(t);
  const denyTool = createSkillsTool({
    layout: first.layout,
    skills: first.service,
    actions: denying(first.actions),
    timeoutMs: 5_000,
    saveEnabled: true,
    spaceId: "local-main",
  });
  const denied = await call(denyTool, { action: "save", name: "recipe-helper", content: validSkill });
  assert.equal(denied.isError, true);
  assert.equal(await stat(first.layout.skillsDir).catch(() => null), null);

  const second = await fixture(t);
  const controller = new AbortController();
  const cancelled = call(second.tool, { action: "save", name: "recipe-helper", content: validSkill }, controller.signal);
  controller.abort();
  assert.equal((await cancelled).isError, true);
  assert.equal(await stat(second.layout.skillsDir).catch(() => null), null);

  const third = await fixture(t);
  const target = join(third.layout.skillsDir, "recipe-helper", "SKILL.md");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, validSkill);
  const before = await readFile(target, "utf8");
  const conflictTool = createSkillsTool({
    layout: third.layout,
    skills: third.service,
    actions: approving(third.actions, async () => {
      await writeFile(target, `${before}\nHuman changed this after approval preview.\n`);
    }),
    timeoutMs: 5_000,
    saveEnabled: true,
    spaceId: "local-main",
  });
  const conflict = await call(conflictTool, { action: "save", name: "recipe-helper", content: `${before}\nModel version.\n` });
  assert.equal(conflict.isError, true);
  assert.match(await readFile(target, "utf8"), /Human changed/);
});

test("writable gate keeps list/read available while save is controlled", async (t) => {
  const { layout, tool } = await fixture(t, false);
  const directory = join(layout.skillsDir, "disabled-readable");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), validSkill.replace("recipe-helper", "disabled-readable"));
  await writeFile(join(directory, "config.json"), JSON.stringify({ defaultEnabled: false }));
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(join(directory, "references", "tips.md"), "reference text");
  const list = await call(tool, { action: "list" });
  assert.notEqual(list.isError, true);
  assert.match(text(list), /disabled-readable/);
  assert.equal(text(await call(tool, { action: "read", name: "disabled-readable" })).includes("metric units"), true);
  assert.equal(text(await call(tool, { action: "read", name: "disabled-readable", file: "references/tips.md" })), "reference text");
  assert.equal((await call(tool, { action: "save", name: "another-skill", content: validSkill })).isError, true);
  assert.equal(await readdir(join(layout.root, "skills", "another-skill")).catch(() => null), null);
});

const serviceBuiltInWriteFile = async () => {
  const { getBuiltinSkillsDir } = await import("../../src/adapters/storage/builtin-skills.js");
  return join(getBuiltinSkillsDir(), "write", "SKILL.md");
};
