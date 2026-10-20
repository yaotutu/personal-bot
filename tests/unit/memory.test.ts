import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { defaultIdentity } from "../../src/features/identity/types.js";
import { createMemoryService, MemoryLimitError } from "../../src/features/memory/memory-service.js";
import { renderMemoryPrompt } from "../../src/features/memory/memory-prompt.js";
import type { MemoryItem, MemoryState } from "../../src/features/memory/types.js";

const setup = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.json");
  const repository = createMemoryRepository(file);
  return {
    file, repository,
    memory: createMemoryService(repository),
    identity: createIdentityService(repository),
  };
};
const item = (id: string, text = id): MemoryItem => ({
  id, text, source: "test",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

test("memory and identity preserve the legacy file shape and survive repository recreation", async (t) => {
  const { file, repository, memory, identity } = await setup(t);
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await identity.get(), defaultIdentity);
  const added = await memory.add("  likes tea  ", "Apps UI");
  assert.equal(added.text, "likes tea");
  assert.equal(added.source, "Apps UI");
  assert.ok(added.id);
  assert.ok(Number.isFinite(Date.parse(added.createdAt)));
  const saved = await identity.save({ name: "Tea Bot", tone: "concise" });
  assert.deepEqual(saved, { ...defaultIdentity, name: "Tea Bot", tone: "concise" });
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(state).sort(), ["identity", "memories"]);
  assert.deepEqual(state, await repository.read());
  assert.deepEqual(await createMemoryRepository(file).read(), state);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("memory at the 500 item limit rejects new items instead of silently dropping the oldest", async (t) => {
  const { file, memory, identity } = await setup(t);
  const old = Array.from({ length: 500 }, (_, i) => item(`old-${i}`));
  const source = JSON.stringify({ memories: old, identity: { ...defaultIdentity, name: "Existing" } });
  await writeFile(file, source);
  await assert.rejects(memory.add(" new memory ", "chat"), MemoryLimitError);
  assert.equal(await readFile(file, "utf8"), source, "a rejected add must not touch the file");
  assert.equal((await memory.list())[0].id, "old-0");
  // 腾出位置后才能继续写入；编辑和删除在满额时仍可用。
  const edited = await memory.edit("old-3", " edited ");
  assert.equal(edited?.text, "edited");
  assert.equal(edited?.createdAt, "2026-10-10T00:00:00.000Z");
  assert.equal(edited?.source, "test");
  assert.equal(await memory.edit("missing", "ignored"), undefined);
  assert.equal(await memory.forget("old-0"), true);
  assert.equal(await memory.forget("old-0"), false);
  const added = await memory.add(" new memory ", "chat");
  const list = await memory.list();
  assert.equal(list.length, 500);
  assert.deepEqual(list.at(-1), added);
  assert.equal((await identity.get()).name, "Existing");
});

test("memory search is case-insensitive, newest-updated first, capped and ignores blank queries", async (t) => {
  const { file, memory } = await setup(t);
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...item(`tea-${i}`, `Likes TEA #${i}`),
    updatedAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
  }));
  await writeFile(file, JSON.stringify({
    memories: [...many, item("other", "likes coffee")], identity: defaultIdentity,
  }));
  const hits = await memory.search("tea");
  assert.equal(hits.length, 10);
  assert.equal(hits[0].id, "tea-11");
  assert.equal(hits[9].id, "tea-2");
  assert.equal((await memory.search("tea", 3)).length, 3);
  assert.equal((await memory.search("tea", 99)).length, 10);
  assert.deepEqual((await memory.search("COFFEE")).map((entry) => entry.id), ["other"]);
  assert.deepEqual(await memory.search("   "), []);
  assert.deepEqual(await memory.search("nothing"), []);
});

