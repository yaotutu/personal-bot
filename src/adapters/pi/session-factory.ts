import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  loadSkillsFromDir,
  ModelRuntime,
  SettingsManager,
  type SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { DataLayout } from "../storage/data-layout.js";
import { threadWorkspaceDir, sharedWorkspaceDir, ensureThreadWorkspace, threadInstructionsFile } from "../storage/data-layout.js";
import { readThreadInstructions } from "../storage/thread-instructions.js";
import { getBuiltinSkillsDir } from "../storage/builtin-skills.js";
import type { Config } from "../../config/load-config.js";
import type { MemoryService } from "../../features/memory/memory-service.js";
import type { JobService } from "../../features/jobs/job-service.js";
import type { TaskService } from "../../features/tasks/task-service.js";
import type { TaskWorker } from "../../features/tasks/task-worker.js";
import type { GoalService } from "../../features/goals/goal-service.js";
import type { ActionService } from "../../features/actions/action-service.js";
import type { MonitorService } from "../../features/monitors/monitor-service.js";
import type { WebService } from "../../features/web/types.js";
import type { WeatherService } from "../../features/weather/types.js";
import type { SkillsService } from "../../features/skills/service.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createResourceLoader } from "./resource-loader.js";
import { createTools, skillToToolsMap, registeredToolNames } from "./tools/index.js";

/**
 * pi 装配的依赖集合。全部经由组合入口显式注入；可选能力（goals/actions/
 * monitors/tasks/web/weather）缺省时对应工具不声明，不留第二套装配路径。
 * 单对象参数消除此前 13 个位置参数的传错序风险。
 */
export type PiDeps = {
  config: Config;
  layout: DataLayout;
  /** 组合层预构建的 runtime（provider/key 已注册）；每轮重建只浪费 I/O。 */
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  memory: MemoryService;
  jobs: JobService;
  worker?: Pick<TaskWorker, "kick" | "control">;
  tasks?: TaskService;
  threadId: string;
  runId?: string;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
  web?: WebService;
  weather?: WeatherService;
  skills?: SkillsService;
};

