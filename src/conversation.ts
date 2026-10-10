import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { openPi } from "./pi.js";

const turnType = "personal-bot.turn";
const resultType = "personal-bot.result";
type Turn = {
  userId: string;
  text: string;
  runId: string;
  assistantId: string;
};
type Result = { runId: string; status: "completed" | "failed" | "aborted" };
type ActiveRun = {
  runId: string;
  done: Promise<void>;
  session?: AgentSession;
  reason?: "STOPPED" | "DISCONNECTED" | "TIMEOUT" | "SHUTDOWN";
};
export class ConversationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const reject = (code: string, message: string): never => {
  throw new ConversationError(code, message);
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (x): x is { type: "text"; text: string } =>
              x?.type === "text" && typeof x.text === "string",
          )
          .map((x) => x.text)
          .join("")
      : "";

export async function createConversation(config: Config) {
  const cwd = join(config.dataDir, "workspace");
  const sessionDir = join(config.dataDir, "sessions");
  await Promise.all(
    [cwd, sessionDir, join(config.dataDir, "agent")].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const manager = SessionManager.continueRecent(cwd, sessionDir);
  let active: ActiveRun | undefined;

  // pi 的 entry tree 是唯一事实来源；custom entry 只保存 UI 标识，不进入模型上下文。
  // 用 getBranch 而非压缩后的 buildSessionContext，保证将来压缩不会丢失展示历史。
  const records = () => {
    const turns: Turn[] = [];
    const results = new Map<string, Result>();
    for (const entry of manager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === turnType) turns.push(entry.data as Turn);
      if (entry.customType === resultType) {
        const result = entry.data as Result;
        results.set(result.runId, result);
      }
    }
    return { turns, results };
  };
  const history = (): Message[] => {
    const branch = manager.getBranch();
    const omitted = new Set(
      branch
        .filter((x) => x.type === "context_edit" && x.replacement === null)
        .map((x) => (x.type === "context_edit" ? x.targetId : "")),
    );
    const messages: Message[] = [];
    let turn: Turn | undefined;
    // 一轮里 pi 可能产生多段 assistant 消息（工具调用前/后）。AG-UI 侧合并为
    // 单条 assistant 消息，保住 P1 的稳定消息 ID 契约；文本用空行分隔。
    let merged:
      | {
          id: string;
          role: "assistant";
          content: string;
          toolCalls?: NonNullable<
            Extract<Message, { role: "assistant" }>["toolCalls"]
          >;
        }
      | undefined;
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === turnType) {
        turn = entry.data as Turn;
        merged = undefined;
      }
      if (entry.type !== "message" || omitted.has(entry.id)) continue;
      const { message } = entry;
      if (message.role === "user") {
        const content = textOf(message.content);
        if (!content) continue;
        messages.push({
          id: turn?.userId || entry.id,
          role: "user",
          content,
        });
      } else if (message.role === "assistant") {
        const content = textOf(message.content);
        const toolCalls = (Array.isArray(message.content)
          ? message.content
          : []
        ).flatMap((x) => {
          const block = x as
            | { type: string; id?: unknown; name?: unknown; arguments?: unknown }
            | undefined;
          return block?.type === "toolCall" && typeof block.id === "string"
            ? [
                {
                  id: block.id,
                  type: "function" as const,
                  function: {
                    name: String(block.name ?? ""),
                    arguments: JSON.stringify(block.arguments ?? {}),
                  },
                },
              ]
            : [];
        });
        if (!content && !toolCalls.length) continue;
        if (merged) {
          merged.content = [merged.content, content].filter(Boolean).join("\n\n");
          merged.toolCalls = [...(merged.toolCalls || []), ...toolCalls];
        } else {
          merged = {
            id: turn?.assistantId || entry.id,
            role: "assistant",
            content,
            ...(toolCalls.length ? { toolCalls } : {}),
          };
          messages.push(merged);
        }
      } else if (message.role === "toolResult") {
        // 工具结果单独投影为 role "tool" 消息；id 与实时 TOOL_CALL_RESULT
        // 事件的 messageId 保持一致，刷新前后前端关联不变。
        messages.push({
          id: "tool-" + message.toolCallId,
          role: "tool",
          content: textOf(message.content),
          toolCallId: message.toolCallId,
        });
      }
    }
    return messages;
  };
  const validate = (input: RunAgentInput) => {
    if (input.threadId !== "local-main")
      reject("UNSUPPORTED_THREAD", "Only local-main is supported");
    if (input.runId.length > 200 || !input.runId)
      reject("INVALID_INPUT", "Invalid run ID");
    // 客户端传来的 assistant/system/tool/context 都不导入 pi，防止历史伪造或越权。
    const users = input.messages.filter((x) => x.role === "user");
    const last = users.at(-1);
    if (
      !last ||
      typeof last.content !== "string" ||
      !last.content.trim() ||
      last.content.length > 32_000 ||
      !last.id.trim() ||
      last.id.length > 200
    )
      reject(
        "INVALID_INPUT",
        "Send one non-empty text message (maximum 32000 characters)",
      );
    if (
      users.some((x) => typeof x.content !== "string") ||
      new Set(users.map((x) => x.id)).size !== users.length
    )
      reject(
        "INVALID_INPUT",
        "User message IDs must be unique and content must be text",
      );
    const canonical = history().filter((x) => x.role === "user");
    const { turns, results } = records();
    const sameRun = turns.find((x) => x.runId === input.runId);
    if (
      sameRun &&
      (sameRun.userId !== last!.id || sameRun.text !== last!.content)
    )
      reject("RUN_ID_CONFLICT", "Run ID was already used for another message");
    // 只接受 canonical 用户历史 + 一条新消息，或最后一个用户消息的重试。
    // 不比较 assistant，因为流中断后客户端的局部文本可能与最终投影不同。
    const retry = canonical.length === users.length;
    if (
      !(users.length === canonical.length + 1 || retry) ||
      canonical.some(
        (x, i) => x.id !== users[i]?.id || x.content !== users[i]?.content,
      )
    )
      reject(
        "HISTORY_CONFLICT",
        "Conversation changed; reload history before sending",
      );
    const previous = retry
      ? turns.findLast((x) => x.userId === last!.id)
      : undefined;
    return {
      user: last!,
      previous,
      replay: previous && results.get(previous.runId)?.status === "completed",
    };
  };
  const cancel = async (
    reason: ActiveRun["reason"] = "STOPPED",
    runId?: string,
  ) => {
    const running = active;
    if (!running || (runId && runId !== running.runId)) return false;
    running.reason ??= reason;
    if (running.session) await running.session.abort();
    await running.done;
    return true;
  };
  const run = async (
    input: RunAgentInput,
    emit: (event: BaseEvent) => void,
    signal?: AbortSignal,
  ) => {
    if (active)
      reject("agent_thread_locked", "Wait for the current response to stop");
    const { user, previous, replay } = validate(input);
    if (!config.configured)
      reject(
        "MODEL_NOT_CONFIGURED",
        "Configure PERSONAL_MODEL_BASE_URL and PERSONAL_MODEL_ID on the server",
      );
    if (signal?.aborted)
      reject("DISCONNECTED", "Client disconnected before the run started");
    let release!: () => void;
    const running: ActiveRun = {
      runId: input.runId,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    active = running;
    const disconnected = () => {
      void cancel("DISCONNECTED");
    };
    signal?.addEventListener("abort", disconnected, { once: true });
    const timeout = setTimeout(() => {
      void cancel("TIMEOUT");
    }, config.runTimeoutMs);
    let unsubscribe: (() => void) | undefined;
    const turn: Turn = {
      userId: user.id,
      text: user.content as string,
      runId: input.runId,
      assistantId: "assistant-" + input.runId,
    };
    let textStarted = false;
    let finalReason: string | undefined;
    let status: Result["status"] = "failed";
    const checkpoint = manager.getLeafId();
    let turnRecorded = false;
    const endText = () => {
      if (textStarted)
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: turn.assistantId });
    };
    try {
      emit({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      if (replay) {
        emit({ type: EventType.MESSAGES_SNAPSHOT, messages: history() });
        status = "completed";
      } else {
        // 初始化或刚开始就停止时，不应先隐藏待重试的旧消息。先打开宿主，
        // 再提交 context edit，并同步宿主内存中的模型上下文。
        running.session = await openPi(config, manager);
        if (running.reason)
          throw new ConversationError(running.reason, "Response cancelled");
        if (previous) {
          // 失败/停止后的同 ID 重试不重复添加模型上下文。旧条目仍留在审计文件，
          // 只用 pi 的 append-only context edit 从当前上下文和 UI 投影中排除该轮。
          const branch = manager.getBranch();
          const start = branch.findLastIndex(
            (x) =>
              x.type === "custom" &&
              x.customType === turnType &&
              (x.data as Turn).runId === previous.runId,
          );
          for (const entry of branch.slice(start + 1))
            if (
              entry.type === "message" &&
              (entry.message.role === "user" ||
                entry.message.role === "assistant" ||
                entry.message.role === "toolResult")
            )
              manager.appendContextEdit(entry.id, null);
        }
        manager.appendCustomEntry(turnType, turn);
        turnRecorded = true;
        running.session.agent.state.messages =
          manager.buildSessionContext().messages;
        // AG-UI 的工具调用三段式与 pi 的 toolcall_* 流事件一一对应；START 只发
        // 一次，个别供应商流首 chunk 不带 id 时推迟到 delta/end 补发。
        const toolCallStarted = new Set<string>();
        const startToolCall = (id: string, name: string) => {
          if (toolCallStarted.has(id)) return;
          toolCallStarted.add(id);
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: name,
            parentMessageId: turn.assistantId,
          });
        };
        unsubscribe = running.session.subscribe((event) => {
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            if (update.type === "text_delta") {
              const delta = update.delta;
              if (!delta) return;
              if (!textStarted) {
                textStarted = true;
                emit({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: turn.assistantId,
                  role: "assistant",
                });
              }
              emit({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: turn.assistantId,
                delta,
              });
            }
            if (update.type === "toolcall_start") {
              const block = update.partial.content[update.contentIndex];
              if (block?.type === "toolCall" && block.id)
                startToolCall(block.id, block.name);
            }
            if (update.type === "toolcall_delta") {
              const block = update.partial.content[update.contentIndex];
              if (block?.type === "toolCall" && block.id) {
                startToolCall(block.id, block.name);
                emit({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: block.id,
                  delta: update.delta,
                });
              }
            }
            if (update.type === "toolcall_end") {
              const call = update.toolCall;
              if (!toolCallStarted.has(call.id)) {
                startToolCall(call.id, call.name);
                const args = JSON.stringify(call.arguments ?? {});
                if (args !== "{}")
                  emit({
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: call.id,
                    delta: args,
                  });
              }
              emit({
                type: EventType.TOOL_CALL_END,
                toolCallId: call.id,
              });
            }
          }
          if (event.type === "tool_execution_end") {
            // 错误结果不透传原文：工具错误可能携带供应商响应等敏感细节。
            const content = event.isError
              ? "Tool execution failed"
              : textOf(event.result?.content);
            emit({
              type: EventType.TOOL_CALL_RESULT,
              messageId: "tool-" + event.toolCallId,
              toolCallId: event.toolCallId,
              content,
              role: "tool",
            });
          }
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            finalReason = event.message.stopReason;
            // pi 会在通知 listener 之后持久化同一对象；供应商错误可能回显 key，
            // 因此只清洗错误诊断，不修改正常用户内容或模型生成的文本。
            if (event.message.errorMessage)
              event.message.errorMessage =
                "Model request failed or was cancelled";
          }
        });
        await running.session.prompt(turn.text, {
          expandPromptTemplates: false,
        });
        // prompt 完成 + waitForIdle 才允许提交终态；message_end 的 public listener
        // 早于 pi 内部 appendMessage，不能在 listener 内发 RUN_FINISHED。
        await running.session.waitForIdle();
        if (running.reason)
          throw new ConversationError(running.reason, "Response cancelled");
        if (
          finalReason === "error" ||
          finalReason === "aborted" ||
          !finalReason
        )
          throw new ConversationError(
            "MODEL_ERROR",
            "Model request failed. Check the server endpoint, model and API key; then retry.",
          );
        status = "completed";
        endText();
        manager.appendCustomEntry(resultType, {
          runId: input.runId,
          status,
        } satisfies Result);
      }
      emit({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
    } catch (error) {
      if (running.session) {
        await running.session.abort();
        await running.session.waitForIdle();
      }
      // prompt 的前置校验可能早于 user 持久化失败。没有新 user 时恢复旧叶子，
      // 保留追加条目用于审计，但不能让一次失败的重试抹掉原有聊天历史。
      if (turnRecorded) {
        const branch = manager.getBranch();
        const start = branch.findLastIndex(
          (x) =>
            x.type === "custom" &&
            x.customType === turnType &&
            (x.data as Turn).runId === input.runId,
        );
        if (
          !branch
            .slice(start + 1)
            .some((x) => x.type === "message" && x.message.role === "user")
        ) {
          if (checkpoint) manager.branch(checkpoint);
          else manager.resetLeaf();
        }
      }
      endText();
      status = running.reason ? "aborted" : "failed";
      manager.appendCustomEntry(resultType, {
        runId: input.runId,
        status,
      } satisfies Result);
      const code =
        running.reason ||
        (error instanceof ConversationError ? error.code : "MODEL_ERROR");
      // 不把供应商响应/URL/凭据直接发给客户端或写入日志，避免 endpoint 错误反射密钥。
      const message =
        code === "STOPPED"
          ? "Run stopped by user"
          : code === "TIMEOUT"
            ? "Model response timed out; retry when the endpoint is available"
            : code === "DISCONNECTED" || code === "SHUTDOWN"
              ? "Response cancelled"
              : "Model request failed. Check server configuration and endpoint availability; then retry.";
      emit({ type: EventType.RUN_ERROR, code, message });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", disconnected);
      unsubscribe?.();
      running.session?.dispose();
      active = undefined;
      release();
    }
  };
  return {
    history,
    run,
    cancel,
    isRunning: () => Boolean(active),
    close: () => cancel("SHUTDOWN"),
  };
}
export type Conversation = Awaited<ReturnType<typeof createConversation>>;
