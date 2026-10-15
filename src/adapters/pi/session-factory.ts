import { createAgentSession, ModelRuntime, SettingsManager, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { DataLayout } from "../storage/data-layout.js";
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
import { buildSystemPrompt } from "./system-prompt.js";
import { createResourceLoader } from "./resource-loader.js";
import { createTools } from "./tools/index.js";

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
  worker?: Pick<TaskWorker, "kick">;
  tasks?: TaskService;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
  web?: WebService;
  weather?: WeatherService;
};

/** 仅装配 pi 运行环境；agent loop 与 JSONL 持久化继续完全交给 SDK。 */
export async function openPi(deps: PiDeps) {
  const { config, layout, sessionManager, memory, jobs, worker, modelRuntime } = deps;
  const { tasks, goals, actions, actionTimeoutMs, monitors, web, weather } = deps;
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = layout.workspaceDir;
  const agentDir = layout.agentDir;
  const systemPrompt = await buildSystemPrompt(layout, memory, web !== undefined, weather !== undefined, goals);
  const resourceLoader = createResourceLoader(systemPrompt);
  const customTools = createTools({
    root: cwd,
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
  });
  modelRuntime.registerProvider("personal", {
    baseUrl: config.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: config.modelId!,
        name: config.modelId!,
        reasoning: false,
        input: ["text"],
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
  // runtime key 只驻留内存，不写进 pi auth.json。无鉴权本地 endpoint 使用占位值。
  await modelRuntime.setRuntimeApiKey(
    "personal",
    config.apiKey || "local-no-key",
  );
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
    tools: customTools.map((tool) => tool.name),
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