/** 仅装配 pi 运行环境；agent loop 与 JSONL 持久化继续完全交给 SDK。 */
export async function openPi(deps: PiDeps) {
  const { config, layout, sessionManager, memory, jobs, worker, modelRuntime } = deps;
  const { tasks, goals, actions, actionTimeoutMs, monitors, web, weather, skills } = deps;
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = threadWorkspaceDir(layout, deps.threadId);
  const sharedDir = sharedWorkspaceDir(layout);
  await ensureThreadWorkspace(layout, deps.threadId);
  const agentDir = layout.agentDir;

  // 1. 加载技能并计算生效值
  const effectiveSkills = skills && deps.threadId
    ? await skills.getEffectiveSkills(deps.threadId)
    : [];
  const enabledSkillNames = new Set(
    effectiveSkills.filter(s => s.enabled).map(s => s.name)
  );

  // 2. 加载技能定义与 Extension
  const builtinSkills = loadSkillsFromDir({ dir: getBuiltinSkillsDir(), source: "project" }).skills;
  const userSkills = existsSync(layout.skillsDir)
    ? loadSkillsFromDir({ dir: layout.skillsDir, source: "project" }).skills
    : [];
  const skillMap = new Map<string, Skill>();
  for (const s of builtinSkills) skillMap.set(s.name, s);
  for (const s of userSkills) skillMap.set(s.name, s);

  const activeSkills = Array.from(skillMap.values()).filter((s) => enabledSkillNames.has(s.name));

  const extensionPaths: string[] = [];
  for (const skill of activeSkills) {
    const extFile = join(skill.baseDir, "extension.ts");
    if (existsSync(extFile)) {
      extensionPaths.push(extFile);
    }
  }

  const extensionResult = extensionPaths.length > 0
    ? await discoverAndLoadExtensions(extensionPaths, layout.root, layout.agentDir)
    : { extensions: [], errors: [], runtime: createExtensionRuntime() };

  // 3. 裁剪工具并合并 Extension 工具
  const allCustomTools = createTools({
    root: cwd,
    sharedDir,
    readOnlyFiles: activeSkills.map((skill) => skill.filePath),
    threadId: deps.threadId,
    runId: deps.runId,
    memory,
    jobs,
    tasks,
    worker,
    goals,
    actions,
    actionTimeoutMs,
    monitors,
    web,
    weather,
    layout,
  });

  const builtinToolNames = new Set(registeredToolNames);
  const extensionToolNames: string[] = [];
  const seenExtensionTools = new Set<string>();

  for (const ext of extensionResult.extensions) {
    if (ext.tools instanceof Map) {
      for (const toolName of ext.tools.keys()) {
        if (builtinToolNames.has(toolName)) {
          ext.tools.delete(toolName);
          extensionResult.errors.push({ path: ext.path, error: `Reserved tool name: ${toolName}` });
          continue;
        }
        if (seenExtensionTools.has(toolName)) {
          ext.tools.delete(toolName);
          extensionResult.errors.push({ path: ext.path, error: `Duplicate extension tool: ${toolName}` });
          continue;
        }
        seenExtensionTools.add(toolName);
        extensionToolNames.push(toolName);
      }
    }
  }

  const builtinAllowedToolNames = allCustomTools
    .filter((tool) => {
      // 常开工具（不在任何技能映射中的）始终保留
      const isAlwaysOn = !Object.values(skillToToolsMap).flat().includes(tool.name);
      if (isAlwaysOn) return true;
      // 检查工具所属的技能是否启用
      for (const [skillName, toolNames] of Object.entries(skillToToolsMap)) {
        if (toolNames.includes(tool.name)) {
          return enabledSkillNames.has(skillName);
        }
      }
      return true;
    })
    .map((tool) => tool.name);

  const allowedToolNames = [...builtinAllowedToolNames, ...extensionToolNames];
  const customTools = allCustomTools.filter((tool) => builtinAllowedToolNames.includes(tool.name));

  // 4. 构建 System Prompt 并注入技能、专属会话指令与 Extension
  const instructionsFile = deps.threadId ? threadInstructionsFile(layout, deps.threadId) : undefined;
  const threadInstructions = instructionsFile ? await readThreadInstructions(instructionsFile) : undefined;
  const systemPrompt = await buildSystemPrompt(layout, memory, web !== undefined, weather !== undefined, goals, threadInstructions);
  const resourceLoader = createResourceLoader(systemPrompt, activeSkills, extensionResult);

  // provider 与内存凭据由 bootstrap 唯一初始化；每轮仅查询模型，避免修改共享 runtime。
  const model = modelRuntime.getModel("personal", config.modelId!);
  if (!model) throw new Error("MODEL_NOT_CONFIGURED");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    sessionManager,
    resourceLoader,
    thinkingLevel: "off",
    // 工具定义是唯一允许列表来源，防止注册列表与执行权限名单漂移。
    // guard 的路径拒绝与 pi 的工具执行/持久化仍由原有链路处理。
    customTools,
    tools: allowedToolNames,
    // 自动重试仍关闭（一次提交一条可解释输出）；压缩开启：长会话超阈值时
    // pi 用摘要替换模型上下文，展示历史不受影响（history 走 getBranch 全量投影）。
    // pi 默认 reserveTokens=16384 只适合大窗口模型；小 context 下阈值会变成
    // 负数导致压缩死循环，因此按窗口比例收缩（保留一半、近期保住四分之一）。
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.min(16384, Math.floor(config.contextWindow / 2)),
        keepRecentTokens: Math.min(20000, Math.floor(config.contextWindow / 4)),
      },
      retry: { enabled: false },
    }),
  });
  return session;
}
