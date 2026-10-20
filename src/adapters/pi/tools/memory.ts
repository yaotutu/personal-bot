import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { MemoryLimitError, type MemoryService } from "../../../features/memory/memory-service.js";

const fail = (text: string, denied = false): { content: { type: "text"; text: string }[]; details: unknown; isError: boolean } => ({
  content: [{ type: "text", text }],
  // denied 仅用于业务层受控拒绝（如条数上限），让可读原因穿过统一的错误脱敏。
  details: denied ? { denied: true } : undefined,
  isError: true,
});

/**
 * 对话式记忆工具：只写唯一的 memory.json，不触碰文件系统其它位置。
 * 记忆是不随每轮携带的沉淀库；修改和删除都按条目 id，避免关键词批量误删。
 * 对话里只在用户明确要求时写入；Dream 的自动沉淀走独立的受限提交通道。
 */
export const memoryTool = (store: Pick<MemoryService, "add" | "edit" | "forget">) =>
  defineTool({
    name: "memory",
    label: "Long-term memory",
    description:
      "Explicitly remember, correct or forget a long-term fact about the user, persisting across conversations. " +
      'Use remember when the user says things like "记住…/remember…". ' +
      "Use edit or forget with the item id returned by memory_search; never guess ids. " +
      "Never store credentials, API keys, or secrets.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("remember"), Type.Literal("edit"), Type.Literal("forget")]),
        text: Type.Optional(
          Type.String({ description: "The fact to remember, or the corrected text for edit; concise, in the user's language." }),
        ),
        id: Type.Optional(Type.String({ description: "Memory item id from memory_search; required for edit and forget." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "remember") {
        if (!params.text?.trim()) return fail("Nothing to remember: empty text.");
        try {
          const item = await store.add(params.text, "chat");
          return { content: [{ type: "text", text: `Remembered: ${item.text}` }], details: { id: item.id } };
        } catch (error) {
          if (error instanceof MemoryLimitError) return fail(error.message, true);
          throw error;
        }
      }
      const id = params.id?.trim();
      if (!id) return fail("Missing memory id: run memory_search first.");
      if (params.action === "edit") {
        if (!params.text?.trim()) return fail("Nothing to save: empty text.");
        const item = await store.edit(id, params.text);
        return item
          ? { content: [{ type: "text", text: `Edited memory ${item.id}` }], details: { id: item.id } }
          : { content: [{ type: "text", text: `No memory with id ${id}.` }], details: undefined };
      }
      const removed = await store.forget(id);
      return removed
        ? { content: [{ type: "text", text: `Forgot memory ${id}` }], details: { id } }
        : { content: [{ type: "text", text: `No memory with id ${id}.` }], details: undefined };
    },
  });

/** 只读检索：按关键词在沉淀库中查找，最多返回少量最近更新的条目。 */
export const memorySearchTool = (store: Pick<MemoryService, "search">) =>
  defineTool({
    name: "memory_search",
    label: "Search long-term memory",
    description:
      "Search saved long-term memories by keyword (case-insensitive substring, most recently updated first, at most 10 results). " +
      "Memories are not loaded into the prompt; use this when past facts about the user may matter, " +
      "and to find the id needed by memory edit/forget.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200, description: "Keyword to look for." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      const hits = await store.search(params.query, params.limit);
      const text = hits.length
        ? hits.map((item) => `- [${item.id}] ${item.text.replace(/\s+/g, " ").trim()}`).join("\n")
        : `No memory matches "${params.query}".`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
