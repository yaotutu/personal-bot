import { mkdir } from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { threadSessionsDir, type DataLayout } from "../storage/data-layout.js";
import type { ConversationHistoryPort } from "../../features/conversation/ports.js";
import { RESULT_ENTRY_TYPE, TURN_ENTRY_TYPE, type ConversationTurn } from "../../features/conversation/types.js";
import { collectConversationRecords, projectConversationHistory } from "./history-projection.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";

const turnIndex = (branch: readonly SessionEntry[], runId: string) =>
  branch.findLastIndex((entry) =>
    entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE &&
    (entry.data as ConversationTurn).runId === runId,
  );

/**
 * pi entry tree 是历史唯一事实来源。
 * 展示读取完整 branch（不读压缩后的 model context）；重试只追加 context edit。
 */
export const createSessionHistory = async (
  layout: DataLayout,
  threadId: string,
  presentation?: ToolPresentation,
) => {
  const sessionsDir = threadSessionsDir(layout, threadId);
  await Promise.all(
    [layout.workspaceDir, sessionsDir, layout.agentDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const manager = SessionManager.continueRecent(layout.workspaceDir, sessionsDir);
  const history: ConversationHistoryPort = {
    history: () => {
      const projected = projectConversationHistory(manager.getBranch());
      return presentation ? presentation.presentHistory(projected) : projected;
    },
    records: () => collectConversationRecords(manager.getBranch()),
    checkpoint: () => manager.getLeafId(),
    appendTurn: (turn) => { manager.appendCustomEntry(TURN_ENTRY_TYPE, turn); },
    appendResult: (result) => { manager.appendCustomEntry(RESULT_ENTRY_TYPE, result); },
    omitTurn: (runId) => {
      const branch = manager.getBranch();
      for (const entry of branch.slice(turnIndex(branch, runId) + 1)) {
        if (entry.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult"))
          manager.appendContextEdit(entry.id, null);
      }
    },
    restoreIfNoUser: (runId, checkpoint) => {
      const branch = manager.getBranch();
      const hasUser = branch.slice(turnIndex(branch, runId) + 1)
        .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (hasUser) return;
      // 保留新追加的审计条目，但恢复旧叶子，不能让前置失败抹掉原历史。
      if (checkpoint) manager.branch(checkpoint);
      else manager.resetLeaf();
    },
  };
  // manager 只提供给同一 pi adapter 的执行装配，不暴露到 feature 或协议层。
  return { manager, history };
};
