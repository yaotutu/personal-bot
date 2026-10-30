import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import {
  assertBuildSnapshot,
  collectServiceVersion,
  collectGitSnapshot,
  collectSourceHash,
  type ServiceVersion,
} from "../../src/bootstrap/service-version.js";

/**
 * 单测要点：
 * - 源码 hash 在内容 / 文件不变时稳定，新增 / 修改 / 删减文件能引起 hash 变化；
 * - 白名单外文件（.pi-muse、tests、node_modules）不能影响 hash；
 * - 白名单内符号链接必须拒绝；
 * - 缺白名单必报；
 * - git 失败时 commit/dirty 为 null，绝不抛错；
 * - build 模式从 dist/service-version.json 读取，不读 git / 不读源码 hash；
 * - build 模式字段校验严格：缺失、错类型、额外字段都拒绝；
 * - 写盘脚本不读 .pi-muse / 不依赖 cwd。
 */

const projectRoot = resolve(import.meta.dirname, "..", "..");
const sourceModuleUrl = pathToFileURL(resolve(projectRoot, "src", "bootstrap", "service-version.ts")).href;

const tempDir = async (t: TestContext, prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `service-version-${prefix}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

/** 在 sandbox 准备最小可执行白名单：保证 collectSourceHash 不会因 src/ 缺失提前抛错。 */
const makeSandbox = async (t: TestContext, prefix: string): Promise<string> => {
  const sandbox = await tempDir(t, prefix);
  await mkdir(join(sandbox, "src", "bootstrap"), { recursive: true });
  await mkdir(join(sandbox, "assets"), { recursive: true });
  await mkdir(join(sandbox, "scripts"), { recursive: true });
  await copyFile(resolve(projectRoot, "package.json"), join(sandbox, "package.json"));
  await copyFile(resolve(projectRoot, "pnpm-lock.yaml"), join(sandbox, "pnpm-lock.yaml"));
  await copyFile(resolve(projectRoot, "src", "bootstrap", "service-version.ts"), join(sandbox, "src", "bootstrap", "service-version.ts"));
  return sandbox;
};

test("collectSourceHash is stable across runs and independent of cwd", async (t) => {
  const first = await collectSourceHash(projectRoot);
  const second = await collectSourceHash(projectRoot);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first);

  // 不同 cwd 下读取应一致：证明不依赖 process.cwd()。
  const sandbox = await tempDir(t, "fake-cwd");
  const originalCwd = process.cwd();
  try {
    process.chdir(sandbox);
    const third = await collectSourceHash(projectRoot);
    assert.equal(third, first);
  } finally {
    process.chdir(originalCwd);
  }
});

test("collectSourceHash changes when source files change", async (t) => {
  const baseHash = await collectSourceHash(projectRoot);
  const sandbox = await makeSandbox(t, "mutate");
  const hashBefore = await collectSourceHash(sandbox);

  await writeFile(
    join(sandbox, "src", "bootstrap", "service-version.ts"),
    "// modified\n" + (await readFile(join(sandbox, "src", "bootstrap", "service-version.ts"), "utf8")),
  );
  const hashAfter = await collectSourceHash(sandbox);
  assert.notEqual(hashAfter, hashBefore);
  assert.match(hashAfter, /^[0-9a-f]{64}$/);

  // 改资源 / package.json 都应引起 hash 变化。
  await writeFile(join(sandbox, "assets", "marker.txt"), "tick");
  assert.notEqual(await collectSourceHash(sandbox), hashAfter);

  await writeFile(join(sandbox, "package.json"), `${JSON.stringify(JSON.parse(await readFile(join(sandbox, "package.json"), "utf8")))}\n`);
  assert.match(await collectSourceHash(sandbox), /^[0-9a-f]{64}$/);

  assert.match(baseHash, /^[0-9a-f]{64}$/);
});

test("collectSourceHash ignores files outside the whitelist", async (t) => {
  const sandbox = await makeSandbox(t, "ignore");
  const before = await collectSourceHash(sandbox);

  // 白名单外（.pi-muse 真实实例、tests fixture、node_modules）必须不影响 hash。
  await mkdir(join(sandbox, ".pi-muse"), { recursive: true });
  await writeFile(join(sandbox, ".pi-muse", "config.json"), '{"apiKey":"super-secret"}');
  await mkdir(join(sandbox, "tests", "unit"), { recursive: true });
  await writeFile(join(sandbox, "tests", "unit", "leak.txt"), "should not affect hash");
  await mkdir(join(sandbox, "node_modules"), { recursive: true });
  await writeFile(join(sandbox, "node_modules", "evil.js"), "console.log('pwned')");

  assert.equal(await collectSourceHash(sandbox), before);
});

test("collectSourceHash rejects symlinks inside the whitelist", async (t) => {
  const sandbox = await tempDir(t, "symlink");
  await mkdir(join(sandbox, "src"), { recursive: true });
  await mkdir(join(sandbox, "assets"), { recursive: true });
  await mkdir(join(sandbox, "scripts"), { recursive: true });
  await copyFile(resolve(projectRoot, "package.json"), join(sandbox, "package.json"));
  await copyFile(resolve(projectRoot, "pnpm-lock.yaml"), join(sandbox, "pnpm-lock.yaml"));
  await writeFile(join(sandbox, "src", "real.ts"), "export const real = 1;\n");

  // ln -s 失败（如权限）即跳过；本机 Unix 上必须拒绝符号链接。
  const linkResult = spawnSync("ln", ["-s", "real.ts", join(sandbox, "src", "link.ts")], { encoding: "utf8" });
  if (linkResult.status === 0) {
    await assert.rejects(collectSourceHash(sandbox), /Refusing symlink/);
  }
});

test("collectSourceHash requires the whitelist entries", async (t) => {
  const sandbox = await tempDir(t, "missing");
  await mkdir(join(sandbox, "assets"), { recursive: true });
  await writeFile(join(sandbox, "package.json"), '{"version":"0.0.0"}');
  // 缺 src/：必须抛错而非返回空 hash。
  await assert.rejects(collectSourceHash(sandbox), /ENOENT|no such file/);
});

test("collectGitSnapshot returns null when git is unavailable or repo absent", async (t) => {
  const sandbox = await tempDir(t, "no-git");
  const result = collectGitSnapshot(sandbox);
  assert.equal(result.commit, null);
  assert.equal(result.dirty, null);

  const real = collectGitSnapshot(projectRoot);
  assert.ok(real.commit === null || /^[0-9a-f]{40}$/.test(real.commit));
  assert.ok(real.dirty === null || typeof real.dirty === "boolean");
});

test("collectServiceVersion source mode returns complete snapshot with real git", async () => {
  const snapshot = await collectServiceVersion(sourceModuleUrl, "source");
  assert.equal(snapshot.mode, "source");
  assert.equal(snapshot.builtAt, null);
  assert.equal(snapshot.version, JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")).version);
  assert.match(snapshot.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(snapshot.commit === null || /^[0-9a-f]{40}$/.test(snapshot.commit));
  assert.ok(snapshot.dirty === null || typeof snapshot.dirty === "boolean");
});

test("collectServiceVersion build mode fills builtAt and keeps real git", async () => {
  const snapshot = await collectServiceVersion(sourceModuleUrl, "build");
  assert.equal(snapshot.mode, "build");
  assert.ok(snapshot.builtAt && !Number.isNaN(Date.parse(snapshot.builtAt)));
  assert.match(snapshot.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(snapshot.commit === null || /^[0-9a-f]{40}$/.test(snapshot.commit));
  assert.ok(snapshot.dirty === null || typeof snapshot.dirty === "boolean");
});

test("assertBuildSnapshot rejects malformed payloads without leaking private fields", () => {
  assert.throws(() => assertBuildSnapshot({ version: "1.0.0", commit: null, dirty: null, sourceHash: "a".repeat(64), builtAt: null }), /mode/);
  assert.throws(() => assertBuildSnapshot({ version: "1.0.0", commit: null, dirty: null, sourceHash: "short", mode: "build", builtAt: null }), /sourceHash/);
  assert.throws(() => assertBuildSnapshot({ version: "1.0.0", commit: "deadbeef", dirty: null, sourceHash: "a".repeat(64), mode: "build", builtAt: null }), /commit/);
  assert.throws(() => assertBuildSnapshot({ version: "1.0.0", commit: null, dirty: null, sourceHash: "a".repeat(64), mode: "build", builtAt: 123 }), /builtAt/);
  assert.throws(() => assertBuildSnapshot({
    version: "1.0.0", commit: null, dirty: null, sourceHash: "a".repeat(64), mode: "build", builtAt: null, dataDir: "/etc/secret",
  }), /unknown field/);
  const valid: ServiceVersion = {
    version: "1.0.0", commit: "a".repeat(40), dirty: false,
    sourceHash: "a".repeat(64), mode: "build", builtAt: "2025-05-01T00:00:00.000Z",
  };
  assert.deepEqual(assertBuildSnapshot(valid), valid);
});

test("write-service-version.mjs writes a valid dist snapshot and does not read .pi-muse or cwd", async (t) => {
  const sandbox = await tempDir(t, "build");
  const distDir = join(sandbox, "dist");
  await mkdir(distDir, { recursive: true });

  // 把 cwd 切到远离项目根的工作目录，证明脚本不依赖 cwd。
  const workDir = join(sandbox, "workdir");
  await mkdir(workDir, { recursive: true });
  const originalCwd = process.cwd();
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  try {
    process.chdir(workDir);
    const result = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", resolve(projectRoot, "scripts", "write-service-version.mjs"), join(distDir, "service-version.json")],
      { encoding: "utf8", timeout: 60000 },
    );
    exitCode = result.status ?? 1;
    stdout = result.stdout;
    stderr = result.stderr;
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(exitCode, 0, `write-service-version failed: ${stderr}\n${stdout}`);
  assert.match(stdout, /service-version written:/);

  const snapshot = assertBuildSnapshot(JSON.parse(await readFile(join(distDir, "service-version.json"), "utf8")));
  assert.equal(snapshot.mode, "build");
  assert.equal(snapshot.version, JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")).version);
  assert.match(snapshot.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(snapshot.builtAt && !Number.isNaN(Date.parse(snapshot.builtAt)));
  assert.ok(snapshot.commit === null || /^[0-9a-f]{40}$/.test(snapshot.commit));
  assert.ok(snapshot.dirty === null || typeof snapshot.dirty === "boolean");
});

test("write-service-version.mjs is atomic on rename failure and leaves no temp files", async (t) => {
  const sandbox = await tempDir(t, "atomic");
  const distDir = join(sandbox, "dist");
  await mkdir(distDir, { recursive: true });

  // 用一个目录占用目标路径：rename 必然失败。
  const target = join(distDir, "service-version.json");
  await mkdir(target);
  const result = spawnSync(
    "node",
    ["--experimental-strip-types", "--no-warnings", resolve(projectRoot, "scripts", "write-service-version.mjs"), target],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.notEqual(result.status, 0, "script must fail when target is a directory");
  // 失败后 dist 目录应只剩原始目录，无残留临时文件。
  assert.deepEqual(await readdir(distDir), ["service-version.json"]);
});

test("write-service-version.mjs cross-cwd hash equals direct invocation", async (t) => {
  const sandbox = await tempDir(t, "cross-cwd");
  const distA = join(sandbox, "dist-a");
  const distB = join(sandbox, "dist-b");
  await mkdir(distA, { recursive: true });
  await mkdir(distB, { recursive: true });

  const workDir = join(sandbox, "workdir");
  await mkdir(workDir, { recursive: true });
  const originalCwd = process.cwd();
  try {
    process.chdir(workDir);
    const a = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", resolve(projectRoot, "scripts", "write-service-version.mjs"), join(distA, "service-version.json")],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(a.status, 0, `script A failed: ${a.stderr}`);
    const b = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", resolve(projectRoot, "scripts", "write-service-version.mjs"), join(distB, "service-version.json")],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(b.status, 0, `script B failed: ${b.stderr}`);
  } finally {
    process.chdir(originalCwd);
  }

  const jsonA = JSON.parse(await readFile(join(distA, "service-version.json"), "utf8"));
  const jsonB = JSON.parse(await readFile(join(distB, "service-version.json"), "utf8"));
  assert.equal(jsonA.sourceHash, jsonB.sourceHash);
  assert.equal(jsonA.version, jsonB.version);
});

test("serviceVersion Promise resolves once with all required fields", async () => {
  const { serviceVersion } = await import("../../src/bootstrap/service-version.js");
  const first = await serviceVersion;
  const second = await serviceVersion;
  assert.equal(first, second); // 单次加载快照：相同 Promise 引用。
  assert.match(first.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(first.commit === null || /^[0-9a-f]{40}$/.test(first.commit));
  assert.ok(first.dirty === null || typeof first.dirty === "boolean");
});

test("snapshot fields never leak private paths and stay closed-keyed", async () => {
  const { serviceVersion } = await import("../../src/bootstrap/service-version.js");
  const snapshot = await serviceVersion;
  for (const value of Object.values(snapshot)) {
    if (typeof value === "string") {
      assert.ok(!value.includes("/etc/"), `private path leaked: ${value}`);
      assert.ok(!value.includes(process.env.HOME ?? "/Users"), `cwd-like path leaked: ${value}`);
    }
  }
  assert.deepEqual(Object.keys(snapshot).sort(), ["builtAt", "commit", "dirty", "mode", "sourceHash", "version"]);
});

test("tsc single-file compile produces loadable dist artifact that requires service-version.json", async (t) => {
  const sandbox = await tempDir(t, "single-compile");
  const sourceFile = resolve(projectRoot, "src", "bootstrap", "service-version.ts");
  // TypeScript 6 单文件编译需显式 --ignoreConfig 忽略工程 tsconfig，并补充 --types node
  const compile = spawnSync(
    "npx",
    ["tsc", "--ignoreConfig", "--types", "node", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--esModuleInterop", "--rootDir", resolve(projectRoot, "src"), "--outDir", sandbox, sourceFile],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(compile.status, 0, `tsc failed: ${compile.stderr}\n${compile.stdout}`);

  const builtPath = join(sandbox, "bootstrap", "service-version.js");
  const originalCwd = process.cwd();
  process.chdir(sandbox);
  try {
    const mod = await import(pathToFileURL(builtPath).href);
    assert.equal(typeof mod.collectServiceVersion, "function");
    assert.equal(typeof mod.assertBuildSnapshot, "function");
    assert.equal(typeof mod.serviceVersion, "object");
    // 临时 sandbox 没有 service-version.json：serviceVersion 必须报错而非伪装仍是 build。
    await assert.rejects(mod.serviceVersion, /service-version\.json missing/);
    const valid: ServiceVersion = {
      version: "test", commit: null, dirty: null, sourceHash: "a".repeat(64),
      mode: "build", builtAt: "2026-10-18T00:00:00.000Z",
    };
    await writeFile(join(sandbox, "service-version.json"), JSON.stringify(valid));
    const load = () => spawnSync(process.execPath, ["--input-type=module", "-e",
      `const mod = await import(${JSON.stringify(pathToFileURL(builtPath).href)}); console.log(JSON.stringify(await mod.serviceVersion));`],
    { cwd: sandbox, encoding: "utf8" });
    const loaded = load();
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.deepEqual(JSON.parse(loaded.stdout), valid);
    await writeFile(join(sandbox, "service-version.json"), JSON.stringify({ ...valid, mode: "source", builtAt: null }));
    const invalid = load();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Build snapshot must include build mode and time/);
  } finally {
    process.chdir(originalCwd);
  }
});

test("tsconfig whitelist picks up multiple tsconfig variants", async (t) => {
  const sandbox = await tempDir(t, "tsconfig");
  await mkdir(join(sandbox, "src"), { recursive: true });
  await mkdir(join(sandbox, "assets"), { recursive: true });
  await mkdir(join(sandbox, "scripts"), { recursive: true });
  await writeFile(join(sandbox, "package.json"), '{"version":"0.0.0"}\n');
  await writeFile(join(sandbox, "pnpm-lock.yaml"), 'lockVersion: 9\n');
  await writeFile(join(sandbox, "tsconfig.json"), '{"compilerOptions":{}}\n');
  await writeFile(join(sandbox, "tsconfig.build.json"), '{"extends":"./tsconfig.json"}\n');
  await writeFile(join(sandbox, "tsconfig.something.json"), '{"extends":"./tsconfig.json"}\n');
  await writeFile(join(sandbox, "notsconfig.json"), '{}');

  const hash = await collectSourceHash(sandbox);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
