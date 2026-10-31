import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeWorkspacePath } from "./tools/workspace-path.js";
import {
  createAgentSession,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  loadSkillsFromDir,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { DataLayout } from "../storage/data-layout.js";
import { threadWorkspaceDir, sharedWorkspaceDir, ensureThreadWorkspace, threadInstructionsFile } from "../storage/data-layout.js";
import { readThreadInstructions } from "../storage/thread-instructions.js";
import { getBuiltinSkillsDir } from "../storage/builtin-skills.js";
import type { Config } from "../../config/load-config.js";
import type { MemoryService } from "../../features/memory/memory-service.js";
import type { JobService } from "../../features/jobs/job-service.js";
import type { GoalService } from "../../features/goals/goal-service.js";
import type { ActionService } from "../../features/actions/action-service.js";
import type { MonitorService } from "../../features/monitors/monitor-service.js";
import type { WebService } from "../../features/web/types.js";
import type { WeatherService } from "../../features/weather/types.js";
import type { BrowserService } from "../../features/browser/browser-service.js";
import type { SkillsService } from "../../features/skills/service.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createInformationNotificationContextExtension,
  INFORMATION_BACKGROUND_SYSTEM_PROMPT,
} from "./information-notification-context.js";
import { createResourceLoader } from "./resource-loader.js";
import { createTools, skillToToolsMap, registeredToolNames } from "./tools/index.js";
import type { ReadOnlyFile } from "./tools/path-guard.js";
import { loadSubagentRoles } from "../storage/subagent-roles.js";
import { createSubagentExtension, SUBAGENT_TOOL_NAME, type SubagentRole } from "./subagent/extension.js";
import { projectExecutionEvent } from "./execution.js";
import type { ActivityRun, ActivityObservation } from "../../features/activities/types.js";
import { createActivityObserver } from "./activity-observer.js";
import { createToolPresentation, type ToolPresentation } from "../ag-ui/tool-presentation.js";
import type { WorkspaceCommitQueue } from "../workspace/file-commit-queue.js";
import { ACTIVITY_TOOL_INSTRUCTIONS, ACTIVITY_TOOL_NAME } from "./tools/activity.js";
import type { StatusRun } from "../../features/workspace/agent-status.js";
import { createStatusObserver } from "./status-observer.js";

/**
 * pi 装配的依赖集合。全部经由组合入口显式注入；可选能力（goals/actions/
 * monitors/web/weather）缺省时对应工具不声明，不留第二套装配路径。
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
  /** 仅子会话使用：父会话技能/工具快照作为权限上限，角色只可收窄。 */
  child?: { role: SubagentRole; enabledSkills: readonly string[]; allowedTools: readonly string[]; ownerSpaceId: string; ownerRunId?: string };
  spaceId: string;
  runId?: string;
  /** 当前轮次的用户输入文本，用于自动召回长会话记忆线索并注入提示词。 */
  userText?: string;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
  web?: WebService;
  weather?: WeatherService;
  browser?: BrowserService;
  status?: StatusRun;
  statusSubagentId?: string;
  activity?: ActivityRun;
  activityPrefix?: string;
  activityParentId?: string;
  skills?: SkillsService;
  presentation?: ToolPresentation;
  /** 与手动 HTTP 文件入口共用，保证最终版本检查与提交按物理路径串行。 */
  workspaceCommits?: WorkspaceCommitQueue;
  /** 普通聊天的空间局部信息查询；后台信息 runner 不装配该入口。 */
  information?: Pick<import("../../features/information/service.js").InformationService, "getSettings" | "query">;
};

const subagentBlockedTools = new Set([SUBAGENT_TOOL_NAME, "activity", "schedule", "monitor", "instructions", "bash"]);
const skillTextResourceExtensions = new Set([".md", ".txt", ".json", ".csv", ".yaml", ".yml"]);

/** 只把启用技能的精确文本文件交给 read；目录、代码、配置和其他邻居仍不可见。 */
const collectReadableSkillFiles = async (skills: readonly Skill[]): Promise<ReadOnlyFile[]> => {
  const files: ReadOnlyFile[] = [];
  const entryFor = async (
    root: string,
    target: string,
    boundaryDir: string,
  ): Promise<ReadOnlyFile | undefined> => {
    const safe = await safeWorkspacePath(root, target, { boundaryDir }).catch(() => undefined);
    // 保留 SDK 提示中的词法路径；每次 read 再由 guard/operations 重新解析并复核全链路。
    return safe ? { path: resolve(target), root: resolve(root), boundaryDir: resolve(boundaryDir) } : undefined;
  };
  const walkResources = async (directory: string, boundaryDir: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await lstat(path).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walkResources(path, boundaryDir);
      else if (stat.isFile() && entry.name !== "SKILL.md" &&
        skillTextResourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        const file = await entryFor(directory, path, boundaryDir).catch(() => undefined);
        if (file) files.push(file);
      }
    }
  };
  for (const skill of skills) {
    // 技能根或任一祖先若是链接，整体不进入只读例外。
    const skillBoundary = dirname(skill.baseDir);
    const skillFile = await entryFor(skill.baseDir, skill.filePath, skillBoundary).catch(() => undefined);
    if (!skillFile) continue;
    files.push(skillFile);
    const root = skillFile.root;
    for (const resourceDir of ["references", "assets"]) {
      const directory = join(root, resourceDir);
      const stat = await lstat(directory).catch(() => undefined);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await walkResources(directory, skillBoundary);
    }
  }
  return files;
};

