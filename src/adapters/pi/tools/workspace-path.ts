import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class UnsafeFilePathError extends Error {}

const inside = (root: string, target: string) => target === root || target.startsWith(root + sep);

/** shared/ 是逻辑入口，先选根再解析；绝对路径、父目录跳转和反斜杠不交给 SDK 二次解释。 */
export const resolveWorkspacePath = (root: string, raw: unknown, sharedDir?: string) => {
  const input = typeof raw === "string" && raw.trim() ? raw.trim() : ".";
  if (isAbsolute(input) || input.includes("\\") || input.split("/").includes("..")) return null;
  const parts = input.split("/").filter((part) => part && part !== ".");
  const shared = sharedDir !== undefined && parts[0] === "shared";
  const base = resolve(shared ? sharedDir! : root);
  const path = resolve(base, ...(shared ? parts.slice(1) : parts));
  return inside(base, path) ? { base, path } : null;
};

/**
 * 只信任配置给出的边界锚点；从锚点到实际目标逐段 lstat，拒绝根、父目录、目标链接。
 * 锚点父目录用 realpath 规范化，允许 macOS /tmp → /private/tmp 等部署路径别名。
 * allowMissing 仅用于审批写新文件；现存祖先仍须检查。非操作系统沙箱，不承诺抵御恶意外部进程竞争。
 */
export const safeWorkspacePath = async (
  root: string,
  target: string,
  options: { allowMissing?: boolean; boundaryDir?: string } = {},
): Promise<string> => {
  const base = resolve(root);
  const lexical = resolve(target);
  const boundary = resolve(options.boundaryDir ?? base);
  if (!inside(boundary, base) || !inside(base, lexical)) throw new UnsafeFilePathError("Outside workspace");
  const boundaryEntry = await lstat(boundary);
  if (boundaryEntry.isSymbolicLink() || !boundaryEntry.isDirectory()) throw new UnsafeFilePathError("Unsafe workspace root");
  const physicalBoundary = await realpath(boundary);
  const components = relative(boundary, lexical).split(sep).filter(Boolean);
  let current = boundary;
  for (const component of components) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new UnsafeFilePathError("Symlink access denied");
    } catch (error) {
      if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const expected = join(physicalBoundary, relative(boundary, lexical));
  try {
    if (await realpath(lexical) !== expected) throw new UnsafeFilePathError("Workspace path changed");
  } catch (error) {
    if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return expected;
};
