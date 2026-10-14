import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import type { ConversationHub } from "../../features/conversation/conversation-hub.js";
import { ConversationError } from "../../features/conversation/errors.js";
import { createEventProjector } from "./events.js";
import type { ToolPresentation } from "./tool-presentation.js";

// 只有 SDK 适配边界使用继承；会话运行、历史和取消逻辑都在函数式 coordinator 中。
// 多会话：agent 持有 hub，每次 run 按 input.threadId 取该 thread 的会话实例。
export class PiAgent extends AbstractAgent {
  constructor(
    private hub: ConversationHub,
    private signal: AbortSignal,
    private presentation?: ToolPresentation,
  ) {
    super({
      agentId: "default",
      description: "Personal Bot: persistent text conversation powered by pi",
    });
  }
  override clone() {
    return new PiAgent(this.hub, this.signal, this.presentation);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      let settled = false;
      // 立即退订时 forThread 可能尚未解析；记录标志并在解析后补一次取消。
      let unsubscribed = false;
      const finish = () => {
        settled = true;
        observer.complete();
      };
      let cancel: ((reason?: "STOPPED" | "DISCONNECTED" | "TIMEOUT" | "SHUTDOWN", runId?: string) => Promise<boolean>) | undefined;
      // forThread 对非法 threadId 同步抛出；包进 Promise 链统一走 RUN_ERROR 投影。
      void Promise.resolve()
        .then(() => this.hub.forThread(input.threadId))
        .then((conversation) => {
          cancel = (reason, runId) => conversation.cancel(reason, runId);
          if (unsubscribed) {
            void cancel("DISCONNECTED", input.runId);
            finish();
            return;
          }
          return conversation.run(
            input,
            createEventProjector((event) => observer.next(event), this.presentation),
            this.signal,
          );
        })
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
        unsubscribed = true;
        if (!settled && cancel) void cancel("DISCONNECTED", input.runId);
      };
    });
  }
}