/** 仅装配 pi 运行环境；agent loop 与 JSONL 持久化继续完全交给 SDK。 */
export async function openPi(deps: PiDeps) {
  const { config, layout, sessionManager, memory, jobs, modelRuntime } = deps;
  const { goals, actions, actionTimeoutMs, monitors, web, weather, browser, skills, child } = deps;
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = threadWorkspaceDir(layout, deps.spaceId);
  const sharedDir = sharedWorkspaceDir(layout);
  await ensureThreadWorkspace(layout, deps.spaceId);
  const agentDir = layout.agentDir;
  // openPi 每轮执行都会重新创建；设置读取失败必须中止本轮，不能伪装成关闭。
  const informationEnabled = !child && deps.information && deps.spaceId
    ? (await deps.information.getSettings(deps.spaceId)).enabled
    : false;

  // 1. 加载技能并计算生效值
  const effectiveSkills = !child && skills && deps.spaceId
    ? await skills.getEffectiveSkills(deps.spaceId)
    : [];
  const enabledSkillNames = new Set(
    child?.enabledSkills ?? effectiveSkills.filter(s => s.enabled).map(s => s.name)
  );

  // 2. 加载技能定义与 Extension
  const builtinSkills = loadSkillsFromDir({ dir: getBuiltinSkillsDir(), source: "project" }).skills;
  const userSkills = existsSync(layout.skillsDir)
    ? loadSkillsFromDir({ dir: layout.skillsDir, source: "project" }).skills
    : [];
  const skillMap = new Map<string, Skill>();
  for (const s of builtinSkills) skillMap.set(s.name, s);
  for (const s of userSkills) skillMap.set(s.name, s);

  const activeSkills = Array.from(skillMap.values()).filter((s) => enabledSkillNames.has(s.name) &&
    (!child || !["task", "cron", "monitor"].includes(s.name)) &&
    (s.name !== "browser" || (!child && Boolean(browser))));

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
    readOnlyFiles: await collectReadableSkillFiles(activeSkills),
    spaceId: child?.ownerSpaceId ?? deps.spaceId,
    runId: child?.ownerRunId ?? deps.runId,
    isSubagent: Boolean(child),
    subagentId: deps.statusSubagentId,
    workspaceSpaceId: child?.ownerSpaceId ?? deps.spaceId,
    currentActivityId: () => deps.status?.snapshot().activityId ?? null,
    activity: child ? undefined : deps.activity,
    activityObservation: deps.activity ? {
      observe: (event: ActivityObservation) => deps.activity!.observe(event),
      prefix: deps.activityPrefix ?? "main",
      getActivityId: () => deps.activity!.getCurrentActivityId(),
    } : undefined,
    memory,
    jobs,
    goals,
    actions,
    actionTimeoutMs,
    monitors,
    web,
    weather,
    browser,
    layout,
    skillsService: skills,
    writableEnabled: deps.config.writable.enabled,
    workspaceCommits: deps.workspaceCommits,
    information: informationEnabled ? deps.information : undefined,
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

  const allowedToolNames = [...builtinAllowedToolNames, ...extensionToolNames].filter((name) =>
    !child || (!subagentBlockedTools.has(name) &&
      child.allowedTools.includes(name) && (!child.role.tools || child.role.tools.includes(name)))
  );
  if (child) {
    for (const extension of extensionResult.extensions) {
      for (const name of extension.tools.keys()) {
        if (!allowedToolNames.includes(name)) extension.tools.delete(name);
      }
      // 可信扩展可以执行任意服务端代码，但子会话不能借其生命周期钩子重新扩充模型工具。
      extension.handlers.clear();
      extension.commands.clear();
    }
  }
  const customTools = allCustomTools.filter((tool) => allowedToolNames.includes(tool.name));

  // 官方扩展仅替换 child runner：上下文独立，凭据/工具边界复用项目装配。
  // 不启动 CLI，也不会从个人 ~/.pi 或可写工作区发现资源。
  const inlineExtensions: InlineExtension[] = [];
  if (informationEnabled) {
    inlineExtensions.push({
      name: "pi-muse-information-notification-context",
      hidden: true,
      factory: createInformationNotificationContextExtension(),
    });
  }
  if (!child && enabledSkillNames.has("task")) {
    const roles = await loadSubagentRoles(layout.subagentsDir);
    const extension = createSubagentExtension(roles, async (role, task, signal, update, parentToolCallId, queuedChildId) => {
      signal?.throwIfAborted();
      const childId = queuedChildId ?? `subagent-${randomUUID()}`;
      deps.status?.observe({ kind: "subagent", phase: "start", id: childId, role: role.name });
      const parentStepId = `main:tool:${parentToolCallId}`;
      deps.activity?.observe({ id: childId, parentId: parentStepId, kind: "subagent", phase: "start", title: "Subagent executing" });
      await ensureThreadWorkspace(layout, childId);
      signal?.throwIfAborted();
      const manager = SessionManager.inMemory(threadWorkspaceDir(layout, childId));
      const session = await openPi({
        ...deps, sessionManager: manager, spaceId: childId,
        child: { role, enabledSkills: [...enabledSkillNames], allowedTools: [...allowedToolNames], ownerSpaceId: deps.spaceId, ownerRunId: deps.runId },
        activity: deps.activity,
        activityPrefix: childId,
        activityParentId: childId,
        statusSubagentId: childId,
      });
      const abort = () => { void session.abort().catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      let output = "";
      let reason: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        const projected = projectExecutionEvent(event);
        if (projected?.type === "assistant_end") { reason = projected.reason; if (projected.text) output = projected.text; }
        if (event.type === "tool_execution_start" || event.type === "message_end")
          update({ agent: role.name, task, output: "Subagent is working" });
      });
      try {
        signal?.throwIfAborted();
        await session.prompt(`Task: ${task}`, { expandPromptTemplates: false });
        await session.waitForIdle();
        signal?.throwIfAborted();
        const failed = !reason || reason === "error" || reason === "aborted";
        deps.status?.observe({ kind: "subagent", phase: "end", id: childId, role: role.name, outcome: failed ? "failed" : "succeeded" });
        deps.activity?.observe({
          id: childId,
          parentId: parentStepId,
          kind: "subagent",
          phase: "end",
          status: failed ? "failed" : "succeeded",
          title: failed ? "Subagent failed" : "Subagent completed",
          result: failed ? "Subagent execution failed" : "Subagent completed task",
        });
        return { agent: role.name, task, output: failed ? "Subagent execution failed" : output || "(no output)", isError: failed };
      } catch {
        await session.abort();
        await session.waitForIdle();
        deps.status?.observe({ kind: "subagent", phase: "end", id: childId, role: role.name, outcome: signal?.aborted ? "cancelled" : "failed" });
        deps.activity?.observe({
          id: childId,
          parentId: parentStepId,
          kind: "subagent",
          phase: "end",
          status: signal?.aborted ? "cancelled" : "failed",
          title: "Subagent aborted or failed",
          result: "Subagent execution failed",
        });
        signal?.throwIfAborted();
        return { agent: role.name, task, output: "Subagent execution failed", isError: true };
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe();
        session.dispose();
      }
    }, (id, role) => deps.status?.observe({ kind: "subagent", phase: "queued", id, role }));
    inlineExtensions.push({ name: "pi-muse-subagent", hidden: true, factory: extension });
    allowedToolNames.push(SUBAGENT_TOOL_NAME);
  }
  if (inlineExtensions.length) {
    const inlineLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "", extensionFactories: inlineExtensions,
    });
    await inlineLoader.reload();
    const inline = inlineLoader.getExtensions();
    if (inline.errors.length) throw new Error("Inline session extensions could not be loaded");
    extensionResult.extensions.push(...inline.extensions);
  }

  // 4. 构建 System Prompt 并注入技能、专属会话指令与 Extension
  const instructionsFile = !child && deps.spaceId ? threadInstructionsFile(layout, deps.spaceId) : undefined;
  const threadInstructions = instructionsFile ? await readThreadInstructions(instructionsFile) : undefined;
  const recalledMemories = (deps.userText && memory) ? await memory.recall(deps.userText) : [];
  const systemPrompt = await buildSystemPrompt(
    { layout, memory, allowedToolNames, threadInstructions, recalledMemories },
  ) +
    (informationEnabled ? INFORMATION_BACKGROUND_SYSTEM_PROMPT : "") +
    (allowedToolNames.includes(ACTIVITY_TOOL_NAME)
      ? `\n\n## Work activity management\n${ACTIVITY_TOOL_INSTRUCTIONS}`
      : "") +
    (child ? `\n\n## Subagent role\n${child.role.systemPrompt}\nYou have an isolated context and private workspace. Return the result to the parent agent. You cannot delegate or schedule work. Use shared/... for shared materials; never assume access to the parent's private files.` : "");
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
  if (deps.activity) {
    const observer = createActivityObserver(
      (event) => deps.activity!.observe(event),
      deps.presentation ?? createToolPresentation(config.presentation),
      deps.activityPrefix ?? "main",
      deps.activityParentId,
    );
    session.subscribe(observer);
  }
  if (deps.status) session.subscribe(createStatusObserver(deps.status, deps.presentation ?? createToolPresentation(config.presentation), deps.statusSubagentId ?? null));
  return session;
}
