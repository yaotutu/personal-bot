import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writeJsonDocument } from "../../src/adapters/storage/json-document.js";

// 每个测试独占临时目录，使用真实文件系统触发失败，不替换全局 fs 方法。
const tempDirectory = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-json-document-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("writes formatted JSON with a trailing newline and 0600 permissions", async (t) => {
  const directory = await tempDirectory(t);
  const file = join(directory, "document.json");
  const value = { name: "personal-bot", nested: { enabled: true } };

  await writeJsonDocument(file, value);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["document.json"]);

  // 原目标权限较宽时，替换后也必须使用新临时文件的 0600，而非沿用旧权限。
  await rm(file);
  await writeFile(file, "original", { mode: 0o644 });
  await writeJsonDocument(file, value);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["document.json"]);
});

test("serialization failures preserve the original file without temporary files", async (t) => {
  const directory = await tempDirectory(t);
  const file = join(directory, "document.json");
  const original = '{"original":true}\n';
  await writeFile(file, original);

  // 序列化抛错或不能得到 JSON 文本时都禁止写入，原文件应逐字保持不变。
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (const value of [circular, 1n, undefined, () => undefined, { toJSON: () => undefined }]) {
    await assert.rejects(writeJsonDocument(file, value), TypeError);
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["document.json"]);
  }

  // 自定义序列化器抛出的错误必须原样返回，不能包装或换成文件系统错误。
  const originalError = new Error("serialization failed");
  await assert.rejects(
    writeJsonDocument(file, { toJSON: () => { throw originalError; } }),
    (error: unknown) => error === originalError,
  );
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await readdir(directory), ["document.json"]);
});

test("rename failure preserves the target directory and removes the temporary file", async (t) => {
  const directory = await tempDirectory(t);
  const file = join(directory, "document.json");
  await mkdir(file);
  const originalFile = join(file, "original.txt");
  await writeFile(originalFile, "original contents");

  // 文件不能 rename 覆盖目录；用真实目标目录触发失败，并确认暴露的是 rename 原错误。
  await assert.rejects(writeJsonDocument(file, { changed: true }), {
    syscall: "rename",
    dest: file,
  });
  assert.equal((await stat(file)).isDirectory(), true);
  assert.equal(await readFile(originalFile, "utf8"), "original contents");
  assert.deepEqual(await readdir(file), ["original.txt"]);
  assert.deepEqual(await readdir(directory), ["document.json"]);
});

test("temporary write failure with a missing parent leaves no extra files", async (t) => {
  const directory = await tempDirectory(t);
  const file = join(directory, "missing", "document.json");

  // 不创建父目录；清理时的 ENOENT 不能替换首次 writeFile/open 产生的原错误。
  await assert.rejects(writeJsonDocument(file, { changed: true }), {
    code: "ENOENT",
    syscall: "open",
  });
  assert.deepEqual(await readdir(directory), []);
});
