import { randomUUID } from "node:crypto";
import { isSpaceId } from "./space-id.js";
import type { Conversation } from "./conversation-service.js";
import { rejectConversation } from "./errors.js";

export type SpaceSnapshot = { id: string; sessionId: string; updatedAt: string };
export type SpaceResetHooks = {
  closeCurrent: () => Promise<void>;
  reopen: () => Promise<Conversation>;
};
export type ConversationHub = {
  forSpace: (spaceId: string) => Promise<Conversation>;
  forThread: (spaceId: string) => Promise<Conversation>;
  /** 只打开已有空间；不存在或正在删除时不创建目录。 */
  findSpace: (spaceId: string) => Promise<Conversation | undefined>;
  findThread: (spaceId: string) => Promise<Conversation | undefined>;
  /** 后台执行期间保留来源引用，防止空闲缓存回收；删除仍可关闭它。 */
  retainSpace: (spaceId: string) => Promise<{ conversation: Conversation; release: () => void } | undefined>;
  retainThread: (spaceId: string) => Promise<{ conversation: Conversation; release: () => void } | undefined>;
  spaces: () => Promise<SpaceSnapshot[]>;
  threads: () => Promise<Array<{ id: string; updatedAt: string }>>;
  /** 来源绑定、规则/技能保存与重置/删除共享短生命周期锁，不覆盖模型执行。 */
  withSpace: <T>(spaceId: string, change: (conversation: Conversation) => Promise<T>) => Promise<T>;
  withThread: <T>(spaceId: string, change: (conversation: Conversation) => Promise<T>) => Promise<T>;
  resetSpace: <T>(spaceId: string, onReset: (hooks: SpaceResetHooks) => Promise<T>) => Promise<T>;
  deleteSpace: <T>(spaceId: string, remove: () => Promise<T>) => Promise<T>;
  deleteThread: <T>(spaceId: string, remove: () => Promise<T>) => Promise<T>;
  /** 内部任务结束后释放缓存；历史仍由 pi JSONL 保留。 */
  release: (spaceId: string) => Promise<void>;
  closeAll: () => Promise<void>;
};

/**
 * 每个 space 只创建一份协调器，Promise 缓存同时覆盖异步初始化阶段。
 * 短操作串行化只负责创建/来源绑定/删除；删除先关门再等待旧操作与模型取消，
 * 因此迟到的读和通知不能借惰性初始化重新创建目录。模型仍只由 conversation 加锁。
 */
export const createConversationHub = (
  create: (spaceId: string, initialSessionId?: string) => Promise<Conversation>,
  listSpaces: () => Promise<Array<{ id: string; sessionId?: string; updatedAt: string }>>,
): ConversationHub => {
  type Cached = { promise: Promise<Conversation>; value?: Conversation; touchedAt: number; pins: number };
  const cache = new Map<string, Cached>();
  const sessionIds = new Map<string, string>();
  const operations = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ensureSessionId = (id: string, preferred?: string): string => {
    if (preferred) {
      sessionIds.set(id, preferred);
      return preferred;
    }
    let current = sessionIds.get(id);
    if (!current) {
      current = randomUUID();
      sessionIds.set(id, current);
    }
    return current;
  };
  const validateId = (id: string) => {
    if (!isSpaceId(id)) rejectConversation("UNSUPPORTED_SPACE", "Invalid spaceId");
    if (closed) rejectConversation("SHUTDOWN", "Service is closing");
  };
  const writable = (id: string) => {
    validateId(id);
    if (deleting.has(id)) rejectConversation("SPACE_DELETING", "Space is being deleted");
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
  const open = (id: string, preferredSessionId?: string) => {
    if (cache.size >= 32) {
      for (const [other, entry] of cache) {
        if (other !== "local-main" && other !== id && Date.now() - entry.touchedAt >= 300_000)
          void release(other).catch(() => undefined);
      }
    }
    let entry = cache.get(id);
    if (!entry) {
      const initialSessionId = ensureSessionId(id, preferredSessionId);
      entry = { promise: Promise.resolve().then(() => create(id, initialSessionId)), touchedAt: Date.now(), pins: 0 };
      cache.set(id, entry);
      const owned = entry;
      entry.promise.then((value) => {
        owned.value = value;
        sessionIds.set(id, value.sessionId());
      }, () => {
        if (cache.get(id) === owned) cache.delete(id);
      });
    }
    entry.touchedAt = Date.now();
    return entry.promise;
  };
  const find = async (id: string) => {
    if (deleting.has(id)) return undefined;
    if (!cache.has(id) && !(await listSpaces()).some((space) => space.id === id)) return undefined;
    if (deleting.has(id)) return undefined;
    return open(id);
  };
  return {
    forSpace(id) {
      writable(id);
      return serial(id, () => {
        if (deleting.has(id)) rejectConversation("SPACE_DELETING", "Space is being deleted");
        return open(id);
      });
    },
    forThread(id) {
      return this.forSpace(id);
    },
    findSpace(id) {
      validateId(id);
      if (deleting.has(id)) return Promise.resolve(undefined);
      return serial(id, () => find(id));
    },
    findThread(id) {
      return this.findSpace(id);
    },
    retainSpace(id) {
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
    retainThread(id) {
      return this.retainSpace(id);
    },
    withSpace(id, change) {
      writable(id);
      return serial(id, async () => {
        if (deleting.has(id)) rejectConversation("SPACE_DELETING", "Space is being deleted");
        return change(await open(id));
      });
    },
    withThread(id, change) {
      return this.withSpace(id, change);
    },
    resetSpace(id, onReset) {
      writable(id);
      return serial(id, async () => {
        if (deleting.has(id)) rejectConversation("SPACE_DELETING", "Space is being deleted");
        const closeCurrent = async () => {
          const entry = cache.get(id);
          cache.delete(id);
          if (entry) {
            const conversation = await entry.promise;
            await conversation.close();
          }
        };
        const reopen = async () => {
          if (deleting.has(id)) rejectConversation("SPACE_DELETING", "Space is being deleted");
          return open(id, randomUUID());
        };
        return onReset({ closeCurrent, reopen });
      });
    },
    deleteSpace(id, remove) {
      writable(id);
      // 同步关门：不能只把删除排到队尾，否则新来源绑定会插到清理之后。
      deleting.add(id);
      return serial(id, async () => {
        const entry = cache.get(id);
        cache.delete(id);
        sessionIds.delete(id);
        if (entry) {
          // close 同步关闭 notify/run 入口，再取消在途轮；旧引用永远不指向新同名会话。
          const conversation = await entry.promise;
          await conversation.close();
        }
        return remove();
      }).finally(() => { deleting.delete(id); });
    },
    deleteThread(id, remove) {
      return this.deleteSpace(id, remove);
    },
    spaces: async () => {
      const stored = await listSpaces();
      return stored.map((space) => {
        const cached = cache.get(space.id)?.value;
        const sessionId = cached
          ? ensureSessionId(space.id, cached.sessionId())
          : ensureSessionId(space.id, space.sessionId);
        return { id: space.id, sessionId, updatedAt: space.updatedAt };
      });
    },
    threads: async () => (await listSpaces()).map((s) => ({ id: s.id, updatedAt: s.updatedAt })),
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
