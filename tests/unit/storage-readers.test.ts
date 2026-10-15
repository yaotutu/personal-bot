import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { defaultIdentity } from "../../src/features/identity/types.js";

const setup = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-storage-readers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "document.json") };
};

// R7A 独立变更错误策略：缺失可以初始化，损坏/读取失败必须阻止读改写。
// 参数化只共享文件保护断言，各 reader 仍按自己的旧格式和非法输入验证。
for (const kind of ["memory", "jobs"] as const) {
  const empty = kind === "memory" ? { memories: [], identity: defaultIdentity } : [];
  const validSource = JSON.stringify(empty);
  const createRepository = kind === "memory" ? createMemoryRepository : createJobRepository;

  test(`${kind} defaults only a missing file and does not create it on read`, async (t) => {
    const { directory, file } = await setup(t);
    assert.deepEqual(await createRepository(file).read(), empty);
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), []);
  });

  test(`${kind} rejects corrupted and unsupported documents without changing original bytes`, async (t) => {
    const { directory, file } = await setup(t);
    const malformed = kind === "memory"
      ? ["{broken secret", "null", "{}", "[]", '{"memories":{}}',
        '{"memories":[],"identity":{"name":1}}', '{"memories":[],"identity":[]}',
        '{"memories":[],"identity":{"showChatUpdates":"yes"}}',
        '{"memories":[],"schemaVersion":1}', '{"memories":[],"schemaVersion":999}']
      : ["{broken secret", "null", "{}", '{"jobs":[]}',
        '{"jobs":[],"schemaVersion":1}', '{"jobs":[],"schemaVersion":999}'];
    const repository = createRepository(file);
    for (const source of malformed) {
      await writeFile(file, source);
      await assert.rejects(repository.read(), InvalidDocumentError);
      let called = false;
      await assert.rejects(repository.update(() => {
        called = true;
        return { result: undefined };
      }), (error: unknown) => {
        assert.ok(error instanceof InvalidDocumentError);
        assert.equal(error.message.includes(file), false);
        assert.equal(error.message.includes("secret"), false);
        return true;
      });
      assert.equal(called, false);
      assert.equal(await readFile(file, "utf8"), source);
      assert.deepEqual(await readdir(directory), ["document.json"]);
    }
  });

  test(`${kind} propagates filesystem read errors instead of defaulting to empty`, async (t) => {
    const { directory } = await setup(t);
    const repository = createRepository(directory);
    await assert.rejects(repository.read(), { code: "EISDIR" });
    await assert.rejects(repository.update(() => ({ result: undefined })), { code: "EISDIR" });
    assert.deepEqual(await readdir(directory), []);
  });

  test(`${kind} writer recovers after the damaged file is explicitly repaired`, async (t) => {
    const { file } = await setup(t);
    const repository = createRepository(file);
    await writeFile(file, "{broken");
    await assert.rejects(repository.update(() => ({ result: undefined })), InvalidDocumentError);
    // 修复必须是调用者明确的外部动作，repository 不自动清空、不重试。
    await writeFile(file, validSource);
    if (kind === "memory") {
      await (repository as ReturnType<typeof createMemoryRepository>).update((state) => ({
        state: { ...state, identity: { ...state.identity, name: "Repaired" } }, result: undefined,
      }));
      assert.equal(JSON.parse(await readFile(file, "utf8")).identity.name, "Repaired");
    } else {
      await (repository as ReturnType<typeof createJobRepository>).update(() => ({ items: [], result: undefined }));
      assert.equal(await readFile(file, "utf8"), "[]\n");
    }
  });
}

test("tasks reader rejects any malformed record instead of dropping it", async () => {
  const { readTasksDocument } = await import("../../src/adapters/storage/document-schemas.js");
  const task = { id: "task", title: "Title", prompt: "Prompt", status: "queued", source: "web", createdAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(readTasksDocument([task]), [task]);
  for (const invalid of [null, { id: "partial", prompt: "prompt", status: "queued" },
    { ...task, source: "other" }, { ...task, status: ["queued"] }, { ...task, createdAt: "invalid" }, { ...task, result: 1 }]) {
    assert.throws(() => readTasksDocument([task, invalid]), InvalidDocumentError);
  }
});

test("session layout initialization never migrates files from the root", async (t) => {
  const { createDataLayout, ensureThreadLayout } = await import("../../src/adapters/storage/data-layout.js");
  const { directory } = await setup(t);
  const layout = createDataLayout(directory);
  await ensureThreadLayout(layout);
  const source = join(layout.sessionsDir, "old.jsonl");
  await writeFile(source, "original session");
  await ensureThreadLayout(layout);
  assert.equal(await readFile(source, "utf8"), "original session");
  assert.deepEqual(await readdir(layout.sessionsDir), ["old.jsonl"]);
});
