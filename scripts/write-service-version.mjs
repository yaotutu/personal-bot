// 构建期写入 dist/service-version.json。
// 复用 src/bootstrap/service-version.ts 的 collectServiceVersion（含真实 git + 源码 hash），
// 不读取 .pi-muse、不依赖 cwd，输出路径由 argv 指定（默认 dist/service-version.json）。
// 写盘走原子替换（temp + rename），失败清理临时文件并保留原错误。

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const moduleUrl = pathToFileURL(resolve(projectRoot, "src", "bootstrap", "service-version.ts")).href;
const { collectServiceVersion } = await import(moduleUrl);
if (typeof collectServiceVersion !== "function") throw new Error("collectServiceVersion missing");

const snapshot = await collectServiceVersion(moduleUrl, "build");
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(projectRoot, "dist", "service-version.json");
const tempFile = `${target}.tmp-${process.pid}-${Date.now()}`;
await mkdir(dirname(target), { recursive: true });
try {
  await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
  await rename(tempFile, target);
} catch (error) {
  try { await rm(tempFile, { force: true }); } catch { /* 清理失败不掩盖主错误 */ }
  throw error;
}
console.log(`service-version written: ${target} (version=${snapshot.version}, commit=${snapshot.commit ?? "null"}, dirty=${String(snapshot.dirty)}, sourceHash=${snapshot.sourceHash.slice(0, 12)}…)`);