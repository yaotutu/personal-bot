import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillsService } from "../../../features/skills/service.js";
import type { DataLayout } from "../../storage/data-layout.js";
import { safeWorkspacePath } from "./workspace-path.js";
import {
  awaitFileApproval,
  commitApprovedFile,
  deniedResult,
  MAX_TEXT_FILE_BYTES,
  readFileSnapshot,
  type ActivityApprovalObservation,
  type ApprovalActions,
  type ApprovalContext,
} from "./file-approval.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".yaml", ".yml"]);
const TEXT_RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SkillsToolDependencies = {
  layout: DataLayout;
  skills: SkillsService;
  actions: ApprovalActions;
  timeoutMs: number;
  saveEnabled: boolean;
  spaceId?: string;
  runId?: string;
  observation?: ActivityApprovalObservation;
};

const validUnicodeText = (content: string) => {
  try {
    encodeURIComponent(content);
    return !content.includes("\0");
  } catch {
    return false;
  }
};

const validSkillName = (name: string) =>
  name.length <= 64 && SKILL_NAME_PATTERN.test(name);

const validSkillFile = (file: string) => {
  if (file === "SKILL.md") return true;
  const parts = file.split("/");
  if (parts.length < 2 || (parts[0] !== "references" && parts[0] !== "assets")) return false;
  if (parts.slice(1).includes("SKILL.md")) return false;
  if (!parts.every((part) => TEXT_RESOURCE_SEGMENT.test(part) && part !== "." && part !== "..")) return false;
  const extension = parts.at(-1)!.slice(parts.at(-1)!.lastIndexOf("."));
  return TEXT_EXTENSIONS.has(extension);
};

const resolveSkillTarget = async (skillDir: string, file: string, boundaryDir: string) => {
  const target = join(skillDir, ...file.split("/"));
  return safeWorkspacePath(skillDir, target, { allowMissing: true, boundaryDir });
};

/** SKILL.md 继续交给已安装 pi SDK 解析；宿主只做临时 staging，不实现第二套 YAML 规则。 */
const validateSkillDocument = async (name: string, content: string) => {
  // pi 允许缺省 name 时回退目录名；先读取 SDK 解析结果，正文中的 name 行不能冒充元数据。
  try {
    const { frontmatter } = parseFrontmatter(content);
    if (frontmatter.name !== name) return false;
  } catch {
    return false;
  }
  const staging = await mkdtemp(join(tmpdir(), "pi-muse-skill-"));
  try {
    const directory = join(staging, name);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "SKILL.md"), content, { flag: "wx", mode: 0o600 });
    const loaded = loadSkillsFromDir({ dir: directory, source: "project" });
    const skill = loaded.skills.find((candidate) => candidate.name === name && candidate.filePath === join(directory, "SKILL.md"));
    return Boolean(skill) && loaded.diagnostics.length === 0;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

const readTargetText = async (target: string) => {
  const snapshot = await readFileSnapshot(target, MAX_TEXT_FILE_BYTES);
  if (!snapshot || !validUnicodeText(snapshot.content)) throw new Error("Unsupported skill file");
  return snapshot;
};

const validExistingSkillConfig = async (skillDir: string, boundaryDir: string) => {
  const config = await safeWorkspacePath(skillDir, join(skillDir, "config.json"), { allowMissing: true, boundaryDir });
  const snapshot = await readFileSnapshot(config, MAX_TEXT_FILE_BYTES);
  if (!snapshot) return true;
  const parsed: unknown = JSON.parse(snapshot.content);
  return typeof (parsed as { defaultEnabled?: unknown }).defaultEnabled === "boolean" &&
    Object.keys(parsed as Record<string, unknown>).length === 1;
};

