import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** 显式资源隔离，不发现个人 CLI 的 skills、extensions 或父目录配置。 */
export const createResourceLoader = (systemPrompt: string): ResourceLoader => ({
  getExtensions: () => ({
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});
