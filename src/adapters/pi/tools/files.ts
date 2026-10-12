import {
  createReadToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { guardTool } from "./path-guard.js";

/**
 * 仅注册四个 pi 内置只读工具，所有入口先经过同一个路径 guard。
 * 顺序保持原样；不在此注册 bash/edit/write 或扫描外部工具。
 */
export const createFileTools = (root: string) => [
  guardTool(createReadToolDefinition(root), root),
  guardTool(createGrepToolDefinition(root), root),
  guardTool(createFindToolDefinition(root), root),
  guardTool(createLsToolDefinition(root), root),
];
