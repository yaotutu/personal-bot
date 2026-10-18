/**
 * 服务版本元数据模块。
 *
 * 职责边界：
 * - 启动时一次性快照：package version / git commit+dirty / 源码 sha256；
 * - 项目根 = bootstrap 上两级（源码与构建产物同规则），绝不依赖 process.cwd()；
 * - 源码模式由本模块直接收集所有字段（含真实 git）；构建脚本同样调用 collectServiceVersion，
 *   不存在空骨架二次填充；
 * - runtime build 仅 load dist/service-version.json，缺失直接抛错而非伪装仍是 build；
 * - 白名单覆盖 src/ assets/ scripts/ package.json pnpm-lock.yaml tsconfig*.json；
 *   根文件 / 目录 / tsconfig 走 lstat 检测符号链接，链接则拒绝；
 * - 字段集合固定，不允许额外字段写入 API，避免私有路径泄漏。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceVersion = {
  version: string;
  commit: string | null;
  dirty: boolean | null;
  sourceHash: string;
  mode: "source" | "build";
  builtAt: string | null;
};

// 白名单：相对项目根；新增资源只能增加 entry，不可扩大扫描范围（避免把 .pi-muse 等实例数据拉入 hash）。
const SOURCE_ENTRIES = ["src", "assets", "scripts", "package.json", "pnpm-lock.yaml"] as const;
const TSCONFIG_PREFIX = "tsconfig";

// 项目根 = bootstrap 上两级；源码和构建产物都按此规则。
const resolveProjectRoot = (moduleUrl: string): string =>
  resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");

// 启动时一次性读 git；失败 / 缺失返回 null，绝不抛错，运行期不再触发 git。
const readGitSnapshot = (projectRoot: string): { commit: string | null; dirty: boolean | null } => {
  try {
    const commit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { commit: null, dirty: null };
    let dirty: boolean | null = null;
    try {
      dirty = execFileSync("git", ["-C", projectRoot, "status", "--porcelain"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).length > 0;
    } catch {
      dirty = null;
    }
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
};

const readPackageVersion = async (projectRoot: string): Promise<string> => {
  const parsed = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed?.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json version must be non-empty string");
  }
  return parsed.version;
};

// sha256：path + length + content 拼接，路径参与排序，避免同名异路径或同长异内容碰撞。
const hashSourceFiles = (files: ReadonlyArray<{ relPath: string; bytes: Buffer }>): string => {
  const hasher = createHash("sha256");
  for (const file of files) {
    hasher.update(file.relPath);
    hasher.update("\0");
    hasher.update(String(file.bytes.byteLength));
    hasher.update("\0");
    hasher.update(file.bytes);
    hasher.update("\0");
  }
  return hasher.digest("hex");
};

// 拒绝跟随白名单内符号链接：避免攻击者用 .pi-muse/config.json 顶替 src 内容拉入 hash。
const walkDirectory = async (
  projectRoot: string,
  absolute: string,
  collected: Array<{ relPath: string; bytes: Buffer }>,
): Promise<void> => {
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in whitelist: ${absolute}/${entry.name}`);
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) await walkDirectory(projectRoot, child, collected);
    else if (entry.isFile()) {
      collected.push({ relPath: relative(projectRoot, child).split(sep).join("/"), bytes: await readFile(child) });
    }
  }
};

const collectSourceFiles = async (
  projectRoot: string,
): Promise<Array<{ relPath: string; bytes: Buffer }>> => {
  const collected: Array<{ relPath: string; bytes: Buffer }> = [];
  for (const entry of SOURCE_ENTRIES) {
    const absolute = resolve(projectRoot, entry);
    const stats = await lstat(absolute); // 不跟随符号链接：链接直接拒绝。
    if (stats.isSymbolicLink()) throw new Error(`Refusing symlink in whitelist: ${absolute}`);
    if (stats.isFile()) collected.push({ relPath: entry, bytes: await readFile(absolute) });
    else if (stats.isDirectory()) await walkDirectory(projectRoot, absolute, collected);
    else throw new Error(`Source hash entry ${entry} is neither file nor directory.`);
  }
  for (const name of await readdir(projectRoot)) {
    if (!name.startsWith(`${TSCONFIG_PREFIX}.`) || !name.endsWith(".json")) continue;
    const absolute = resolve(projectRoot, name);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Refusing symlink in whitelist: ${absolute}`);
    if (stats.isFile()) collected.push({ relPath: name, bytes: await readFile(absolute) });
  }
  collected.sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  return collected;
};

export const collectSourceHash = async (projectRoot: string): Promise<string> => {
  const files = await collectSourceFiles(projectRoot);
  if (files.length === 0) throw new Error("Source hash is empty");
  return hashSourceFiles(files);
};

export const collectGitSnapshot = (projectRoot: string): { commit: string | null; dirty: boolean | null } =>
  readGitSnapshot(projectRoot);

// 完整收集源码快照（含真实 git + hash）；构建脚本也调用，仅在 mode='build' 时填入 builtAt。
export const collectServiceVersion = async (
  moduleUrl: string,
  mode: "source" | "build",
): Promise<ServiceVersion> => {
  const projectRoot = resolveProjectRoot(moduleUrl);
  const version = await readPackageVersion(projectRoot);
  const sourceHash = await collectSourceHash(projectRoot);
  const git = readGitSnapshot(projectRoot);
  return {
    version,
    commit: git.commit,
    dirty: git.dirty,
    sourceHash,
    mode,
    builtAt: mode === "build" ? new Date().toISOString() : null,
  };
};

// 严格校验：仅允许固定键，类型 / 长度错误或额外字段都拒绝；防止私有路径泄漏到 API。
export const assertBuildSnapshot = (input: unknown): ServiceVersion => {
  if (!input || typeof input !== "object") throw new Error("snapshot must be object");
  const value = input as Record<string, unknown>;
  const allowed = ["version", "commit", "dirty", "sourceHash", "mode", "builtAt"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown field: ${key}`);
  if (typeof value.version !== "string" || value.version.length === 0) throw new Error("version invalid");
  if (value.commit !== null && (typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit))) throw new Error("commit invalid");
  if (value.dirty !== null && typeof value.dirty !== "boolean") throw new Error("dirty invalid");
  if (typeof value.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceHash)) throw new Error("sourceHash invalid");
  if (value.mode !== "source" && value.mode !== "build") throw new Error("mode invalid");
  if (value.builtAt !== null && (typeof value.builtAt !== "string" || Number.isNaN(Date.parse(value.builtAt)))) throw new Error("builtAt invalid");
  return value as unknown as ServiceVersion;
};

// runtime build 仅读 dist/service-version.json；候选 fallback 会掩盖坏文档或过时构建。
const loadBuildSnapshot = async (moduleUrl: string): Promise<ServiceVersion> => {
  const target = resolve(dirname(fileURLToPath(moduleUrl)), "..", "service-version.json");
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    throw new Error(`dist/service-version.json missing at ${target}; run \`pnpm build\` first: ${(error as Error).message}`);
  }
  const snapshot = assertBuildSnapshot(JSON.parse(raw));
  if (snapshot.mode !== "build" || snapshot.builtAt === null) throw new Error("Build snapshot must include build mode and time");
  return snapshot;
};

// .ts 视为源码（tsx / 测试 / 构建脚本）；.js 视为构建产物（dist/bootstrap/）。
const probeMode = (moduleUrl: string): "source" | "build" =>
  fileURLToPath(moduleUrl).endsWith(".ts") ? "source" : "build";

const snapshotPromise: Promise<ServiceVersion> = (async () => {
  const moduleUrl = import.meta.url;
  return probeMode(moduleUrl) === "build" ? loadBuildSnapshot(moduleUrl) : collectServiceVersion(moduleUrl, "source");
})();

/** 对外 Promise；运行期 await 一次即可，模块顶层已快照所有字段（commit/dirty/hash/version）。 */
export const serviceVersion: Promise<ServiceVersion> = snapshotPromise;