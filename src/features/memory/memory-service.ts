import { randomUUID } from "node:crypto";
import { renderMemoryPrompt, type MemoryPromptOptions } from "./memory-prompt.js";
import type { MemoryItem, MemoryRepository } from "./types.js";

/** 记忆条数上限。写满后拒绝新增，由用户或 Dream 先合并/删除旧条目，绝不静默丢弃最老的一条。 */
export const MEMORY_LIMIT = 500;
/** 单次检索最多返回的条数，防止一次检索把沉淀库整体灌回上下文。 */
export const MEMORY_SEARCH_MAX = 10;

export class MemoryLimitError extends Error {
  constructor() {
    super(`Memory limit reached (${MEMORY_LIMIT}); remove or merge existing items first`);
    this.name = "MemoryLimitError";
  }
}

/**
 * 记忆业务层只处理条目规则和 prompt 渲染；文件格式与串行写入由 repository 负责。
 * 身份有独立的业务入口，但通过组合入口注入的同一个 repository 保存。
 */
export const createMemoryService = (repository: MemoryRepository) => {
  const now = () => new Date().toISOString();

  return {
    list: async () => (await repository.read()).memories,
    get: async (id: string): Promise<MemoryItem | undefined> =>
      (await repository.read()).memories.find((item) => item.id === id),
    /** 按关键词子串（忽略大小写）检索，最近更新优先；记忆不再全量进入每轮上下文，靠它按需取用。 */
    search: async (query: string, limit = MEMORY_SEARCH_MAX): Promise<MemoryItem[]> => {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const size = Math.max(1, Math.min(MEMORY_SEARCH_MAX, Math.floor(limit)));
      return (await repository.read()).memories
        .filter((item) => item.text.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, size);
    },
    /**
     * 自动召回：针对当前用户输入关键词提取并匹配相关记忆，最多返回 limit 条（默认 3 条），
     * 用于对话开始前作为记忆线索注入提示词，避免必须等待模型主动调用 memory_search。
     */
    recall: async (query: string, limit = 3): Promise<MemoryItem[]> => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const { memories } = await repository.read();
      if (memories.length === 0) return [];

      const terms = new Set<string>();
      const words = q.match(/[a-z0-9_]{2,}/gi) ?? [];
      for (const w of words) terms.add(w.toLowerCase());
      const cjkMatches = q.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) ?? [];
      for (const cjk of cjkMatches) {
        terms.add(cjk);
        if (cjk.length > 2) {
          for (let i = 0; i <= cjk.length - 2; i++) {
            terms.add(cjk.slice(i, i + 2));
          }
        }
      }

      if (terms.size === 0) {
        if (q.length >= 2) terms.add(q);
        else return [];
      }

      const scored: Array<{ item: MemoryItem; score: number }> = [];
      for (const item of memories) {
        const text = item.text.toLowerCase();
        let score = 0;
        if (text.includes(q)) score += 10;
        for (const term of terms) {
          if (text.includes(term)) score += term.length >= 4 ? 4 : 2;
        }
        if (score > 0) scored.push({ item, score });
      }
      scored.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
      const size = Math.max(1, Math.min(5, Math.floor(limit)));
      return scored.slice(0, size).map((s) => s.item);
    },
    add: (text: string, source: string): Promise<MemoryItem> =>
      repository.update((state) => {
        if (state.memories.length >= MEMORY_LIMIT) throw new MemoryLimitError();
        const item: MemoryItem = {
          id: randomUUID(),
          text: text.trim(),
          source,
          createdAt: now(),
          updatedAt: now(),
        };
        return {
          state: { ...state, memories: [...state.memories, item] },
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
        // 未命中不写回文件，避免无变化的写入触发通知或覆盖并发修改。
        if (memories.length === state.memories.length) return { result: false };
        return { state: { ...state, memories }, result: true };
      }),
    renderForPrompt: async (options?: MemoryPromptOptions) =>
      renderMemoryPrompt(await repository.read(), options),
  };
};

export type MemoryService = ReturnType<typeof createMemoryService>;
