import { resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// 复用 pi 内置只读文件工具（read/grep/find/ls），但在执行前强制路径边界：
// 解析后的绝对路径必须落在资料目录内，否则拒绝。pi 原生的 cwd 只是相对路径
// 基准，绝对路径与 ../ 都能逃逸，因此这层防护不能省。customTools 同名覆盖
// 内置注册，allowlist 保证 bash/edit/write 永不暴露。
export const guardPath = (root: string, raw: unknown): string | null => {
  const input = typeof raw === "string" && raw.trim() ? raw : ".";
  const resolved = resolve(root, input);
  return resolved === root || resolved.startsWith(root + sep) ? resolved : null;
};
export const guardTool = (
  definition: ToolDefinition<any, any>,
  root: string,
): ToolDefinition<any, any> => ({
  ...definition,
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const path = (params as { path?: unknown }).path;
    if (!guardPath(root, path))
      return {
        content: [
          {
            type: "text",
            text: "Access denied: path is outside the documents directory.",
          },
        ],
        details: { denied: true },
        isError: true,
      };
    return definition.execute(toolCallId, params, signal, onUpdate, ctx);
  },
});
