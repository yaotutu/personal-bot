import type { MemoryRepository } from "../memory/types.js";
import type { Identity } from "./types.js";

/**
 * 身份设置入口不读取 SOUL/USER 文件，也不自行创建 writer。
 * 两个 feature 接受同一个 memory repository，patch 只改变 identity 字段。
 */
export const createIdentityService = (repository: MemoryRepository) => ({
  get: async (): Promise<Identity> => (await repository.read()).identity,
  save: (patch: Partial<Identity>): Promise<Identity> =>
    repository.update((state) => {
      const identity = { ...state.identity, ...patch };
      return { state: { ...state, identity }, result: identity };
    }),
});

export type IdentityService = ReturnType<typeof createIdentityService>;
