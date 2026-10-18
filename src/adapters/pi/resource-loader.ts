import { createExtensionRuntime, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";

/** 显式资源隔离，不发现个人 CLI 的 skills、extensions 或父目录配置。 */
export const createResourceLoader = (
  systemPrompt: string,
  skills: Skill[] = [],
  extensionResult?: ReturnType<ResourceLoader["getExtensions"]>,
): ResourceLoader => ({
  getExtensions: () =>
    extensionResult
      ? {
          extensions: extensionResult.extensions,
          errors: extensionResult.errors,
          runtime: extensionResult.runtime,
        }
      : {
          extensions: [],
          errors: [],
          runtime: createExtensionRuntime(),
        },
  getSkills: () => ({ skills, diagnostics: [] }),
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
