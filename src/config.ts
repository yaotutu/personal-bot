import { resolve } from "node:path";

const integer = (
  value: string | undefined,
  fallback: number,
  name: string,
  max = 1_000_000,
) => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`${name} must be a positive integer <= ${max}`);
  return number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  const accessKey = env.PERSONAL_ACCESS_KEY?.trim() || undefined;
  // 无访问密钥时只能绑定回环地址。CORS 不是鉴权，不能靠它保护对外监听。
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !accessKey)
    throw new Error("PERSONAL_ACCESS_KEY is required for a non-loopback HOST");
  const baseUrl = env.PERSONAL_MODEL_BASE_URL?.trim().replace(/\/+$/, "");
  const modelId = env.PERSONAL_MODEL_ID?.trim();
  if (Boolean(baseUrl) !== Boolean(modelId))
    throw new Error(
      "Set PERSONAL_MODEL_BASE_URL and PERSONAL_MODEL_ID together",
    );
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
        "PERSONAL_MODEL_BASE_URL must be an HTTP(S) URL without credentials, query or fragment",
      );
  }
  const maxTokens = integer(
    env.PERSONAL_MODEL_MAX_TOKENS,
    4096,
    "PERSONAL_MODEL_MAX_TOKENS",
  );
  const contextWindow = integer(
    env.PERSONAL_MODEL_CONTEXT_WINDOW,
    32768,
    "PERSONAL_MODEL_CONTEXT_WINDOW",
    10_000_000,
  );
  if (maxTokens >= contextWindow)
    throw new Error("Model max tokens must be smaller than context window");
  return {
    host,
    accessKey,
    baseUrl,
    modelId,
    maxTokens,
    contextWindow,
    port: integer(env.PORT, 8787, "PORT", 65535),
    apiKey: env.PERSONAL_MODEL_API_KEY?.trim(),
    dataDir: resolve(env.DATA_DIR?.trim() || ".personal-bot"),
    runTimeoutMs: integer(
      env.PERSONAL_RUN_TIMEOUT_MS,
      120_000,
      "PERSONAL_RUN_TIMEOUT_MS",
      3_600_000,
    ),
    allowedOrigins: (
      env.ALLOWED_ORIGINS || "http://localhost:8081,http://127.0.0.1:8081"
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    configured: Boolean(baseUrl && modelId),
  };
}
export type Config = ReturnType<typeof loadConfig>;
