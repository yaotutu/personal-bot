import type { PendingAction } from "../features/actions/types.js";

/** 预览只投影当次绑定的完整文本，不读当前文件替代，不返回物理路径/版本指纹。 */
export const presentApproval = (action: PendingAction) => {
  const path = action.payload.path;
  const shared = path === "shared" || path.startsWith("shared/");
  const { payload: _payload, ...summary } = action;
  return {
    ...summary,
    execution: action.execution ?? null,
    preview: {
      scope: shared ? "shared" as const : "thread" as const,
      ownerThreadId: shared ? null : action.workspaceThreadId,
      path,
      before: action.payload.originalContent,
      after: action.payload.content,
      beforeExists: action.payload.beforeExists === "true",
    },
  };
};
export const presentApprovalResolution = (action: PendingAction) => ({
  id: action.id, revision: action.revision, threadId: action.threadId, runId: action.runId,
  toolCallId: action.toolCallId, subagentId: action.subagentId,
  workspaceThreadId: action.workspaceThreadId, activityId: action.activityId,
  status: action.status, createdAt: action.createdAt, expiresAt: action.expiresAt,
  resolvedAt: action.resolvedAt, decidedAt: action.decidedAt,
  execution: action.execution ?? null,
});
