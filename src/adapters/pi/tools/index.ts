import type { MemoryService } from "../../../features/memory/memory-service.js";
import type { JobService } from "../../../features/jobs/job-service.js";
import type { WebService } from "../../../features/web/types.js";
import type { WeatherService } from "../../../features/weather/types.js";
import { currentTimeTool } from "./current-time.js";
import { memoryTool } from "./memory.js";
import { scheduleTool } from "./schedule.js";
import { createFileTools } from "./files.js";
import { createWebTools } from "./web.js";
import { weatherTool } from "./weather.js";

type ToolDependencies = {
  root: string;
  memory: MemoryService;
  jobs: JobService;
  web?: WebService;
  weather?: WeatherService;
};

/**
 * 显式注册组是唯一的能力声明：名称校验与运行时装配均从这里派生。
 * 可选能力未启用时仍允许预先配置展示策略；不为查工具名创建服务/假依赖。
 * names 同时作为装配断言，防止工具内部改名后配置悄悄失效。
 */
const registrations = [
  { names: ["currentTime"], create: (_deps: ToolDependencies) => [currentTimeTool] },
  { names: ["memory"], create: (deps: ToolDependencies) => [memoryTool(deps.memory)] },
  { names: ["schedule"], create: (deps: ToolDependencies) => [scheduleTool(deps.jobs)] },
  { names: ["read", "grep", "find", "ls"], create: (deps: ToolDependencies) => createFileTools(deps.root) },
  { names: ["search_web", "web_fetch"], create: (deps: ToolDependencies) => deps.web ? createWebTools(deps.web) : [] },
  { names: ["get_weather"], create: (deps: ToolDependencies) => deps.weather ? [weatherTool(deps.weather)] : [] },
];

export const registeredToolNames: readonly string[] = registrations.flatMap((group) => group.names);

/** session factory 的执行 allowlist 仍只从实际创建的工具生成，不使用静态名称列表。 */
export const createTools = (
  root: string,
  memory: MemoryService,
  jobs: JobService,
  web?: WebService,
  weather?: WeatherService,
) => registrations.flatMap((group) => {
  const tools = group.create({ root, memory, jobs, web, weather });
  if (tools.length && JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(group.names))
    throw new Error("Tool registration names do not match definitions");
  return tools;
});
