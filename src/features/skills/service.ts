import type { SkillRepository } from "./port.js";

export class UnknownSkillError extends Error {}

/** 会话只保存覆盖；目录扫描与文件写入由注入的 repository 承担。 */
export const createSkillsService = (repository: SkillRepository) => {
  const describeThread = async (threadId: string) => {
    const { skills, diagnostics } = await repository.listSkills();
    const overrides = await repository.getThreadOverrides(threadId);
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        defaultEnabled: skill.defaultEnabled,
        enabled: overrides[skill.name] ?? skill.defaultEnabled,
      })),
      diagnostics,
    };
  };
  return {
    describeThread,
    getEffectiveSkills: async (threadId: string) => (await describeThread(threadId)).skills,
    /** 整份替换覆盖表自然移除旧引用；拒绝本次请求中的未知名称，不静默吞掉用户输入。 */
    updateThreadOverrides: async (threadId: string, overrides: Record<string, boolean>) => {
      const { skills } = await repository.listSkills();
      const validNames = new Set(skills.map((skill) => skill.name));
      const unknown = Object.keys(overrides).find((name) => !validNames.has(name));
      if (unknown) throw new UnknownSkillError(`Unknown skill name: ${unknown}`);
      await repository.setThreadOverrides(threadId, overrides);
    },
  };
};

export type SkillsService = ReturnType<typeof createSkillsService>;
