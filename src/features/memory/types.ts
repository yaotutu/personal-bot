import type { Identity } from "../identity/types.js";

export type MemoryItem = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

/** memory.json 的完整业务形状；磁盘上仍保持原来的对象结构。 */
export type MemoryState = {
  memories: MemoryItem[];
  identity: Identity;
};

export type MemoryRepository = {
  read: () => Promise<MemoryState>;
  /**
   * 在 repository 自己的串行队列中执行一次完整读改写。
   * 未返回 state 表示此次只读/未命中，不应触碰磁盘文件。
   */
  update: <T>(
    change: (state: MemoryState) => { state?: MemoryState; result: T },
  ) => Promise<T>;
};
