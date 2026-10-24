import type { StatusRun, AgentStatus } from "../workspace/agent-status.js";
import type { ActivityOverview, ActivityRun } from "../activities/types.js";
import type { ActivitySession } from "../activities/activity-session.js";
import type {
  ConversationHistory,
  ConversationNotification,
  ConversationRecords,
  ConversationResult,
  ConversationTurn,
  ExecutionEvent,
} from "./types.js";

/**
 * 只封装既有会话树操作，不维护第二份历史或模型上下文。
 * checkpoint/restore 仅用于 prompt 未写入新 user 时保住待重试的旧历史。
 */
export type ConversationHistoryPort = {
  sessionId?: () => string;
  history: () => ConversationHistory;
  records: () => ConversationRecords;
  checkpoint: () => string | null;
  omitTurn: (runId: string) => void;
  appendTurn: (turn: ConversationTurn) => void;
  appendNotification: (notification: ConversationNotification) => void;
  appendResult: (result: ConversationResult) => void;
  restoreIfNoUser: (runId: string, checkpoint: string | null) => void;
  appendAgentStatus?: (status: AgentStatus) => void;
  agentStatuses?: () => AgentStatus[];
};

/** 执行仍交给 pi；port 只包含协调器实际调用的操作，不重建 agent loop。 */
export type ConversationExecution = {
  prompt: (text: string, images?: readonly {
    type: "image";
    data: string;
    mimeType: string;
  }[]) => Promise<void>;
  waitForIdle: () => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  syncContext: () => void;
  subscribe: (listener: (event: ExecutionEvent) => void) => () => void;
};
export type ConversationDependencies = {
  spaceId?: string;
  history: ConversationHistoryPort;
  activities?: ActivitySession;
  beginStatus?: (input: { spaceId: string; runId: string; source: "chat" | "job"; jobId?: string; initialRevision: number }) => StatusRun;
  /** 活动概览状态变化时的展示推送（SSE 直推通道）；不拥有活动持久化，权威记录仍是会话 JSONL。 */
  publishActivity?: (overview: ActivityOverview) => void;
  cancelApprovals?: (spaceId: string, runId: string) => Promise<void>;
  /** 只订阅本轮真实审批的等待变化；不传载荷，也不依赖展示状态或推断文件执行成功。 */
  subscribeApprovals?: (
    spaceId: string,
    runId: string,
    listener: (change: { id: string; pending: boolean }) => void,
  ) => () => void;
  openSession: (context: { runId: string; activity?: ActivityRun; status?: StatusRun }) => Promise<ConversationExecution>;
};
