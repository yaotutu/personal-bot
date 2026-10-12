import type { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { of } from "rxjs";
import type { Conversation } from "../../features/conversation/conversation-service.js";

export function createRunner(conversation: Conversation) {
  // 默认 InMemoryAgentRunner 自行订阅并重放，HTTP 退订后仍会运行。
  // 最小 runner 保留 SDK 的 info/run/stop 处理，但让 SSE 退订直接取消 pi。
  // P1 不支持 connect/执行中重放，已完成历史通过业务 GET 恢复。
  return {
    run: ({ agent, input }: { agent: AbstractAgent; input: RunAgentInput }) =>
      agent.run(input),
    connect: () =>
      of<BaseEvent>({
        type: EventType.RUN_ERROR,
        code: "UNSUPPORTED",
        message: "Reconnect is not supported; reload completed history",
      }),
    isRunning: async ({ threadId }: { threadId: string }) =>
      threadId === "local-main" && conversation.isRunning(),
    stop: async ({ threadId }: { threadId: string }) =>
      threadId === "local-main" && (await conversation.cancel()),
  };
}
