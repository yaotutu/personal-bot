import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { DataLayout } from "./data-layout.js";
import { threadSkillsFile } from "./data-layout.js";
import { getBuiltinSkillsDir } from "./builtin-skills.js";
import { writeJsonDocument } from "./json-document.js";
import { InvalidDocumentError } from "./document-schemas.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { isSpaceId } from "../../features/conversation/space-id.js";
import type { SkillCatalog, SkillRepository } from "../../features/skills/port.js";

const overridesSchema = z.strictObject({ overrides: z.record(z.string(), z.boolean()) });
const configSchema = z.strictObject({ defaultEnabled: z.boolean() });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * 技能诊断信息里的 path 字段只描述逻辑位置（builtin/<skill> 或 user/<skill>[/子路径]），
 * 不暴露 DATA_DIR 真实目录。SkillMeta.path 仍保留物理路径供内部使用，不做转换。
 */
const skillLogicalPath = (name: string, isBuiltin: boolean, sub?: string): string => {
  const root = isBuiltin ? "builtin" : "user";
  return sub ? `${root}/${name}/${sub}` : `${root}/${name}`;
};

/** 元数据解析只走 pi；单项加载失败可见但不阻断其他技能，坏配置不修改原件。 */
const scanSkillsDir = async (dir: string, isBuiltin: boolean): Promise<SkillCatalog> => {
  const result: SkillCatalog = { skills: [], diagnostics: [] };
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (!missing(error))
      result.diagnostics.push({ path: isBuiltin ? "builtin" : "user", message: "Cannot read skills directory" });
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const file = join(path, "SKILL.md");
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error("Linked skill");
      const loaded = loadSkillsFromDir({ dir: path, source: "project" });
      const skillLogical = skillLogicalPath(entry.name, isBuiltin);
      result.diagnostics.push(...loaded.diagnostics.map((diagnostic) => ({
        path: skillLogical,
        message: diagnostic.message,
      })));
      const skill = loaded.skills.find((candidate) => candidate.filePath === file && candidate.name === entry.name);
      if (!skill) {
        result.diagnostics.push({ path: skillLogical, message: "Skill name must match its directory and include a valid description" });
        continue;
      }
      let defaultEnabled = isBuiltin;
      if (!isBuiltin) {
        const configLogical = skillLogicalPath(entry.name, isBuiltin, "config.json");
        try {
          let source: string;
          try { source = await readFile(join(path, "config.json"), "utf8"); }
          catch (error) {
            if (!missing(error)) throw error;
            await writeFile(join(path, "config.json"), JSON.stringify({ defaultEnabled: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            source = await readFile(join(path, "config.json"), "utf8");
            result.diagnostics.push({ path: configLogical, message: "Missing default configuration created with defaultEnabled=false" });
          }
          defaultEnabled = configSchema.parse(JSON.parse(source)).defaultEnabled;
        } catch {
          result.diagnostics.push({ path: configLogical, message: "Invalid or unreadable skill configuration; original file preserved and skill unavailable" });
          continue;
        }
      }
      result.skills.push({ name: skill.name, description: skill.description, defaultEnabled, path, isBuiltin });
    } catch {
      result.diagnostics.push({ path: skillLogicalPath(entry.name, isBuiltin), message: "Cannot load skill file" });
    }
  }
  return result;
};

const readOverrides = async (file: string): Promise<Record<string, boolean>> => {
  let source: string;
  try { source = await readFile(file, "utf8"); }
  catch (error) { if (missing(error)) return {}; throw error; }
  try { return overridesSchema.parse(JSON.parse(source)).overrides; }
  catch { throw new InvalidDocumentError("skills-overrides"); }
};

/** 同一 repository 唯一队列覆盖读取/校验/写入，沿用项目统一的 wx/0600/rename writer。 */
export const createSkillRepository = (layout: DataLayout): SkillRepository => {
  const builtinDir = getBuiltinSkillsDir();
  const serialized = createSerializedWriter();
  const fileFor = (spaceId: string) => {
    if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId");
    return threadSkillsFile(layout, spaceId);
  };
  return {
    listSkills: () => serialized(async () => {
      const builtin = await scanSkillsDir(builtinDir, true);
      const user = await scanSkillsDir(layout.skillsDir, false);
      const merged = new Map(builtin.skills.map((skill) => [skill.name, skill]));
      for (const skill of user.skills) merged.set(skill.name, skill);
      return { skills: [...merged.values()], diagnostics: [...builtin.diagnostics, ...user.diagnostics] };
    }),
    getSpaceOverrides: (spaceId) => serialized(() => readOverrides(fileFor(spaceId))),
    setSpaceOverrides: (spaceId, overrides) => serialized(async () => {
      const file = fileFor(spaceId);
      await readOverrides(file);
      const document = overridesSchema.parse({ overrides });
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeJsonDocument(file, document);
    }),
    getThreadOverrides: (threadId: string) => serialized(() => readOverrides(fileFor(threadId))),
    setThreadOverrides: (threadId: string, overrides: Record<string, boolean>) => serialized(async () => {
      const file = fileFor(threadId);
      await readOverrides(file);
      const document = overridesSchema.parse({ overrides });
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeJsonDocument(file, document);
    }),
  };
};
