import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SettingsManager,
  type ResourceLoader,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { Config } from "./config.js";

const systemPrompt = `You are Personal Bot, a helpful personal assistant.
Answer in the user's language. Be clear, practical, and honest about uncertainty.
You have exactly one tool: currentTime, which reads the local clock. You have no
browser, filesystem access, email, calendar, background tasks, or durable
personal memory outside this conversation. Never claim to have performed an
action you cannot do.`;

// P2 唯一注册的工具：只读本地时钟。不碰文件、shell、网络，参数为空对象，
// 模型无法借它表达任何副作用。错误信息也只包含本地时间格式化的失败原因。
const currentTimeTool = defineTool({
  name: "currentTime",
  label: "Current time",
  description:
    "Get the current local date and time of the server, including its time zone. " +
    "Use it whenever the user asks what time or date it is now. Takes no arguments.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async () => {
    const now = new Date();
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
    const local = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
    const text = `${local} (${timeZone})\nISO 8601: ${now.toISOString()}`;
    return {
      content: [{ type: "text", text }],
      details: { iso: now.toISOString(), timeZone, locale },
    };
  },
});

export async function openPi(config: Config, sessionManager: SessionManager) {
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = join(config.dataDir, "workspace");
  const agentDir = join(config.dataDir, "agent");
  // 完全由宿主提供资源，避免发现 ~/.pi、父目录 AGENTS.md、skills 或任意扩展。
  // cwd 只是资源/会话分组目录，不是执行沙箱；P1 不注册或启用任何工具。
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
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
    // 只注册只读 currentTime；allowlist 保证内置 read/bash 等一律不暴露给模型。
    // 旧 session 恢复时 pi 会用 system message 把工具集差异通知模型，无需手工合并。
    customTools: [currentTimeTool],
    tools: ["currentTime"],
    // P1 不做自动重试/压缩，保证一次用户提交只有一条可解释的文本输出。
    // 长会话压缩和可视化提示待后续加入，避免静默替换流中已展示的失败输出。
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  return session;
}
