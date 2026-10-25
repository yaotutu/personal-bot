import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

const projectRoot = resolve(import.meta.dirname, "../..");

/**
 * 通过 import.meta.url 定位的内置技能解析器有两个不变量：
 *  - 不读 process.cwd()，因此调用方切到任意 cwd 都应得到相同的解析结果。
 *  - 同时存在源码侧与构建侧 assets/ 时，只能依据自身位置判断，
 *    不会因为 dev 路径先存在而错误地选中源码侧。
 *
 * 单元测试无法在同一进程里同时跑两条分支（同一个 import.meta.url 只对应
 * 一个位置），所以切到子进程：dev 分支在无关 cwd 里 import 源码测；prod
 * 分支用单文件 tsc 把同一份源码编译到一个模拟 dist 的临时树里，再在无关
 * cwd 里 import 编译产物并枚举 8 项内置技能。
 */

const runNode = (args: string[], cwd: string): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync("node", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const runTsx = (args: string[], cwd: string): { status: number; stdout: string; stderr: string } => {
  // 直接走 tsx 包的 cli.mjs，避免 .bin 下的 shell 包装
  const result = spawnSync("node", [resolve(projectRoot, "node_modules/tsx/dist/cli.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

test("src 分支：getBuiltinSkillsDir 不依赖 process.cwd()，恒指项目根 assets/skills", () => {
  const foreignCwd = mkdtempSync(resolve(tmpdir(), "builtin-skills-src-"));
  try {
    // 在无关 cwd 里 chdir 再动态加载源码模块并打印解析结果。
    // 用临时 .mjs 文件而非 --eval，避免 tsx 在 CJS 输出下抛 top-level await。
    const bootstrap = `
      import { chdir } from "node:process";
      chdir(${JSON.stringify(foreignCwd)});
      const mod = await import(${JSON.stringify(resolve(projectRoot, "src/adapters/storage/builtin-skills.ts"))});
      process.stdout.write(mod.getBuiltinSkillsDir());
    `;
    const tmpScript = resolve(foreignCwd, "_bootstrap.mjs");
    writeFileSync(tmpScript, bootstrap);
    const { status, stdout, stderr } = runNode([tmpScript], foreignCwd);
    assert.equal(status, 0, `node 退出码=${status}, stderr=${stderr}`);
    assert.equal(stdout, resolve(projectRoot, "assets/skills"));
  } finally {
    rmSync(foreignCwd, { recursive: true, force: true });
  }
});

test("copy-assets 脚本连跑两次不会产生 assets/assets 嵌套", () => {
  const tempDest = mkdtempSync(resolve(tmpdir(), "builtin-skills-copy-"));
  try {
    // 第一次：dest 不存在，应当完整复制 assets/ 内容直接展开到 dest
    let res = runNode([resolve(projectRoot, "scripts/copy-assets.mjs"), tempDest], projectRoot);
    assert.equal(res.status, 0, `首次复制失败 stderr=${res.stderr}`);
    const firstListing = readdirSync(tempDest);
    assert.ok(firstListing.includes("skills"), `首次复制后 dest 应直接含 skills/, 实际: ${firstListing.join(",")}`);
    assert.ok(!firstListing.includes("assets"), `首次复制后 dest 不应再含 assets/ 目录, 实际: ${firstListing.join(",")}`);

    // 第二次：dest 已存在，必须是覆盖语义而不是把 assets 再嵌一层
    res = runNode([resolve(projectRoot, "scripts/copy-assets.mjs"), tempDest], projectRoot);
    assert.equal(res.status, 0, `二次复制失败 stderr=${res.stderr}`);
    const secondListing = readdirSync(tempDest);
    assert.ok(!secondListing.includes("assets"), `二次复制后仍不应含 assets/ 目录, 实际: ${secondListing.join(",")}`);
    assert.ok(readdirSync(resolve(tempDest, "skills")).length >= 1, "二次复制仍应保留 skills/ 子目录");
  } finally {
    rmSync(tempDest, { recursive: true, force: true });
  }
});

test("隔离 dist 拷贝后，从任意 cwd 通过编译产物解析并枚举出全部 8 项内置技能", () => {
  // 在临时项目布局里：<stage>/fake-project/dist/{adapters/storage,assets/skills}/…
  // 编译单一文件 builtin-skills.ts 到 fake-project/dist/adapters/storage/；
  // 再用 copy-assets.mjs 把源码 assets/ 复制到 fake-project/dist/assets/。
  // 然后切到无关 cwd 加载编译产物，断言它返回 fake-project/dist/assets/skills
  // 且能从该目录枚举出与真实内置技能完全一致的 8 项。
  const stageRoot = mkdtempSync(resolve(tmpdir(), "builtin-skills-prod-"));
  const distRoot = resolve(stageRoot, "fake-project", "dist");
  const foreignCwd = mkdtempSync(resolve(tmpdir(), "builtin-skills-prod-run-"));

  try {
    mkdirSync(resolve(distRoot, "adapters", "storage"), { recursive: true });

    // 单文件 tsc：直接调用包内 bin/tsc.js，避免 .bin 下的 shell 包装
    // --outDir 必须包含 "dist" 段，让编译产物的 import.meta.url 路径里出现 dist/
    const compile = runNode(
      [
        resolve(projectRoot, "node_modules/typescript/bin/tsc"),
        resolve(projectRoot, "src/adapters/storage/builtin-skills.ts"),
        "--outDir", resolve(stageRoot, "fake-project", "dist"),
        "--rootDir", resolve(projectRoot, "src"),
        "--module", "nodenext",
        "--moduleResolution", "nodenext",
        "--target", "es2023",
        "--strict",
        "--skipLibCheck",
        "--esModuleInterop",
        "--types", "node",
      ],
      projectRoot,
    );
    assert.equal(compile.status, 0, `tsc 单文件编译失败 stderr=${compile.stderr}`);

    const compiledJs = resolve(distRoot, "adapters", "storage", "builtin-skills.js");
    assert.ok(
      readdirSync(dirname(compiledJs)).includes("builtin-skills.js"),
      "未生成预期的编译产物",
    );

    // 把源码侧 assets/ 同步到隔离 dist 下：脚本接受可选 dest 参数
    const copyRes = runNode(
      [resolve(projectRoot, "scripts/copy-assets.mjs"), resolve(distRoot, "assets")],
      projectRoot,
    );
    assert.equal(copyRes.status, 0, `copy-assets 失败 stderr=${copyRes.stderr}`);

    // 真实内置技能列表用来与隔离 dist 解析结果对比，确保列表真来自该目录
    const realBuiltinSkills = readdirSync(resolve(projectRoot, "assets/skills")).sort();

    // 在无关 cwd 下加载隔离 dist 的编译产物并打印解析结果
    const bootstrap = `
      import { chdir } from "node:process";
      chdir(${JSON.stringify(foreignCwd)});
      const mod = await import(${JSON.stringify(compiledJs)});
      const dir = mod.getBuiltinSkillsDir();
      const fs = await import("node:fs/promises");
      const entries = (await fs.readdir(dir)).sort();
      process.stdout.write(JSON.stringify({ dir, entries }));
    `;
    const load = runNode(["--input-type=module", "-e", bootstrap], foreignCwd);
    assert.equal(load.status, 0, `加载编译产物失败 stderr=${load.stderr}`);
    const { dir, entries } = JSON.parse(load.stdout) as { dir: string; entries: string[] };

    // 用 realpath 对比，规避 macOS 上 /var/folders → /private/var/folders 软链的字面差异
    assert.equal(realpathSync.native(dir), realpathSync.native(resolve(distRoot, "assets", "skills")));
    assert.equal(entries.length, 8, `预期 8 项内置技能, 实际 ${entries.length}: ${entries.join(",")}`);
    assert.deepEqual(entries, realBuiltinSkills);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(foreignCwd, { recursive: true, force: true });
  }
});
