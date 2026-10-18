export type LiveOptions = { configPath: string; keepArtifacts: boolean };
export type ParseOutcome = { kind: "help"; help: string } | { kind: "ok"; options: LiveOptions } | { kind: "error"; message: string };
const help = `真实模型服务端验收（会产生网络流量和模型费用）

用法：pnpm test:live --config <JSON配置路径> --allow-live [--keep-artifacts]
  --config <path>   必填；仅读取 model，不使用原实例的 DATA_DIR/会话/工具设置。
  --allow-live      必填；显式允许向所选模型发送合成测试内容并产生费用。
  --keep-artifacts  可选；保留本次合成测试数据和脱敏报告，默认全部回收。
  --help            只显示帮助，不读取配置、不调用模型。

模型凭据只从配置读取并保留在内存，不接受命令行密钥、不写入临时配置或日志。
本命令不在 pnpm check 中运行，不自动重试模型或工具，不修改正式业务数据。
`;

/** 只解析测试命令参数，不加载业务服务；裸命令必须失败关闭，不能隐式调用真实模型。 */
export const parseLiveOptions = (argv: readonly string[]): ParseOutcome => {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.includes("--help") || args.includes("-h")) return { kind: "help", help };
  let configPath: string | undefined;
  let allowLive = false;
  let keepArtifacts = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (seen.has(name)) return { kind: "error", message: "Duplicate live test option" };
    seen.add(name);
    if (name === "--allow-live") allowLive = true;
    else if (name === "--keep-artifacts") keepArtifacts = true;
    else if (name === "--config") {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) return { kind: "error", message: "--config requires a JSON file path" };
      configPath = value;
    } else return { kind: "error", message: "Unknown live test option; use --help" };
  }
  if (!configPath) return { kind: "error", message: "Missing --config <path>; no default configuration is read" };
  if (!allowLive) return { kind: "error", message: "Refusing model calls without --allow-live" };
  return { kind: "ok", options: { configPath, keepArtifacts } };
};
