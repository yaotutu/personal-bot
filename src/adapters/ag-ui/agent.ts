import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import type { Conversation } from "../../features/conversation/conversation-service.js";
import { ConversationError } from "../../features/conversation/errors.js";
import { createEventProjector } from "./events.js";
import type { ToolPresentation } from "./tool-presentation.js";

// 只有 SDK 适配边界使用继承；会话运行、历史和取消逻辑都在函数式 coordinator 中。
export class PiAgent extends AbstractAgent {
  constructor(
    private conversation: Conversation,
    private signal: AbortSignal,
    private presentation?: ToolPresentation,
  ) {
    super({
      agentId: "default",
      description: "Personal Bot: persistent text conversation powered by pi",
    });
  }
  override clone() {
    return new PiAgent(this.conversation, this.signal, this.presentation);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      let settled = false;
      const finish = () => {
        settled = true;
        observer.complete();
      };
      void this.conversation
        .run(input, createEventProjector((event) => observer.next(event), this.presentation), this.signal)
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
