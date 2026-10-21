import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { threadInstructionsFile, type DataLayout } from "../../storage/data-layout.js";
import { readThreadInstructions, writeThreadInstructions } from "../../storage/thread-instructions.js";

/**
 * 会话专属指令工具：允许助手在对话中读取或修改当前会话的指令/规则（INSTRUCTIONS.md）。
 * 修改后在下一轮对话开始时自动注入 System Prompt 生效。
 */
export const instructionsTool = (layout: DataLayout, spaceId = "local-main") =>
  defineTool({
    name: "instructions",
    label: "Conversation instructions",
    description:
      "Read or update the custom instructions/rules for the current conversation. " +
      "Use it when the user asks you to follow specific guidelines, rules, tone, or workflows for this conversation. " +
      "Action 'get' returns current rules; 'set' replaces the rules with the provided content.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
      content: Type.Optional(
        Type.String({ maxLength: 20000, description: "Required for 'set': the complete instructions text to set for this conversation. Empty text explicitly clears the rules." }),
      ),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const file = threadInstructionsFile(layout, spaceId);
      if (params.action === "get") {
        const text = await readThreadInstructions(file);
        return {
          content: [
            {
              type: "text",
              text: text ? `Current conversation instructions:\n\n${text}` : "No custom instructions set for this conversation.",
            },
          ],
          details: undefined,
        };
      }

      if (params.action === "set") {
        if (typeof params.content !== "string") return {
          content: [{ type: "text", text: "Set requires explicit content; use an empty string only to clear instructions." }],
          details: { denied: true }, isError: true,
        };
        const content = params.content;
        await writeThreadInstructions(file, content);
        return {
          content: [
            {
              type: "text",
              text: content.trim()
                ? "Conversation instructions updated successfully. They will take effect on the next turn."
                : "Conversation instructions cleared.",
            },
          ],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: undefined,
        isError: true,
      };
    },
  });
