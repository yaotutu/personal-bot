import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { MemoryService } from "../../../features/memory/memory-service.js";

// P3 对话式记忆工具：只显式写入（用户说"记住/忘掉"才动），目标是唯一的
// memory.json，不触碰文件系统其它位置。精确编辑走 Apps 页界面。
export const memoryTool = (store: Pick<MemoryService, "add" | "list" | "forget">) =>
  defineTool({
    name: "memory",
    label: "Long-term memory",
    description:
      "Explicitly remember or forget a fact about the user, persisting across conversations. " +
      'Use remember when the user says things like "记住…/remember…". ' +
      "Use forget when the user asks to remove a memory (match by keyword). " +
      "Never store credentials, API keys, or secrets.",
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("remember"), Type.Literal("forget")]),
        text: Type.Optional(
          Type.String({ description: "The fact to remember, concise, in the user's language." }),
        ),
        keyword: Type.Optional(
          Type.String({ description: "Keyword of the memory to forget." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "remember") {
        if (!params.text?.trim())
          return {
            content: [{ type: "text", text: "Nothing to remember: empty text." }],
            details: undefined,
            isError: true,
          };
        const item = await store.add(params.text, "chat");
        return {
          content: [{ type: "text", text: `Remembered: ${item.text}` }],
          details: { id: item.id },
        };
      }
      const keyword = params.keyword?.trim() ?? params.text?.trim() ?? "";
      if (!keyword)
        return {
          content: [{ type: "text", text: "Nothing to forget: empty keyword." }],
          details: undefined,
          isError: true,
        };
      const list = await store.list();
      const hits = list.filter((x) => x.text.includes(keyword));
      if (!hits.length)
        return {
          content: [{ type: "text", text: `No memory matches "${keyword}".` }],
          details: undefined,
        };
      for (const hit of hits) await store.forget(hit.id);
      return {
        content: [
          { type: "text", text: `Forgot ${hits.length} memory item(s) matching "${keyword}".` },
        ],
        details: undefined,
      };
    },
  });
