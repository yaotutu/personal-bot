/**
 * 技能存储 Port：定义技能业务域需要的存储操作接口。
 * 由 adapter 层实现，bootstrap 显式注入。
 */
export type SkillMeta = {
  name: string;
  description: string;
  defaultEnabled: boolean;
  path: string;
  isBuiltin: boolean;
};

export type SkillDiagnostic = { path: string; message: string };
export type SkillCatalog = { skills: SkillMeta[]; diagnostics: SkillDiagnostic[] };

export type SkillRepository = {
  listSkills(): Promise<SkillCatalog>;
  getSpaceOverrides(spaceId: string): Promise<Record<string, boolean>>;
  setSpaceOverrides(spaceId: string, overrides: Record<string, boolean>): Promise<void>;
  getThreadOverrides(threadId: string): Promise<Record<string, boolean>>;
  setThreadOverrides(threadId: string, overrides: Record<string, boolean>): Promise<void>;
};
