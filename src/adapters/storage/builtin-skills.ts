import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

/** tsc 保持 adapters/storage 的层级；资产位置相对模块决定，不依赖启动 cwd 或源码目录存在性。 */
export const getBuiltinSkillsDir = (): string => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const outputRoot = resolve(directory, "../..");
  return basename(outputRoot) === "dist"
    ? resolve(outputRoot, "assets/skills")
    : resolve(directory, "../../../assets/skills");
};
