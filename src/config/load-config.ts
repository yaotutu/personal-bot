import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { registeredToolNames } from "../adapters/pi/tools/index.js";

/**
 * 配置文件是唯一的外部配置来源：常规设置和密钥都直接写在 JSON 中。
 * 借鉴 nanobot 的 config.json 模式，但不做环境变量覆盖或 ${ENV} 插值，
 * 让“改哪个文件会生效”保持一条直线，也避免测试和部署出现两套来源。
 */
const toolPresentationMode = z.enum(["hidden", "summary"]);

const configFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  server: z
    .object({
      host: z.string().optional(),
      port: z.number().int().optional(),
      accessKey: z.string().optional(),
      allowedOrigins: z.array(z.string()).optional(),
    })
    .strict()
    .default({}),
  model: z
    .object({
      baseUrl: z.string().optional(),
      id: z.string().optional(),
      apiKey: z.string().optional(),
      contextWindow: z.number().int().optional(),
      maxTokens: z.number().int().optional(),
    })
    .strict()
    .default({}),
  runtime: z
    .object({
      dataDir: z.string().optional(),
      runTimeoutMs: z.number().int().optional(),
      monitorScanIntervalMs: z.number().int().optional(),
          schedulerIntervalMs: z.number().int().optional(),
    })
    .strict()
    .default({}),
  tools: z
    .object({
      web: z
        .object({
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().optional(),
          maxResponseBytes: z.number().int().optional(),
          maxContentChars: z.number().int().optional(),
          searchResults: z.number().int().optional(),
          userAgent: z.string().optional(),
        })
        .strict()
        .optional(),
      weather: z
        .object({
          enabled: z.boolean().optional(),
          defaultCity: z.string().optional(),
        })
        .strict()
        .optional(),
      writable: z
        .object({
          enabled: z.boolean().optional(),
          actionTimeoutMs: z.number().int().optional(),
        })
        .strict()
        .optional(),
      presentation: z
        .object({
          default: toolPresentationMode.optional(),
          overrides: z.record(z.string(), toolPresentationMode).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .default({ web: {} }),
}).strict();

export type ConfigFileInput = z.input<typeof configFileSchema>;
const defaultConfigFile = ".personal-bot/config.json";
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

const integer = (
  value: number | undefined,
  fallback: number,
  name: string,
  max = 1_000_000,
) => {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`${name} must be a positive integer <= ${max}`);
  return number;
};

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

  const host = text(file.server.host) || "127.0.0.1";
  const accessKey = text(file.server.accessKey) || undefined;
  // 无访问密钥时只能绑定回环地址。CORS 不是鉴权，不能靠它保护对外监听。
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !accessKey)
    throw new Error("server.accessKey is required for a non-loopback server.host");

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

  const maxTokens = integer(
    file.model.maxTokens,
    4096,
    "model.maxTokens",
  );
  const contextWindow = integer(
    file.model.contextWindow,
    32768,
    "model.contextWindow",
    10_000_000,
  );
  if (maxTokens >= contextWindow)
    throw new Error("model.maxTokens must be smaller than model.contextWindow");

  const dataDir = text(file.runtime.dataDir)
    ? resolve(dirname(configFile), text(file.runtime.dataDir)!)
    : dirname(configFile);

  const weather = {
    enabled: file.tools.weather?.enabled ?? true,
    defaultCity: text(file.tools.weather?.defaultCity) || undefined,
  };
  const web = {
    enabled: file.tools.web?.enabled ?? true,
    timeoutMs: integer(file.tools.web?.timeoutMs, 30_000, "tools.web.timeoutMs", 60_000),
    maxResponseBytes: integer(
      file.tools.web?.maxResponseBytes,
      2_000_000,
      "tools.web.maxResponseBytes",
      10_000_000,
    ),
    maxContentChars: integer(
      file.tools.web?.maxContentChars,
      50_000,
      "tools.web.maxContentChars",
      200_000,
    ),
    searchResults: integer(file.tools.web?.searchResults, 5, "tools.web.searchResults", 10),
    userAgent: text(file.tools.web?.userAgent) || defaultUserAgent,
  };

  // 写文件默认开启（每次执行都需人工审批）；审批等待默认 5 分钟超时。
  const writable = {
    enabled: file.tools.writable?.enabled ?? true,
    actionTimeoutMs: integer(
      file.tools.writable?.actionTimeoutMs,
      300_000,
      "tools.writable.actionTimeoutMs",
      3_600_000,
    ),
  };
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
    port: integer(file.server.port, 8787, "server.port", 65535),
    apiKey: text(file.model.apiKey),
    dataDir,
    runTimeoutMs: integer(
      file.runtime.runTimeoutMs,
      120_000,
      "runtime.runTimeoutMs",
      3_600_000,
    ),
    monitorScanIntervalMs: integer(
      file.runtime?.monitorScanIntervalMs,
      60_000,
      "runtime.monitorScanIntervalMs",
      3_600_000,
    ),
    schedulerIntervalMs: integer(
      file.runtime.schedulerIntervalMs,
      30_000,
      "runtime.schedulerIntervalMs",
      3_600_000,
    ),
    allowedOrigins: (file.server.allowedOrigins ?? [
      "http://localhost:8081",
      "http://127.0.0.1:8081",
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
