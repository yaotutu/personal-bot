import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";
import type { Conversation } from "./conversation.js";
import { ConversationError } from "./conversation.js";

// 只有 SDK 适配边界使用继承；会话运行、历史和取消逻辑都在函数式 coordinator 中。
export class PiAgent extends AbstractAgent {
  constructor(
    private conversation: Conversation,
    private signal: AbortSignal,
  ) {
    super({
      agentId: "default",
      description: "Personal Bot: persistent text conversation powered by pi",
    });
  }
  override clone() {
    return new PiAgent(this.conversation, this.signal);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      let settled = false;
      const finish = () => {
        settled = true;
        observer.complete();
      };
      void this.conversation
        .run(input, (event) => observer.next(event), this.signal)
        .then(finish, (error) => {
          observer.next({
            type: EventType.RUN_ERROR,
            code: error instanceof ConversationError ? error.code : "RUN_ERROR",
            message:
              error instanceof ConversationError
                ? error.message
                : "Unable to start conversation",
          });
          finish();
        });
      // 连接关闭只取消当前请求拥有的 run；被拒绝的并发请求绝不能停止别人的回复。
      return () => {
        if (!settled)
          void this.conversation.cancel("DISCONNECTED", input.runId);
      };
    });
  }
}

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
