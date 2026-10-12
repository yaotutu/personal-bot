import type { MemoryService } from "../../../features/memory/memory-service.js";
import type { JobService } from "../../../features/jobs/job-service.js";
import { currentTimeTool } from "./current-time.js";
import { memoryTool } from "./memory.js";
import { scheduleTool } from "./schedule.js";
import { createFileTools } from "./files.js";

/**
 * 显式装配现有工具；session factory 从这份定义导出允许列表。
 * 新工具只需自己的 adapter 和此处一条注册，不需要修改会话协调算法。
 */
export const createTools = (root: string, memory: MemoryService, jobs: JobService) => [
  currentTimeTool,
  memoryTool(memory),
  scheduleTool(jobs),
  ...createFileTools(root),
];
