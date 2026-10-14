import { isThreadId } from "./validate-input.js";
import type { Conversation } from "./conversation-service.js";
import { rejectConversation } from "./errors.js";

/**
 * 单 owner 多会话协调：threadId → 独立 Conversation 实例的惰性缓存。
 * 每个 thread 拥有自己的运行锁与历史（pi 会话树），memory/jobs 等用户级
 * 能力由组合入口在工厂里共享。hub 不接触存储或 SDK；创建是异步的，
 * 缓存 Promise 保证并发请求拿到同一实例。
 */
type ThreadSnapshot = { id: string; updatedAt: string };
export type ConversationHub = {
  /** 校验并返回（首次创建）该 thread 的会话；非法 id 抛 UNSUPPORTED_THREAD。 */
  forThread: (threadId: string) => Promise<Conversation>;
  /** 已存在的 thread 列表（按最近活跃倒序）；目录扫描由组合入口注入。 */
  threads: () => Promise<ThreadSnapshot[]>;
  closeAll: () => Promise<void>;
};

export const createConversationHub = (
  create: (threadId: string) => Promise<Conversation>,
  listThreads: () => Promise<ThreadSnapshot[]>,
): ConversationHub => {
  const cache = new Map<string, Promise<Conversation>>();
  return {
    forThread(threadId) {
      if (!isThreadId(threadId))
        rejectConversation(
          "UNSUPPORTED_THREAD",
          "threadId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ (max 64)",
        );
      let conversation = cache.get(threadId);
      if (!conversation) {
        conversation = create(threadId);
        cache.set(threadId, conversation);
        // 创建失败不缓存坏实例，下一次请求可以重试。
        conversation.catch(() => cache.delete(threadId));
      }
      return conversation;
    },
    threads: listThreads,
    closeAll: async () => {
      const pending = [...cache.values()];
      cache.clear();
      const conversations = await Promise.all(pending);
      await Promise.all(conversations.map((x) => x.close()));
    },
  };
};
