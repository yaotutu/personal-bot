import { isThreadId } from "./validate-input.js";
import type { Conversation } from "./conversation-service.js";
import { rejectConversation } from "./errors.js";

type ThreadSnapshot = { id: string; updatedAt: string };
export type ConversationHub = {
  forThread: (threadId: string) => Promise<Conversation>;
  /** 只打开已有会话；不存在或正在删除时不创建目录。 */
  findThread: (threadId: string) => Promise<Conversation | undefined>;
  /** 后台执行期间保留来源引用，防止空闲缓存回收；删除仍可关闭它。 */
  retainThread: (threadId: string) => Promise<{ conversation: Conversation; release: () => void } | undefined>;
  threads: () => Promise<ThreadSnapshot[]>;
  /** 来源绑定、规则/技能保存与删除共享短生命周期锁，不覆盖模型执行。 */
  withThread: <T>(threadId: string, change: (conversation: Conversation) => Promise<T>) => Promise<T>;
  deleteThread: <T>(threadId: string, remove: () => Promise<T>) => Promise<T>;
  /** 内部任务结束后释放缓存；历史仍由 pi JSONL 保留。 */
  release: (threadId: string) => Promise<void>;
  closeAll: () => Promise<void>;
};

/**
 * 每个 thread 只创建一份协调器，Promise 缓存同时覆盖异步初始化阶段。
 * 短操作串行化只负责创建/来源绑定/删除；删除先关门再等待旧操作与模型取消，
 * 因此迟到的读和通知不能借惰性初始化重新创建目录。模型仍只由 conversation 加锁。
 */
export const createConversationHub = (
  create: (threadId: string) => Promise<Conversation>,
  listThreads: () => Promise<ThreadSnapshot[]>,
): ConversationHub => {
  type Cached = { promise: Promise<Conversation>; value?: Conversation; touchedAt: number; pins: number };
  const cache = new Map<string, Cached>();
  const operations = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const validateId = (id: string) => {
    if (!isThreadId(id)) rejectConversation("UNSUPPORTED_THREAD", "Invalid threadId");
    if (closed) rejectConversation("SHUTDOWN", "Service is closing");
  };
  const writable = (id: string) => {
    validateId(id);
    if (deleting.has(id)) rejectConversation("THREAD_DELETING", "Thread is being deleted");
  };
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const result = (operations.get(id) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    operations.set(id, tail);
    void tail.then(() => { if (operations.get(id) === tail) operations.delete(id); });
    return result;
  };
  const release = async (id: string) => {
    if (operations.has(id) || deleting.has(id)) return;
    const entry = cache.get(id);
    if (!entry?.value || entry.pins || entry.value.isRunning()) return;
    cache.delete(id);
    await entry.value.close();
  };
  const open = (id: string) => {
    if (cache.size >= 32) {
      for (const [other, entry] of cache) {
        if (other !== "local-main" && other !== id && Date.now() - entry.touchedAt >= 300_000)
          void release(other).catch(() => undefined);
      }
    }
    let entry = cache.get(id);
    if (!entry) {
      entry = { promise: Promise.resolve().then(() => create(id)), touchedAt: Date.now(), pins: 0 };
      cache.set(id, entry);
      const owned = entry;
      entry.promise.then((value) => { owned.value = value; }, () => {
        if (cache.get(id) === owned) cache.delete(id);
      });
    }
    entry.touchedAt = Date.now();
    return entry.promise;
  };
  const find = async (id: string) => {
    if (deleting.has(id)) return undefined;
    if (!cache.has(id) && !(await listThreads()).some((thread) => thread.id === id)) return undefined;
    if (deleting.has(id)) return undefined;
    return open(id);
  };
  return {
    forThread(id) {
      writable(id);
      return serial(id, () => {
        if (deleting.has(id)) rejectConversation("THREAD_DELETING", "Thread is being deleted");
        return open(id);
      });
    },
    findThread(id) {
      validateId(id);
      if (deleting.has(id)) return Promise.resolve(undefined);
      return serial(id, () => find(id));
    },
    retainThread(id) {
      validateId(id);
      if (deleting.has(id)) return Promise.resolve(undefined);
      return serial(id, async () => {
        const conversation = await find(id);
        if (!conversation) return undefined;
        const entry = cache.get(id)!;
        entry.pins++;
        let released = false;
        return { conversation, release: () => {
          if (!released) { released = true; entry.pins--; entry.touchedAt = Date.now(); }
        } };
      });
    },
    withThread(id, change) {
      writable(id);
      return serial(id, async () => {
        if (deleting.has(id)) rejectConversation("THREAD_DELETING", "Thread is being deleted");
        return change(await open(id));
      });
    },
    deleteThread(id, remove) {
      writable(id);
      // 同步关门：不能只把删除排到队尾，否则新来源绑定会插到清理之后。
      deleting.add(id);
      return serial(id, async () => {
        const entry = cache.get(id);
        cache.delete(id);
        if (entry) {
          // close 同步关闭 notify/run 入口，再取消在途轮；旧引用永远不指向新同名会话。
          const conversation = await entry.promise;
          await conversation.close();
        }
        return remove();
      }).finally(() => { deleting.delete(id); });
    },
    threads: listThreads,
    release,
    closeAll: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...operations.values()]);
        const created = await Promise.allSettled([...cache.values()].map((entry) => entry.promise));
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
