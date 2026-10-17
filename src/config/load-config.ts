import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { registeredToolNames } from "../adapters/pi/tools/index.js";

/**
 * 配置文件是唯一的外部配置来源：常规设置和密钥都直接写在 JSON 中。
 * 借鉴 nanobot 的 config.json 模式，但不做环境变量覆盖或 ${ENV} 插值，
 * 让"改哪个文件会生效"保持一条直线，也避免测试和部署出现两套来源。
 *
 * 数值/布尔默认值统一在各子 schema 的 .default() 声明；createConfig 用
 * 父级 .prefault({}) 触发嵌套解析，默认值只写一处，范围错误由 refine 给出。
 */
const toolPresentationMode = z.enum(["hidden", "summary"]);
const positiveInt = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .refine((v) => v >= 1 && v <= max, `must be a positive integer <= ${max}`)
    .default(fallback);

const serverSchema = z.object({
  host: z.string().optional(),
  // 避开 nanobot(7890) / Vite(5173) 等常见默认端口；启动时若被占用会在区间内自动 +1 找空闲。
  port: positiveInt(65535, 17890),
  accessKey: z.string().optional(),
  allowedOrigins: z.array(z.string()).optional(),
}).strict();
const modelSchema = z.object({
  baseUrl: z.string().optional(),
  id: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindow: positiveInt(10_000_000, 32768),
  maxTokens: positiveInt(1_000_000, 4096),
}).strict();
const runtimeSchema = z.object({
  dataDir: z.string().optional(),
  runTimeoutMs: positiveInt(3_600_000, 120_000),
  monitorScanIntervalMs: positiveInt(3_600_000, 60_000),
  schedulerIntervalMs: positiveInt(3_600_000, 30_000),
}).strict();
const webSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: positiveInt(60_000, 30_000),
  maxResponseBytes: positiveInt(10_000_000, 2_000_000),
  maxContentChars: positiveInt(200_000, 50_000),
  searchResults: positiveInt(10, 5),
  userAgent: z.string().optional(),
  // 默认拒绝回环/私网目标；本机联调（如本地页面监控验收）显式打开。
  allowPrivateTargets: z.boolean().default(false),
}).strict();
const weatherSchema = z.object({
  enabled: z.boolean().default(true),
  defaultCity: z.string().optional(),
}).strict();
// 写文件默认开启（每次执行都需人工审批）；审批等待默认 5 分钟超时。
const writableSchema = z.object({
  enabled: z.boolean().default(true),
  actionTimeoutMs: positiveInt(3_600_000, 300_000),
}).strict();
const presentationSchema = z.object({
  default: toolPresentationMode.optional(),
  overrides: z.record(z.string(), toolPresentationMode).optional(),
}).strict();

const configFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  server: serverSchema.prefault({}),
  model: modelSchema.prefault({}),
  runtime: runtimeSchema.prefault({}),
  tools: z.object({
    web: webSchema.prefault({}),
    weather: weatherSchema.prefault({}),
    writable: writableSchema.prefault({}),
    presentation: presentationSchema.prefault({}),
  }).strict().prefault({}),
}).strict();

export type ConfigFileInput = z.input<typeof configFileSchema>;

const defaultConfigFile = ".pi-muse/config.json";
const defaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const parseConfigFile = (value: unknown, path: string) => {
  const parsed = configFileSchema.safeParse(value);
  if (!parsed.success) {
    // 只输出字段路径和校验信息，不透出 zod 的 received 值，避免误填密钥时泄露。
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    const message = issue?.message ?? "unknown schema error";
    throw new Error(`Invalid config file ${path}${location}: ${message}`);
  }
  return parsed.data;
};

const text = (value: string | undefined) => value?.trim();

/**
 * 从已解析的 JSON 对象创建运行时配置。mock 和测试使用这个入口构造隔离实例；
 * 正式入口仍必须通过 loadConfig() 读取磁盘文件，不接受环境变量替代。
 */
export const createConfig = (
  value: unknown,
  options: { configFile?: string } = {},
) => {
  const configFile = resolve(options.configFile ?? defaultConfigFile);
  const file = parseConfigFile(value, configFile);

  const host = text(file.server.host) || "0.0.0.0";
  const accessKey = text(file.server.accessKey) || undefined;
  // 默认监听全部网卡便于局域网访问；无访问密钥时打印警告而非阻断启动，
  // 让本地个人助手场景可以零配置跑通。生产部署应自行在 config.json 设置 server.accessKey。
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !accessKey)
    console.warn(
      `[pi-muse] server.host=${host} is non-loopback but server.accessKey is empty; ` +
        "any device on the LAN can call this server. Set server.accessKey in config.json to require a token.",
    );

  const baseUrl = (text(file.model.baseUrl) || "").replace(/\/+$/, "");
  const modelId = text(file.model.id);
  if (Boolean(baseUrl) !== Boolean(modelId))
    throw new Error("Set model.baseUrl and model.id together");
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "model.baseUrl must be an HTTP(S) URL without credentials, query or fragment",
      );
  }

  const { maxTokens, contextWindow } = file.model;
  if (maxTokens >= contextWindow)
    throw new Error("model.maxTokens must be smaller than model.contextWindow");

  const dataDir = text(file.runtime.dataDir)
    ? resolve(dirname(configFile), text(file.runtime.dataDir)!)
    : dirname(configFile);

  const weather = {
    enabled: file.tools.weather.enabled,
    defaultCity: text(file.tools.weather.defaultCity) || undefined,
  };
  const web = {
    ...file.tools.web,
    userAgent: text(file.tools.web.userAgent) || defaultUserAgent,
  };

  // 写文件默认开启（每次执行都需人工审批）；审批等待默认 5 分钟超时。
  const writable = file.tools.writable;
  const presentation = {
    default: file.tools.presentation?.default ?? "hidden",
    overrides: file.tools.presentation?.overrides ?? {},
  } as const;
  const unknownPresentationTool = Object.keys(presentation.overrides).find(
    (name) => !registeredToolNames.includes(name),
  );
  if (unknownPresentationTool)
    throw new Error(`Unknown tools.presentation.overrides tool: ${unknownPresentationTool}`);

  return {
    host,
    accessKey,
    baseUrl: baseUrl || undefined,
    modelId,
    maxTokens,
    contextWindow,
    port: file.server.port,
    apiKey: text(file.model.apiKey),
    dataDir,
    runTimeoutMs: file.runtime.runTimeoutMs,
    monitorScanIntervalMs: file.runtime.monitorScanIntervalMs,
    schedulerIntervalMs: file.runtime.schedulerIntervalMs,
    allowedOrigins: (file.server.allowedOrigins ?? [
      "http://localhost:15173",
      "http://127.0.0.1:15173",
      // 局域网设备（手机、其他电脑）从本机 IP 访问 Web 时常见的 origin。
      "http://localhost:17890",
      "http://127.0.0.1:17890",
    ])
      .map((origin) => origin.trim())
      .filter(Boolean),
    configured: Boolean(baseUrl && modelId),
    web,
    weather,
    writable,
    presentation,
  };
};

/** 正式入口读取必需配置文件；不存在、损坏或字段非法都直接启动失败。 */
export const loadConfig = (configFile: string = defaultConfigFile): Config => {
  const path = resolve(configFile);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Config file not found: ${path}`);
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON in config file ${path}`);
    throw error;
  }
  return createConfig(value, { configFile: path });
};
export type Config = ReturnType<typeof createConfig>;
