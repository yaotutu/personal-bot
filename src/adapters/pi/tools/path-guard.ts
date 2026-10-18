import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWorkspacePath, safeWorkspacePath, UnsafeFilePathError } from "./workspace-path.js";

export type FileGuardOptions = {
  boundaryDir?: string;
  /** pi 技能提示给出绝对 SKILL.md 路径；只允许已启用技能的精确文件，不开放目录。 */
  readOnlyFiles?: readonly string[];
};

export const guardPath = (root: string, raw: unknown, sharedDir?: string): string | null =>
  resolveWorkspacePath(root, raw, sharedDir)?.path ?? null;

/** 路径别名只解析一次，底层始终收到已校验的绝对路径，不依赖 SDK 的 cwd 或 ~/@ 展开。 */
export const guardTool = (
  definition: ToolDefinition<any, any>,
  root: string,
  sharedDir?: string,
  options: FileGuardOptions = {},
): ToolDefinition<any, any> => ({
  ...definition,
  description: definition.description + " Paths are relative to this conversation's private workspace; use shared/... for shared files. Absolute paths, .. and symlinks are refused." +
    (definition.name === "read" && options.readOnlyFiles?.length ? " The exact SKILL.md paths of enabled skills are also readable." : ""),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const rawPath = (params as { path?: unknown }).path;
    const skillFile = definition.name === "read" && typeof rawPath === "string" &&
      options.readOnlyFiles?.includes(rawPath) ? resolve(rawPath) : undefined;
    const selected = resolveWorkspacePath(root, rawPath, sharedDir);
    const denied = () => ({
      content: [{ type: "text" as const, text: "Access denied: path is outside the documents directory or contains a symlink." }],
      details: { denied: true }, isError: true,
    });
    if (!selected && !skillFile) return denied();
    try {
      // 缺失文件交给 pi 保留原有 not-found 行为；实际读取 operations 再核验 SDK 最终解析的路径。
      if (selected) await safeWorkspacePath(selected.base, selected.path, { allowMissing: true, boundaryDir: options.boundaryDir });
      return await definition.execute(toolCallId, { ...(params as Record<string, unknown>), path: skillFile ?? selected!.path }, signal, onUpdate, ctx);
    } catch (error) {
      if (error instanceof UnsafeFilePathError) return denied();
      throw error;
    }
  },
});
