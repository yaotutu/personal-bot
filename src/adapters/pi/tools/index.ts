import type { MemoryService } from "../../../features/memory/memory-service.js";
import type { JobService } from "../../../features/jobs/job-service.js";
import type { GoalService } from "../../../features/goals/goal-service.js";
import type { ActionService } from "../../../features/actions/action-service.js";
import type { MonitorService } from "../../../features/monitors/monitor-service.js";
import type { WebService } from "../../../features/web/types.js";
import type { WeatherService } from "../../../features/weather/types.js";
import type { DataLayout } from "../../storage/data-layout.js";
import { currentTimeTool } from "./current-time.js";
import { memoryTool, memorySearchTool } from "./memory.js";
import { scheduleTool } from "./schedule.js";
import { goalTool } from "./goal.js";
import { monitorTool } from "./monitor.js";
import { createFileTools } from "./files.js";
import { createWritableFileTools, type ActivityToolObservation } from "./files-writable.js";
import { createWebTools } from "./web.js";
import { weatherTool } from "./weather.js";
import { instructionsTool } from "./instructions.js";
import { createActivityTool, ACTIVITY_TOOL_NAME } from "./activity.js";
import type { ActivityRun } from "../../../features/activities/types.js";
import { SUBAGENT_TOOL_NAME } from "../subagent/extension.js";

type ToolDependencies = {
  root: string;
  threadId?: string;
  runId?: string;
  memory: MemoryService;
  jobs: JobService;
  isSubagent?: boolean;
  subagentId?: string;
  workspaceThreadId?: string;
  currentActivityId?: () => string | null;
  activity?: ActivityRun;
  activityObservation?: ActivityToolObservation;
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
// 子会话只执行主 Agent 委派的工作，不再创建周期任务或继续扩张委派链。
const isSubagent = (deps: ToolDependencies) => deps.isSubagent === true;

// 技能到内置工具的映射表：用于根据技能开关裁剪工具
export const skillToToolsMap: Record<string, string[]> = {
  cron: ["schedule"],
  monitor: ["monitor"],
  task: ["subagent"],
  goal: ["goal"],
  memory: ["memory", "memory_search"],
  web: ["search_web", "web_fetch"],
  write: ["write", "edit"],
};

const registrations = [
  { names: ["currentTime"], create: (_deps: ToolDependencies) => [currentTimeTool] },
  { names: [ACTIVITY_TOOL_NAME], create: (deps: ToolDependencies) => deps.activity && !isSubagent(deps) ? [createActivityTool(deps.activity)] : [] },
  { names: ["instructions"], create: (deps: ToolDependencies) => isSubagent(deps) || !deps.layout ? [] : [instructionsTool(deps.layout, deps.threadId)] },
  { names: ["memory", "memory_search"], create: (deps: ToolDependencies) => [memoryTool(deps.memory), memorySearchTool(deps.memory)] },
  { names: ["schedule"], create: (deps: ToolDependencies) => isSubagent(deps) ? [] : [scheduleTool(deps.jobs, deps.threadId)] },
  { names: ["goal"], create: (deps: ToolDependencies) => deps.goals ? [goalTool(deps.goals)] : [] },
  { names: ["monitor"], create: (deps: ToolDependencies) => !isSubagent(deps) && deps.monitors ? [monitorTool(deps.monitors, deps.threadId)] : [] },
  { names: ["read", "grep", "find", "ls"], create: (deps: ToolDependencies) => createFileTools(deps.root, deps.sharedDir, { boundaryDir: deps.layout?.workspaceDir, readOnlyFiles: deps.readOnlyFiles }) },
  // 写文件默认开启，经人工审批闸门；config tools.writable=false 可整体关闭。
  {
    names: ["write", "edit"],
    create: (deps: ToolDependencies) =>
      deps.actions ? createWritableFileTools(deps.root, deps.actions, deps.actionTimeoutMs ?? 300_000, { threadId: deps.threadId, runId: deps.runId, subagentId: deps.subagentId, workspaceThreadId: deps.workspaceThreadId ?? deps.threadId, activityId: deps.currentActivityId }, deps.sharedDir, deps.layout?.workspaceDir, deps.activityObservation) : [],
  },
  { names: ["search_web", "web_fetch"], create: (deps: ToolDependencies) => deps.web ? createWebTools(deps.web) : [] },
  { names: ["get_weather"], create: (deps: ToolDependencies) => deps.weather ? [weatherTool(deps.weather)] : [] },
];

export const registeredToolNames: readonly string[] = [...registrations.flatMap((group) => group.names), SUBAGENT_TOOL_NAME];

/** session factory 的执行 allowlist 仍只从实际创建的工具生成，不使用静态名称列表。 */
export const createTools = (deps: ToolDependencies) =>
  registrations.flatMap((group) => {
    const tools = group.create(deps);
    if (tools.length && JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(group.names))
      throw new Error("Tool registration names do not match definitions");
    return tools;
  });
