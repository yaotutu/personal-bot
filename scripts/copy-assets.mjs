import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "assets");
const destination = process.argv[2] ? resolve(process.argv[2]) : resolve(projectRoot, "dist/assets");

// 只替换构建生成的资源子树，避免重复构建嵌套和已经移除的内置技能残留；不删除整个 dist。
if (destination === source || source.startsWith(destination + "/")) throw new Error("Refusing to replace source assets");
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
