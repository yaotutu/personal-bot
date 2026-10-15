import type { MemoryService } from "../../../features/memory/memory-service.js";
import type { JobService } from "../../../features/jobs/job-service.js";
import type { TaskService } from "../../../features/tasks/task-service.js";
import type { TaskWorker } from "../../../features/tasks/task-worker.js";
import type { GoalService } from "../../../features/goals/goal-service.js";
import type { ActionService } from "../../../features/actions/action-service.js";
import type { MonitorService } from "../../../features/monitors/monitor-service.js";
import type { WebService } from "../../../features/web/types.js";
import type { WeatherService } from "../../../features/weather/types.js";
import { currentTimeTool } from "./current-time.js";
import { memoryTool } from "./memory.js";
import { scheduleTool } from "./schedule.js";
import { delegateTaskTool } from "./delegate-task.js";
import { goalTool } from "./goal.js";
import { monitorTool } from "./monitor.js";
import { createFileTools } from "./files.js";
import { createWritableFileTools } from "./files-writable.js";
import { createWebTools } from "./web.js";
import { weatherTool } from "./weather.js";

type ToolDependencies = {
  root: string;
  memory: MemoryService;
  jobs: JobService;
  tasks?: TaskService;
  worker?: Pick<TaskWorker, "kick">;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
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
  { names: ["delegate_task"], create: (deps: ToolDependencies) => deps.tasks && deps.worker ? [delegateTaskTool(deps.tasks, deps.worker)] : [] },
  { names: ["goal"], create: (deps: ToolDependencies) => deps.goals ? [goalTool(deps.goals)] : [] },
  { names: ["monitor"], create: (deps: ToolDependencies) => deps.monitors ? [monitorTool(deps.monitors)] : [] },
  { names: ["read", "grep", "find", "ls"], create: (deps: ToolDependencies) => createFileTools(deps.root) },
  // 写文件默认开启，经人工审批闸门；config tools.writable=false 可整体关闭。
  {
    names: ["write", "edit"],
    create: (deps: ToolDependencies) =>
      deps.actions ? createWritableFileTools(deps.root, deps.actions, deps.actionTimeoutMs ?? 300_000) : [],
  },
  { names: ["search_web", "web_fetch"], create: (deps: ToolDependencies) => deps.web ? createWebTools(deps.web) : [] },
  { names: ["get_weather"], create: (deps: ToolDependencies) => deps.weather ? [weatherTool(deps.weather)] : [] },
];

export const registeredToolNames: readonly string[] = registrations.flatMap((group) => group.names);

/** session factory 的执行 allowlist 仍只从实际创建的工具生成，不使用静态名称列表。 */
export const createTools = (deps: ToolDependencies) =>
  registrations.flatMap((group) => {
    const tools = group.create(deps);
    if (tools.length && JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(group.names))
      throw new Error("Tool registration names do not match definitions");
    return tools;
  });
