import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestContext } from "node:test";

export type ServiceProcessOptions = { modelBaseUrl: string; runTimeoutMs?: number; webTimeoutMs?: number; actionTimeoutMs?: number; hiddenTools?: string[] };
export type ServiceProcessHandle = {
  cwd: string; dataDir: string; baseUrl: string; accessKey: string;
  start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; crash(): Promise<void>; close(): Promise<void>;
};
export const builtServiceEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

export const freeTestPort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
};

/** 仅启动构建入口：临时cwd/config/DATA_DIR独占，所有凭据为假值，不读取正式实例。 */
export const createServiceProcess = async (t: TestContext, options: ServiceProcessOptions): Promise<ServiceProcessHandle> => {
  let cwd = "";
  let baseUrl = "";
  let child: ChildProcess | undefined;
  type Exit = { code: number | null; signal: NodeJS.Signals | null };
  let exit: Promise<Exit> | undefined;
  let stopped: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  let output = "";
  const accessKey = "isolated-e2e-access-key";
  const stop = (): Promise<void> => {
    if (stopped) return stopped;
    const process = child;
    const ending = exit;
    if (!process || !ending) return Promise.resolve();
    stopped = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forced = false;
      try {
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
        timer = setTimeout(() => { forced = true; process.kill("SIGKILL"); }, 8000);
        const result = await ending;
        assert.equal(forced, false, "service required SIGKILL after SIGTERM");
        assert.deepEqual(result, { code: 0, signal: null }, `service exited abnormally: ${output}`);
      } finally { clearTimeout(timer); child = undefined; }
    })();
    return stopped;
  };
  // crash 是专门的异常终止场景，不走正常 stop，也绝不能把 SIGKILL 当成优雅退出证据。
  const crash = async () => {
    const process = child;
    const ending = exit;
    if (!process || !ending) throw new Error("service fixture is not running");
    process.kill("SIGKILL");
    try { assert.deepEqual(await ending, { code: null, signal: "SIGKILL" }); }
    finally { child = undefined; stopped = undefined; }
  };
  const close = () => closed ??= (async () => {
    try { await stop(); }
    finally { if (cwd) await rm(cwd, { recursive: true, force: true }); }
  })();
  t.after(close);
  const start = async () => {
    if (closed) throw new Error("service fixture is closed");
    if (child) throw new Error("service fixture is already running");
    await access(builtServiceEntry).catch(() => { throw new Error("Missing dist/index.js; run pnpm build first"); });
    const port = await freeTestPort();
    baseUrl = `http://127.0.0.1:${port}`;
    stopped = undefined;
    output = "";
    const config = {
      server: { host: "127.0.0.1", port, accessKey },
      model: { baseUrl: options.modelBaseUrl, id: "e2e-model", apiKey: "isolated-fake-model-key" },
      runtime: { dataDir: ".", runTimeoutMs: options.runTimeoutMs ?? 30_000, schedulerIntervalMs: 60_000, monitorScanIntervalMs: 60_000 },
      tools: {
        writable: { actionTimeoutMs: options.actionTimeoutMs ?? 300_000 },
        web: { allowPrivateTargets: true, timeoutMs: options.webTimeoutMs ?? 30_000 }, weather: { enabled: false },
        presentation: { default: "summary", overrides: Object.fromEntries((options.hiddenTools ?? []).map((name) => [name, "hidden"])) },
      },
    };
    await writeFile(join(cwd, ".pi-muse/config.json"), JSON.stringify(config), { mode: 0o600 });
    const process = spawn(globalThis.process.execPath, [builtServiceEntry], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child = process;
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); };
    process.stdout!.on("data", append); process.stderr!.on("data", append);
    let result: Exit | undefined;
    let spawnError: Error | undefined;
    exit = new Promise<Exit>((resolve) => {
      process.once("error", (error) => { spawnError = error; resolve({ code: -1, signal: null }); });
      process.once("exit", (code, signal) => { result = { code, signal }; resolve(result); });
    });
    try {
      const deadline = Date.now() + 25_000;
      while (!output.includes("pi-muse listening")) {
        if (spawnError || result) throw new Error(`service failed to start: ${output || spawnError?.message}`);
        if (Date.now() >= deadline) throw new Error(`service startup timed out: ${output}`);
        await sleep(25);
      }
      const response = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.equal(health.ok, true); assert.equal(health.serviceVersion.mode, "build");
    } catch (error) {
      // 原始启动错误优先，但仍必须等待本次子进程回收。
      await stop().catch(() => undefined);
      throw error;
    }
  };
  try {
    cwd = await mkdtemp(join(tmpdir(), "pi-muse-e2e-"));
    await mkdir(join(cwd, ".pi-muse"), { mode: 0o700 });
    await start();
  } catch (error) { await close().catch(() => undefined); throw error; }
  return {
    get cwd() { return cwd; }, get dataDir() { return join(cwd, ".pi-muse"); }, get baseUrl() { return baseUrl; }, accessKey,
    start, stop, restart: async () => { await stop(); await start(); }, crash, close,
  };
};
