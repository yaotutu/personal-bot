import { defaultIdentity } from "../identity/types.js";
import type { MemoryState } from "./types.js";

/**
 * 纯 prompt 渲染函数：不读文件、不改状态，只把已读取的业务数据格式化。
 * 长期记忆是沉淀库，不再逐条携带进每轮上下文，只告知数量与检索入口；
 * 始终携带的内容由 SOUL/USER/会话指令三份短文本承担。
 */
export const renderMemoryPrompt = ({ memories, identity }: MemoryState): string => {
  let output = "";
  if (memories.length) {
    output += `\n\n## Long-term memory\n${memories.length} saved item(s) are stored but not loaded into this prompt. Use memory_search to look them up when they may matter.\n`;
  }
  if (identity.name !== defaultIdentity.name || identity.tone !== defaultIdentity.tone) {
    output += `\n## Identity settings\n- Assistant name: ${identity.name}\n- Tone: ${identity.tone}\n`;
  }
  return output;
};
