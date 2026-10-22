import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { builtServiceEntry } from "../support/service-process.js";

for (const failure of ["invalid-config", "corrupt-document", "occupied-port", "illegal-job-schedule"] as const) {
  test(`e2e: built entry ${failure} fails naturally without leaked processes or overwritten documents`, { timeout: 40_000 }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-muse-e2e-failure-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const directory = join(cwd, ".pi-muse");
    await mkdir(directory, { mode: 0o700 });
    const portHolder = createServer();
    portHolder.listen(0, "127.0.0.1"); await once(portHolder, "listening");
    t.after(async () => { if (portHolder.listening) await new Promise<void>((resolve) => portHolder.close(() => resolve())); });
    const address = portHolder.address(); assert.ok(address && typeof address !== "string");
    const config = { server: { host: "127.0.0.1", port: address.port, accessKey: "failure-fixture" }, runtime: { dataDir: "." } };
    await writeFile(join(directory, "config.json"), failure === "invalid-config" ? "{invalid-json" : JSON.stringify(config), { mode: 0o600 });
    const corrupt = "{invalid-monitors-must-survive";
    if (failure === "corrupt-document") await writeFile(join(directory, "monitors.json"), corrupt);
    const illegalJobRecord = JSON.stringify([
      {
        id: "illegal-schedule-job",
        prompt: "test invalid daily at",
        daily: true,
        at: "24:00",
        enabled: false,
        createdAt: "2026-10-22T00:00:00.000Z",
        nextRunAt: "2026-10-22T00:00:00.000Z",
      },
    ], null, 2) + "\n";
    if (failure === "illegal-job-schedule") await writeFile(join(directory, "jobs.json"), illegalJobRecord);
    const process = spawn(globalThis.process.execPath, [builtServiceEntry], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let forced = false;
    const timer = setTimeout(() => { forced = true; process.kill("SIGKILL"); }, 25_000);
    let output = "";
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); };
    process.stdout.on("data", append); process.stderr.on("data", append);
    let code: number | null; let signal: NodeJS.Signals | null;
    try { [code, signal] = await once(process, "exit") as [number | null, NodeJS.Signals | null]; }
    finally { clearTimeout(timer); if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }
    assert.equal(forced, false, "invalid initialization must not keep scheduler intervals alive");
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.ok(!output.includes("pi-muse listening"));
    if (failure === "invalid-config") assert.match(output, /Invalid JSON/);
    if (failure === "corrupt-document") {
      assert.match(output, /Invalid monitors document/);
      assert.equal(await readFile(join(directory, "monitors.json"), "utf8"), corrupt);
    }
    if (failure === "illegal-job-schedule") {
      // 存储 reader 与领域共用严格每日时间规则，坏记录在读阶段即被拦截，
      // 准确异常是 Invalid jobs document，不是第二种可选错误。
      assert.match(output, /Invalid jobs document/);
      assert.equal(await readFile(join(directory, "jobs.json"), "utf8"), illegalJobRecord);
    }
    if (failure === "occupied-port") assert.match(output, /pi-muse cannot start|Port .* held|already in use/);
  });
}
