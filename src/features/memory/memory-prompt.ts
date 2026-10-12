import { defaultIdentity } from "../identity/types.js";
import type { MemoryState } from "./types.js";

/**
 * 纯 prompt 渲染函数：不读文件、不改状态，只把已读取的业务数据格式化。
 * 这样 prompt 文案变化不会牵连 repository 的读写规则。
 */
export const renderMemoryPrompt = ({ memories, identity }: MemoryState): string => {
  let output = "";
  if (memories.length) {
    output += "\n\n## Long-term memory (explicit, user-curated)\n";
    for (const item of memories) {
      output += `- ${item.text.replace(/\s+/g, " ").trim()}\n`;
    }
  }
  if (identity.name !== defaultIdentity.name || identity.tone !== defaultIdentity.tone) {
    output += `\n## Identity settings\n- Assistant name: ${identity.name}\n- Tone: ${identity.tone}\n`;
  }
  return output;
};
