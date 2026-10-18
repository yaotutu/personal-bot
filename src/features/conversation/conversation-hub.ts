import { isThreadId } from "./validate-input.js";
import type { Conversation } from "./conversation-service.js";
import { rejectConversation } from "./errors.js";

type ThreadSnapshot = { id: string; updatedAt: string };
export type ConversationHub = {
  forThread: (threadId: string) => Promise<Conversation>;
  threads: () => Promise<ThreadSnapshot[]>;
  hasThread: (threadId: string) => Promise<boolean>;
  /** 内部任务结束后释放缓存；历史仍由 pi JSONL 保留。 */
  release: (threadId: string) => Promise<void>;
  /** 取消指定会话正在运行的轮次并逐出缓存 */
  cancelAndEvict: (threadId: string) => Promise<void>;
  closeAll: () => Promise<void>;
};

/**
 * 每个 thread 只创建一份协调器，Promise 缓存同时覆盖异步初始化阶段。
 * 关闭是永久门闩：先禁止新实例，再等待所有创建成功/失败并分别清理，
 * 不能让某一个坏实例阻止其余会话释放。用户会话只回收至少闲置五分钟的
 * 实例，且永不回收忙碌会话；主会话常驻，任务会话由 worker 主动释放。
 */
export const createConversationHub = (
  create: (threadId: string) => Promise<Conversation>,
  listThreads: () => Promise<ThreadSnapshot[]>,
): ConversationHub => {
  type Cached = { promise: Promise<Conversation>; value?: Conversation; touchedAt: number };
  const cache = new Map<string, Cached>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const release = async (id: string) => {
    const entry = cache.get(id);
    if (!entry?.value || entry.value.isRunning()) return;
    cache.delete(id);
    await entry.value.close();
  };
  const cancelAndEvict = async (id: string) => {
    const entry = cache.get(id);
    if (entry) {
      cache.delete(id);
      try {
        const conv = await entry.promise;
        await conv.cancel("STOPPED");
        await conv.close();
      } catch {
        // ignore
      }
    }
  };
  return {
    forThread(threadId) {
      if (closed) rejectConversation("SHUTDOWN", "Service is closing");
      if (!isThreadId(threadId))
        rejectConversation("UNSUPPORTED_THREAD", "Invalid threadId");
      // 软上限避免刚取出的空闲会话马上被逐出；无定时器、无持久化缓存。
      if (cache.size >= 32) {
        for (const [id, entry] of cache) {
          if (id !== "local-main" && id !== threadId && Date.now() - entry.touchedAt >= 300_000)
            void release(id).catch(() => undefined);
        }
      }
      let entry = cache.get(threadId);
      if (!entry) {
        entry = { promise: Promise.resolve().then(() => create(threadId)), touchedAt: Date.now() };
        cache.set(threadId, entry);
        const owned = entry;
        entry.promise.then((value) => { owned.value = value; }, () => {
          if (cache.get(threadId) === owned) cache.delete(threadId);
        });
      }
      entry.touchedAt = Date.now();
      return entry.promise;
    },
    threads: listThreads,
    hasThread: async (threadId: string) => {
      const all = await listThreads();
      return all.some((t) => t.id === threadId);
    },
    release,
    cancelAndEvict,
    closeAll: () => {
      if (closing) return closing;
      closed = true;
      const pending = [...cache.values()].map((entry) => entry.promise);
      closing = (async () => {
        const created = await Promise.allSettled(pending);
        const disposed = await Promise.allSettled(created.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.close()] : [],
        ));
        cache.clear();
        const failed = disposed.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closing;
    },
  };
};
