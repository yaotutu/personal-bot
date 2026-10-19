import { mkdir } from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ensureThreadLayout, ensureThreadWorkspace, threadSessionsDir, threadWorkspaceDir, type DataLayout } from "../storage/data-layout.js";
import type { ConversationHistoryPort } from "../../features/conversation/ports.js";
import { AGENT_STATUS_ENTRY_TYPE, RESULT_ENTRY_TYPE, TURN_ENTRY_TYPE, type ConversationTurn } from "../../features/conversation/types.js";
import type { AgentStatus } from "../../features/workspace/agent-status.js";
import { createNotificationMessage, notificationIdOf } from "./notification-message.js";
import { collectConversationRecords, projectConversationHistory } from "./history-projection.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";
import { createActivityHistory } from "./activity-history.js";
import { createActivitySession } from "../../features/activities/activity-session.js";

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
  const cwd = threadWorkspaceDir(layout, threadId);
  await ensureThreadLayout(layout);
  await ensureThreadWorkspace(layout, threadId);
  await Promise.all(
    [sessionsDir, layout.agentDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  // continueRecent 按 cwd 选择 JSONL，必须与执行会话一致；不读取旧 cwd 或自动迁移历史。
  const manager = SessionManager.continueRecent(cwd, sessionsDir);
  const history: ConversationHistoryPort = {
    history: () => {
      const projected = projectConversationHistory(manager.getBranch());
      return presentation ? presentation.presentHistory(projected) : projected;
    },
    records: () => collectConversationRecords(manager.getBranch()),
    appendAgentStatus: (status) => { manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, status); },
    agentStatuses: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === AGENT_STATUS_ENTRY_TYPE)
      .map((entry) => (entry as { data: AgentStatus }).data),
    checkpoint: () => manager.getLeafId(),
    appendTurn: (turn) => { manager.appendCustomEntry(TURN_ENTRY_TYPE, turn); },
    appendNotification: (notification) => {
      const checkpoint = manager.getLeafId();
      try {
        manager.appendMessage(createNotificationMessage(notification));
      } catch (error) {
        // pi 先更新内存树再写文件；写入失败不能让内存投影假装投递成功。
        if (checkpoint) manager.branch(checkpoint);
        else manager.resetLeaf();
        throw error;
      }
    },
    appendResult: (result) => { manager.appendCustomEntry(RESULT_ENTRY_TYPE, result); },
    omitTurn: (runId) => {
      const branch = manager.getBranch();
      for (const entry of branch.slice(turnIndex(branch, runId) + 1)) {
        // 独立任务/监控事实不属于被重试的模型轮，不能跟随旧回复一并隐藏。
        if (entry.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult") &&
          !(entry.message.role === "assistant" && notificationIdOf(entry.message)))
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
  const activityHistory = createActivityHistory(manager);
  const activities = createActivitySession(threadId, activityHistory);
  // manager 只提供给同一 pi adapter 的执行装配，不暴露到 feature 或协议层。
  return { manager, history, activities };
};
