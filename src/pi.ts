import {
  createAgentSession,
  createExtensionRuntime,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  ModelRuntime,
  SettingsManager,
  type ResourceLoader,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import type { MemoryStore } from "./memory.js";

const basePrompt = `You are Personal Bot, a helpful personal assistant.
Answer in the user's language. Be clear, practical, and honest about uncertainty.
You can read reference files: the read/grep/find/ls tools access the shared
documents directory and nowhere else. currentTime reads the local clock. You
have no write access, shell, browser, email, calendar, background tasks, or
durable personal memory outside this conversation. Never claim to have
performed an action you cannot do.`;

// P3 第一步：身份注入。SOUL.md（助手性格）与 USER.md（用户画像）放在
// DATA_DIR 下（不在资料目录内，模型工具读不到，只经 system prompt 注入）。
// 每轮 openPi 重读文件，修改后下一轮对话即生效；文件不存在则保持基础人设。
const readProfile = async (path: string, section: string) => {
  try {
    const content = (await readFile(path, "utf8")).trim();
    if (!content) return "";
    return `\n\n## ${section}\n${content}`;
  } catch {
    return "";
  }
};
const buildSystemPrompt = async (dataDir: string) =>
  basePrompt +
  (await readProfile(join(dataDir, "SOUL.md"), "Your identity (SOUL)")) +
  (await readProfile(join(dataDir, "USER.md"), "The user (USER)"));

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

// 复用 pi 内置只读文件工具（read/grep/find/ls），但在执行前强制路径边界：
// 解析后的绝对路径必须落在资料目录内，否则拒绝。pi 原生的 cwd 只是相对路径
// 基准，绝对路径与 ../ 都能逃逸，因此这层防护不能省。customTools 同名覆盖
// 内置注册，allowlist 保证 bash/edit/write 永不暴露。
const guardPath = (root: string, raw: unknown): string | null => {
  const input = typeof raw === "string" && raw.trim() ? raw : ".";
  const resolved = resolve(root, input);
  return resolved === root || resolved.startsWith(root + sep) ? resolved : null;
};
const guardTool = (
  definition: ToolDefinition<any, any>,
  root: string,
): ToolDefinition<any, any> => ({
  ...definition,
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const path = (params as { path?: unknown }).path;
    if (!guardPath(root, path))
      return {
        content: [
          {
            type: "text",
            text: "Access denied: path is outside the documents directory.",
          },
        ],
        details: { denied: true },
        isError: true,
      };
    return definition.execute(toolCallId, params, signal, onUpdate, ctx);
  },
});

// P3 对话式记忆工具：只显式写入（用户说"记住/忘掉"才动），目标是唯一的
// memory.json，不触碰文件系统其它位置。精确编辑走 Apps 页界面。
const memoryTool = (store: MemoryStore) =>
  defineTool({
    name: "memory",
    label: "Long-term memory",
    description:
      "Explicitly remember or forget a fact about the user, persisting across conversations. " +
      'Use remember when the user says things like "记住…/remember…". ' +
      "Use forget when the user asks to remove a memory (match by keyword). " +
      "Never store credentials, API keys, or secrets.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("remember"), Type.Literal("forget")]),
        text: Type.Optional(
          Type.String({ description: "The fact to remember, concise, in the user's language." }),
        ),
        keyword: Type.Optional(
          Type.String({ description: "Keyword of the memory to forget." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "remember") {
        if (!params.text?.trim())
          return {
            content: [{ type: "text", text: "Nothing to remember: empty text." }],
            details: undefined,
            isError: true,
          };
        const item = await store.add(params.text, "chat");
        return {
          content: [{ type: "text", text: `Remembered: ${item.text}` }],
          details: { id: item.id },
        };
      }
      const keyword = params.keyword?.trim() ?? params.text?.trim() ?? "";
      if (!keyword)
        return {
          content: [{ type: "text", text: "Nothing to forget: empty keyword." }],
          details: undefined,
          isError: true,
        };
      const list = await store.list();
      const hits = list.filter((x) => x.text.includes(keyword));
      if (!hits.length)
        return {
          content: [{ type: "text", text: `No memory matches "${keyword}".` }],
          details: undefined,
        };
      for (const hit of hits) await store.forget(hit.id);
      return {
        content: [
          { type: "text", text: `Forgot ${hits.length} memory item(s) matching "${keyword}".` },
        ],
        details: undefined,
      };
    },
  });

export async function openPi(
  config: Config,
  sessionManager: SessionManager,
  memory: MemoryStore,
) {
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = join(config.dataDir, "workspace");
  const agentDir = join(config.dataDir, "agent");
  const systemPrompt =
    (await buildSystemPrompt(config.dataDir)) + (await memory.renderForPrompt());
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
    // 只读能力集合：currentTime + 资料目录内的 read/grep/find/ls。
    // guard 已保证路径边界；allowlist 保证 bash/edit/write 等一律不暴露给模型。
    // 旧 session 恢复时 pi 会用 system message 把工具集差异通知模型，无需手工合并。
    customTools: [
      currentTimeTool,
      memoryTool(memory),
      guardTool(createReadToolDefinition(cwd), cwd),
      guardTool(createGrepToolDefinition(cwd), cwd),
      guardTool(createFindToolDefinition(cwd), cwd),
      guardTool(createLsToolDefinition(cwd), cwd),
    ],
    tools: ["currentTime", "memory", "read", "grep", "find", "ls"],
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