export const createSkillsTool = ({
  layout,
  skills,
  actions,
  timeoutMs,
  saveEnabled,
  spaceId,
  runId,
  observation,
}: SkillsToolDependencies) => defineTool({
  name: "skills",
  label: "Manage skills",
  description:
    "List, read, or save Pi Muse skills for the current space. list returns effective state and source without physical paths. read accepts SKILL.md or supported text files under references/ or assets/. save writes an instance-level file after explicit human approval; a saved or overridden skill is loaded on the next model turn. Existing built-in skills are never modified. Use save only on an explicit user request.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("save")]),
    name: Type.Optional(Type.String({
      maxLength: 64,
      description: "Skill directory name: lowercase letters, digits, and single hyphens. Required for read and save.",
    })),
    file: Type.Optional(Type.String({
      description: "Skill-relative file. Defaults to SKILL.md; otherwise references/... or assets/... with a supported UTF-8 text extension (.md, .txt, .json, .csv, .yaml, .yml).",
    })),
    content: Type.Optional(Type.String({
      description: "Required for save: the complete replacement content of one file, max 100KB.",
    })),
  }, { additionalProperties: false }),
  async execute(_id, params, signal) {
    if (params.action === "list") {
      if (!spaceId) return deniedResult("Skills are unavailable without a space context.");
      const view = await skills.describeAuthoring(spaceId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }],
        details: { denied: false },
      };
    }

    const name = params.name ?? "";
    const file = params.file?.trim() || "SKILL.md";
    if (!validSkillName(name)) return deniedResult("Invalid skill name.");
    if (!validSkillFile(file)) return deniedResult("Invalid or unsupported skill file.");

    if (params.action === "read") {
      const skill = await skills.findSkill(name);
      if (!skill) return deniedResult("Skill not found.");
      try {
        const target = await resolveSkillTarget(skill.path, file, dirname(skill.path));
        const snapshot = await readTargetText(target);
        const enabled = spaceId
          ? (await skills.describeAuthoring(spaceId)).skills.find((skill) => skill.name === name)?.enabled ?? false
          : false;
        return {
          content: [{ type: "text" as const, text: snapshot.content }],
          details: { denied: false, name, file, source: skill.isBuiltin ? "builtin" : "user", enabled },
        };
      } catch {
        return deniedResult("Skill file not found or unsafe.");
      }
    }

    if (!saveEnabled) return deniedResult("Skill saving is disabled by tools.writable.enabled; list and read remain available.");
    if (params.content === undefined) return deniedResult("Save requires complete content.");
    const content = params.content;
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES)
      return deniedResult("File too large: skill files are limited to 100KB.");
    if (!validUnicodeText(content)) return deniedResult("Skill files must be valid UTF-8 text without NUL bytes.");
    if (file === "SKILL.md" && !await validateSkillDocument(name, content))
      return deniedResult("SKILL.md must parse with pi and its frontmatter name must match the skill name.");

    if (file !== "SKILL.md") {
      const existing = await skills.findSkill(name);
      if (!existing || existing.isBuiltin || existing.path !== join(layout.skillsDir, name))
        return deniedResult("Save SKILL.md as an instance override before saving skill resources.");
    }

    if (file === "SKILL.md") {
      try {
        if (!await validExistingSkillConfig(join(layout.skillsDir, name), layout.root)) throw new Error("Invalid config");
      } catch {
        return deniedResult("Skill config is invalid; restore it before saving SKILL.md.");
      }
    }

    const skillDir = join(layout.skillsDir, name);
    let target: string;
    let original;
    try {
      target = await resolveSkillTarget(skillDir, file, layout.root);
      original = await readFileSnapshot(target, MAX_TEXT_FILE_BYTES);
      if (original && !validUnicodeText(original.content)) throw new Error("Unsupported existing file");
    } catch {
      return deniedResult("Access denied: unsafe or unreadable skill path.");
    }

    const approved = await awaitFileApproval(
      actions,
      original ? "file_edit" : "file_write",
      `保存技能 ${name}/${file}`,
      {
        resourceScope: "skill",
        path: `${name}/${file}`,
        content,
        originalContent: original?.content ?? "",
        baseVersion: original?.version ?? "missing",
        beforeExists: String(original !== undefined),
      },
      timeoutMs,
      signal,
      { spaceId, runId, toolCallId: _id, workspaceSpaceId: null } satisfies ApprovalContext,
      observation ? (event) => observation.observe({
        ...event,
        id: `${observation.prefix}:${event.id}`,
        parentId: `${observation.prefix}:tool:${_id}`,
      }) : undefined,
    );
    if (!approved) return deniedResult("Skill save not approved (denied, expired or cancelled); nothing was written.");

    return commitApprovedFile({
      target,
      successPath: `${name}/${file}`,
      original,
      content,
      approval: approved,
      actions,
      signal,
      validateTarget: async (candidate) => {
        if (await resolveSkillTarget(skillDir, file, layout.root) !== candidate) return false;
        if (file === "SKILL.md") return true;
        const existing = await skills.findSkill(name);
        return Boolean(existing && !existing.isBuiltin && existing.path === skillDir);
      },
      afterCommit: async () => {
        if (file !== "SKILL.md") return;
        const config = join(skillDir, "config.json");
        try {
          await writeFile(config, JSON.stringify({ defaultEnabled: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
            !await validExistingSkillConfig(skillDir, layout.root)) throw error;
        }
      },
    }).then(async (result) => {
      if ((result as { isError?: boolean }).isError === true) return result;
      const saved = (await skills.findSkill(name))?.defaultEnabled ?? false;
      const enabledInSpace = spaceId
        ? (await skills.describeAuthoring(spaceId)).skills.find((skill) => skill.name === name)?.enabled ?? false
        : false;
      return {
        ...result,
        details: { denied: false },
        content: [{
          type: "text" as const,
          text: `Saved user skill ${name}/${file}; defaultEnabled=${saved}; enabledInCurrentSpace=${enabledInSpace}; it loads on the next model turn.`,
        }],
      };
    });
  },
});
