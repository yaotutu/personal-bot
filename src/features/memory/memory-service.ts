import { randomUUID } from "node:crypto";
import { renderMemoryPrompt } from "./memory-prompt.js";
import type { MemoryItem, MemoryRepository } from "./types.js";

/**
 * 记忆业务层只处理条目规则和 prompt 渲染；文件格式与串行写入由 repository 负责。
 * 身份有独立的业务入口，但通过组合入口注入的同一个 repository 保存。
 */
export const createMemoryService = (repository: MemoryRepository) => {
  const now = () => new Date().toISOString();

  return {
    list: async () => (await repository.read()).memories,
    add: (text: string, source: string): Promise<MemoryItem> =>
      repository.update((state) => {
        const item: MemoryItem = {
          id: randomUUID(),
          text: text.trim(),
          source,
          createdAt: now(),
          updatedAt: now(),
        };
        return {
          state: {
            ...state,
            // 上限 500 条仍在业务层，避免存储 adapter 了解产品规则。
            memories: [...state.memories, item].slice(-500),
          },
          result: item,
        };
      }),
    edit: (id: string, text: string): Promise<MemoryItem | undefined> =>
      repository.update((state) => {
        const found = state.memories.find((item) => item.id === id);
        if (!found) return { result: undefined };
        const edited = { ...found, text: text.trim(), updatedAt: now() };
        return {
          state: {
            ...state,
            memories: state.memories.map((item) =>
              item === found ? edited : item,
            ),
          },
          result: edited,
        };
      }),
    forget: (id: string): Promise<boolean> =>
      repository.update((state) => {
        const memories = state.memories.filter((item) => item.id !== id);
        // 保留旧行为：即使没有命中也写回文档。读取/错误策略加固留给 R7A。
        return {
          state: { ...state, memories },
          result: memories.length < state.memories.length,
        };
      }),
    renderForPrompt: async () => renderMemoryPrompt(await repository.read()),
  };
};

export type MemoryService = ReturnType<typeof createMemoryService>;