test("concurrent memory and identity writes share one complete read-modify-write queue", async (t) => {
  const { repository, memory, identity } = await setup(t);
  // 同一轮交错发出两个 feature 的修改；只串行 writeFile 本身仍会丢更新。
  await Promise.all([
    ...Array.from({ length: 30 }, (_, i) => memory.add(`fact-${i}`, "chat")),
    identity.save({ name: "Parallel" }),
    identity.save({ tone: "thoughtful" }),
    identity.save({ avatar: "tea", showChatUpdates: false }),
  ]);
  const state = await repository.read();
  assert.equal(state.memories.length, 30);
  assert.equal(new Set(state.memories.map((entry) => entry.id)).size, 30);
  assert.deepEqual(state.identity, {
    name: "Parallel", tone: "thoughtful", avatar: "tea", showChatUpdates: false,
  });
  await Promise.all([
    memory.edit(state.memories[0].id, "edited"),
    memory.forget(state.memories[1].id),
    identity.save({ name: "Renamed" }),
  ]);
  assert.equal((await memory.list()).length, 29);
  assert.equal((await memory.list())[0].text, "edited");
  assert.equal((await identity.get()).name, "Renamed");
});

test("memory rejects partial entries and identity without rewriting original bytes", async (t) => {
  const { file, repository } = await setup(t);
  for (const value of [
    { memories: [item("valid"), { id: "partial", text: "fact" }], identity: defaultIdentity },
    { memories: [], identity: { name: "Partial" } },
    { memories: [] },
  ]) {
    const source = JSON.stringify(value);
    await writeFile(file, source);
    await assert.rejects(repository.read(), /Invalid memory document/);
    await assert.rejects(repository.update(() => ({ result: undefined })), /Invalid memory document/);
    assert.equal(await readFile(file, "utf8"), source);
  }
});

test("memory missing edit and missing forget both skip writing", async (t) => {
  const { file, memory } = await setup(t);
  assert.equal(await memory.edit("missing", "ignored"), undefined);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(await memory.forget("missing"), false);
  await assert.rejects(stat(file), { code: "ENOENT" });
});

test("memory edit changes only the first match, even in a legacy file with duplicate IDs", async (t) => {
  const { file, memory } = await setup(t);
  await writeFile(file, JSON.stringify({
    memories: [item("same", "first"), item("same", "second")], identity: defaultIdentity,
  }));
  await memory.edit("same", "changed");
  assert.deepEqual((await memory.list()).map((entry) => entry.text), ["changed", "second"]);
});

test("a rejected memory update leaves the writer usable for later calls", async (t) => {
  const { repository, memory } = await setup(t);
  await assert.rejects(repository.update(() => { throw new Error("change failed"); }), /change failed/);
  const added = await memory.add("after failure", "test");
  assert.deepEqual(await memory.list(), [added]);
});

test("memory prompt only announces the count, never the memory text, and rereads settings", async (t) => {
  const state: MemoryState = {
    memories: [item("a", "  secret-fact-text  ")],
    identity: { ...defaultIdentity, name: "Tea Bot", tone: "concise" },
  };
  const original = structuredClone(state);
  const rendered = renderMemoryPrompt(state);
  assert.match(rendered, /## Long-term memory\n1 saved item\(s\) are stored but not loaded into this prompt\. Use memory_search/);
  assert.doesNotMatch(rendered, /secret-fact-text/);
  assert.match(rendered, /\n## Identity settings\n- Assistant name: Tea Bot\n- Tone: concise\n$/);
  assert.deepEqual(state, original);
  assert.equal(renderMemoryPrompt({ memories: [], identity: defaultIdentity }), "");
  assert.equal(renderMemoryPrompt({ memories: [], identity: { ...defaultIdentity, avatar: "other", showChatUpdates: false } }), "");
  const { memory, identity } = await setup(t);
  assert.equal(await memory.renderForPrompt(), "");
  await identity.save({ name: "New name" });
  assert.match(await memory.renderForPrompt(), /Assistant name: New name/);
});
