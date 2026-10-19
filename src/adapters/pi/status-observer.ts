import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { StatusRun } from "../../features/workspace/agent-status.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";

/** 与Activity共用pi真实事件，但只输出当前运行投影；不记录模型文本或原始工具载荷。 */
export const createStatusObserver = (status: StatusRun, presentation: ToolPresentation, subagentId: string | null) => {
  let responding = false;
  return (event: AgentSessionEvent) => {
    if (event.type === "turn_start") { responding = false; status.observe({ kind: "model", phase: "start", subagentId }); }
    if (event.type === "message_update" && !responding && event.assistantMessageEvent.type === "text_delta") {
      responding = true;
      status.observe({ kind: "model", phase: "responding", subagentId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") status.observe({ kind: "model", phase: "end", subagentId });
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      status.observe({ kind: "tool", phase: event.type === "tool_execution_start" ? "start" : "end",
        toolCallId: event.toolCallId, name: presentation.modeFor(event.toolName) === "hidden" ? null : event.toolName, subagentId });
    }
  };
};
