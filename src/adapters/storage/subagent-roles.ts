import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getBuiltinSkillsDir } from "./builtin-skills.js";
import type { SubagentRole } from "../pi/subagent/extension.js";

/** 仅从内置资产和受保护 DATA_DIR 读角色；后者可显式覆盖同名角色，但不能扩大父工具权限。 */
export const loadSubagentRoles = async (userDirectory: string): Promise<SubagentRole[]> => {
  const roles = new Map<string, SubagentRole>();
  for (const directory of [join(dirname(getBuiltinSkillsDir()), "subagents"), userDirectory]) {
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Invalid subagent directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === userDirectory) continue;
      throw error;
    }
    for (const name of (await readdir(directory)).filter((name) => name.endsWith(".md")).sort()) {
      const file = join(directory, name);
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid subagent definition");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await readFile(file, "utf8"));
      const tools = typeof frontmatter.tools === "string" ? frontmatter.tools.split(",").map((tool) => tool.trim()) : frontmatter.tools;
      if (typeof frontmatter.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(frontmatter.name) ||
        typeof frontmatter.description !== "string" || !frontmatter.description.trim() || !body.trim() ||
        frontmatter.model !== undefined ||
        (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string" && /^[a-zA-Z][\w-]*$/.test(tool))))) {
        throw new Error("Invalid subagent definition; roles must inherit the service model");
      }
      roles.set(frontmatter.name, { name: frontmatter.name, description: frontmatter.description.trim(), systemPrompt: body.trim(), tools: tools as string[] | undefined });
    }
  }
  return [...roles.values()];
};
