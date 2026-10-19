import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ActivityObservation } from "../../features/activities/types.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";

/** 每个实际执行会话单独分配模型步序号；子会话用服务端前缀，防重复toolCallId碰撞。 */
export const createActivityObserver = (
  observe: (event: ActivityObservation) => void,
  presentation: ToolPresentation,
  prefix = "main",
  parentId?: string,
) => {
  let model = 0;
  let pendingModel: string | undefined;
  return (event: AgentSessionEvent) => {
    if (event.type === "turn_start") {
      pendingModel = `${prefix}:model:${++model}`;
      observe({ id: pendingModel, parentId, kind: "model", phase: "start", title: "Model processing" });
    }
    if (event.type === "message_end" && event.message.role === "assistant" && pendingModel) {
      observe({ id: pendingModel, parentId, kind: "model", phase: "end", title: "Model response received",
        status: event.message.stopReason === "error" ? "failed" : event.message.stopReason === "aborted" ? "cancelled" : "succeeded",
        result: event.message.stopReason === "error" ? "Model request failed" : "Model response recorded" });
      pendingModel = undefined;
    }
    if (event.type === "tool_execution_start") {
      const name = event.toolName;
      if (name === "activity") return;
      const visible = presentation.modeFor(name) !== "hidden";
      observe({ id: `${prefix}:tool:${event.toolCallId}`, parentId, kind: "tool", phase: "start",
        title: visible ? `Executing ${name}` : "Executing tool" });
    }
    if (event.type === "tool_execution_end") {
      const name = event.toolName;
      if (name === "activity") return;
      const result = event.result as { details?: { denied?: boolean }; content?: unknown } | undefined;
      const denied = event.isError && result?.details?.denied === true;
      const visible = presentation.modeFor(name) !== "hidden";
      const id = `${prefix}:tool:${event.toolCallId}`;
      observe({ id, parentId, kind: "tool", phase: "end", title: visible ? `Finished ${name}` : "Tool finished",
        status: denied ? "denied" : event.isError ? "failed" : "succeeded", result: denied ? "Operation refused" : event.isError ? "Tool execution failed" : "Tool execution succeeded" });
      if (name === "write" || name === "edit") observe({
        id: `${id}:commit`, parentId: id, kind: "file_commit", phase: "end", title: "File commit result",
        status: denied ? "denied" : event.isError ? "failed" : "succeeded", result: denied ? "File commit refused; nothing written" : event.isError ? "File operation failed" : "File committed after approval and version checks",
      });
    }
  };
};
