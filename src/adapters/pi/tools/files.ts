import { access, lstat, open, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createReadToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import { guardTool, type FileGuardOptions } from "./path-guard.js";
import { safeWorkspacePath, UnsafeFilePathError } from "./workspace-path.js";

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/**
 * 工具定义/截断/检索继续复用 pi；operations 检查 pi 最终解析后的路径，防止 macOS
 * 文件名回退、ctx.cwd 或 SDK 的路径展开绕过入口 guard。grep/fd 的递归默认不跟链接，
 * 入口链接在 guard 拒绝；ls 的逐项 stat 则用 lstat 检查，跳过链接，不解引用到其他会话。
 */
export const createFileTools = (root: string, sharedDir?: string, options: FileGuardOptions = {}) => {
  const check = async (path: string, allowSkill = false): Promise<string> => {
    if (allowSkill && options.readOnlyFiles?.includes(path)) {
      return safeWorkspacePath(dirname(path), path, { boundaryDir: dirname(dirname(path)) });
    }
    for (const base of [root, ...(sharedDir ? [sharedDir] : [])]) {
      const lexicalRoot = resolve(base);
      const physicalRoot = await safeWorkspacePath(base, base, { boundaryDir: options.boundaryDir });
      const lexicalPath = inside(lexicalRoot, path) ? path : inside(physicalRoot, path)
        ? join(lexicalRoot, relative(physicalRoot, path)) : undefined;
      if (lexicalPath) return safeWorkspacePath(base, lexicalPath, { boundaryDir: options.boundaryDir });
    }
    throw new UnsafeFilePathError("Outside workspace");
  };
  const read = createReadToolDefinition(root, { operations: {
    access: async (path) => { await access(await check(path, true), constants.R_OK); },
    readFile: async (path) => {
      const file = await open(await check(path, true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new UnsafeFilePathError("Not a regular file");
        return await file.readFile();
      } finally { await file.close(); }
    },
    detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await check(path, true)),
  } });
  const ls = createLsToolDefinition(root, { operations: {
    exists: async (path) => { await check(path); return true; },
    stat: async (path) => lstat(await check(path)),
    readdir: async (path) => readdir(await check(path)),
  } });
  const grep = createGrepToolDefinition(root, { operations: {
    isDirectory: async (path) => (await lstat(await check(path))).isDirectory(),
    readFile: async (path) => readFile(await check(path), "utf8"),
  } });
  return [read, grep, createFindToolDefinition(root), ls].map((tool) => guardTool(tool, root, sharedDir, options));
};
