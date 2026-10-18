import type { MemoryService } from "../../../features/memory/memory-service.js";
import type { JobService } from "../../../features/jobs/job-service.js";
import type { TaskService } from "../../../features/tasks/task-service.js";
import type { TaskWorker } from "../../../features/tasks/task-worker.js";
import type { GoalService } from "../../../features/goals/goal-service.js";
import type { ActionService } from "../../../features/actions/action-service.js";
import type { MonitorService } from "../../../features/monitors/monitor-service.js";
import type { WebService } from "../../../features/web/types.js";
import type { WeatherService } from "../../../features/weather/types.js";
import type { DataLayout } from "../../storage/data-layout.js";
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
import { instructionsTool } from "./instructions.js";

type ToolDependencies = {
  root: string;
  threadId?: string;
  runId?: string;
  memory: MemoryService;
  jobs: JobService;
  tasks?: TaskService;
  worker?: Pick<TaskWorker, "kick" | "control">;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
  web?: WebService;
  weather?: WeatherService;
  layout?: DataLayout;
  sharedDir?: string;
  readOnlyFiles?: readonly string[];
};

/**
 * 显式注册组是唯一的能力声明：名称校验与运行时装配均从这里派生。
 * 可选能力未启用时仍允许预先配置展示策略；不为查工具名创建服务/假依赖。
 * names 同时作为装配断言，防止工具内部改名后配置悄悄失效。
 */
// 内部后台会话只执行已委派的工作，不允许继续扩张任务链或建立周期性副作用。
// threadId 由服务端 worker 生成；在装配时裁剪后，模型声明与执行 allowlist 自动一致。
const isBackgroundTask = (deps: ToolDependencies) => deps.threadId?.startsWith("task-") === true;

// 技能到内置工具的映射表：用于根据技能开关裁剪工具
export const skillToToolsMap: Record<string, string[]> = {
  cron: ["schedule"],
  monitor: ["monitor"],
  task: ["delegate_task"],
  goal: ["goal"],
  memory: ["memory"],
  web: ["search_web", "web_fetch"],
  write: ["write", "edit"],
};

const registrations = [
  { names: ["currentTime"], create: (_deps: ToolDependencies) => [currentTimeTool] },
  { names: ["instructions"], create: (deps: ToolDependencies) => isBackgroundTask(deps) || !deps.layout ? [] : [instructionsTool(deps.layout, deps.threadId)] },
  { names: ["memory"], create: (deps: ToolDependencies) => [memoryTool(deps.memory)] },
  { names: ["schedule"], create: (deps: ToolDependencies) => isBackgroundTask(deps) ? [] : [scheduleTool(deps.jobs, deps.threadId)] },
  { names: ["delegate_task"], create: (deps: ToolDependencies) => !isBackgroundTask(deps) && deps.tasks && deps.worker ? [delegateTaskTool(deps.tasks, deps.worker, deps.threadId, deps.layout)] : [] },
  { names: ["goal"], create: (deps: ToolDependencies) => deps.goals ? [goalTool(deps.goals)] : [] },
  { names: ["monitor"], create: (deps: ToolDependencies) => !isBackgroundTask(deps) && deps.monitors ? [monitorTool(deps.monitors, deps.threadId)] : [] },
  { names: ["read", "grep", "find", "ls"], create: (deps: ToolDependencies) => createFileTools(deps.root, deps.sharedDir, { boundaryDir: deps.layout?.workspaceDir, readOnlyFiles: deps.readOnlyFiles }) },
  // 写文件默认开启，经人工审批闸门；config tools.writable=false 可整体关闭。
  {
    names: ["write", "edit"],
    create: (deps: ToolDependencies) =>
      deps.actions ? createWritableFileTools(deps.root, deps.actions, deps.actionTimeoutMs ?? 300_000, { threadId: deps.threadId, runId: deps.runId }, deps.sharedDir, deps.layout?.workspaceDir) : [],
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
