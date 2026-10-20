import type { MemoryRepository } from "../memory/types.js";
import type { Identity } from "./types.js";

/** SOUL/USER 自由文本的读写 port；实现由 storage adapter 注入，feature 不碰 fs。 */
type ProfileFiles = {
  read: (which: "soul" | "user") => Promise<string>;
  write: (which: "soul" | "user", content: string, expected?: string) => Promise<boolean | void>;
};

/**
 * 身份设置入口不读取 SOUL/USER 文件，也不自行创建 writer。
 * 两个 feature 接受同一个 memory repository，patch 只改变 identity 字段。
 * SOUL/USER 自由文本经注入的 profileFiles 读写（下一轮 prompt 注入即生效）。
 */
/** port 缺省时读为空串；port 自身的读取失败必须向上暴露，不得伪装成空内容。 */
const readProfile = async (files: ProfileFiles | undefined, which: "soul" | "user") =>
  (await files?.read(which)) ?? "";

export const createIdentityService = (
  repository: MemoryRepository,
  profileFiles?: ProfileFiles,
) => ({
  get: async (): Promise<Identity> => (await repository.read()).identity,
  save: (patch: Partial<Identity>): Promise<Identity> =>
    repository.update((state) => {
      const identity = { ...state.identity, ...patch };
      return { state: { ...state, identity }, result: identity };
    }),
  getProfile: async (): Promise<{ soul: string; user: string }> => ({
    soul: await readProfile(profileFiles, "soul"),
    user: await readProfile(profileFiles, "user"),
  }),
  saveProfile: async (patch: {
    soul?: string;
    user?: string;
  }): Promise<{ soul: string; user: string }> => {
    if (patch.soul !== undefined) await profileFiles?.write("soul", patch.soul);
    if (patch.user !== undefined) await profileFiles?.write("user", patch.user);
    return {
      soul: await readProfile(profileFiles, "soul"),
      user: await readProfile(profileFiles, "user"),
    };
  },
  /** Dream 复用同一 profileFiles 入口按读取版本条件写入，冲突时不覆盖用户改动。 */
  writeIfUnchanged: async (
    which: "soul" | "user",
    content: string,
    expected: string,
  ): Promise<boolean> => {
    if (!profileFiles) return false;
    return (await profileFiles.write(which, content, expected)) !== false;
  },
});

export type IdentityService = ReturnType<typeof createIdentityService>;
