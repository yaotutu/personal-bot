import { ConversationError, rejectConversation } from "./errors.js";
import { validateConversationInput } from "./validate-input.js";
import type { ConversationDependencies, ConversationExecution } from "./ports.js";
import type { CancelReason, ConversationEvent, ConversationInput, ConversationResult, ConversationTurn, ConversationNotification } from "./types.js";

type ActiveRun = {
  runId: string;
  done: Promise<void>;
  session?: ConversationExecution;
  reason?: CancelReason;
};
// 会话只管理唯一的运行锁和生命周期；执行与历史由组合入口注入，不持有 SDK/store。
export function createConversation(
  config: { configured: boolean; runTimeoutMs: number },
  dependencies: ConversationDependencies,
) {
  const { history: historyPort, openSession } = dependencies;
  const { history, records } = historyPort;
  let active: ActiveRun | undefined;
  let closed = false;
  let closing: Promise<boolean> | undefined;
  const notifications = new Map<string, {
    notification: ConversationNotification;
    resolve: () => void;
    reject: (error: unknown) => void;
    done: Promise<void>;
  }>();
  const flushNotifications = () => {
    for (const [id, pending] of notifications) {
      try {
        if (!history().some((message) => message.id === id)) historyPort.appendNotification(pending.notification);
        pending.resolve();
      } catch (error) { pending.reject(error); }
      notifications.delete(id);
    }
  };
  // 忙碌时排队，真正写入 pi 树后才确认投递；通知失败不改变模型轮的执行结果。
  const notify = (text: string, id: string): Promise<void> => {
    if (closed) return Promise.reject(new Error("Conversation is closed"));
    const existing = notifications.get(id);
    if (existing) return existing.done;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    notifications.set(id, { notification: { id, text }, resolve, reject, done });
    if (!active) flushNotifications();
    return done;
  };
  const cancel = async (
    reason: ActiveRun["reason"] = "STOPPED",
    runId?: string,
  ) => {
    const running = active;
    if (!running || (runId && runId !== running.runId)) return false;
    running.reason ??= reason;
    try {
      if (running.session) await running.session.abort();
    } finally {
      await running.done;
    }
    return true;
  };
  // 预检用于 HTTP 在开启 SSE 前返回 400/409；run 再检查一次，防止异步创建流期间争锁。
  const validate = (input: ConversationInput) => {
    if (closed) rejectConversation("SHUTDOWN", "Conversation is closed");
    if (active) rejectConversation("agent_thread_locked", "Wait for the current response to stop");
    const validated = validateConversationInput(input, history(), records(), historyPort.checkpoint() ?? "empty");
    if (!config.configured) rejectConversation("MODEL_NOT_CONFIGURED", "Configure the server model before sending");
    return validated;
  };
  const snapshot = () => ({ messages: history(), revision: historyPort.checkpoint() ?? "empty" });
  const run = async (
    input: ConversationInput,
    emit: (event: ConversationEvent) => void,
    signal?: AbortSignal,
  ) => {
    const { user, previous, replay } = validate(input);
    if (signal?.aborted)
      rejectConversation("DISCONNECTED", "Client disconnected before the run started");
    let release!: () => void;
    const running: ActiveRun = {
      runId: input.runId,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    active = running;
    const disconnected = () => {
      void cancel("DISCONNECTED").catch(() => undefined);
    };
    signal?.addEventListener("abort", disconnected, { once: true });
    const timeout = setTimeout(() => {
      void cancel("TIMEOUT").catch(() => undefined);
    }, config.runTimeoutMs);
    let unsubscribe: (() => void) | undefined;
    const turn: ConversationTurn = {
      userId: user.id,
      text: user.content as string,
      runId: input.runId,
      assistantId: "assistant-" + input.runId,
    };
    let finalReason: string | undefined;
    let status: ConversationResult["status"] = "failed";
    // nanobot 不会因为最终模型回复失败而否认已经完成的工具副作用。
    // 工具结果也可能是拒绝或只读结果，因此只提示“已发生的修改不会回滚”，
    // 不把收到任意工具结果错误地等同于写入成功，不复制 provider 状态或引入事务。
    let toolReturned = false;
    const checkpoint = historyPort.checkpoint();
    let turnRecorded = false;
    const endText = () => emit({ type: "text_end", assistantId: turn.assistantId });
    try {
      emit({
        type: "run_started",
        assistantId: turn.assistantId,
        threadId: input.threadId,
        runId: input.runId,
      });
      if (replay) {
        emit({ type: "history_snapshot", messages: history() });
        status = "completed";
      } else {
        // 初始化或刚开始就停止时，不应先隐藏待重试的旧消息。先打开宿主，
        // 再提交 context edit，并同步宿主内存中的模型上下文。
        running.session = await openSession({ runId: running.runId });
        if (running.reason)
          throw new ConversationError(running.reason, "Response cancelled");
        // 只在宿主初始化成功且尚未取消时隐藏待重试轮，保持早停时旧历史可见。
        if (previous) historyPort.omitTurn(previous.runId);
        historyPort.appendTurn(turn);
        turnRecorded = true;
        running.session.syncContext();
        unsubscribe = running.session.subscribe((event) => {
          if (event.type === "assistant_end") finalReason = event.reason;
          else {
            if (event.type === "tool_result") toolReturned = true;
            emit(event);
          }
        });
        await running.session.prompt(turn.text);
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
        historyPort.appendResult({
          runId: input.runId,
          status,
        } satisfies ConversationResult);
      }
      emit({
        type: "run_finished",
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
      if (turnRecorded) historyPort.restoreIfNoUser(input.runId, checkpoint);
      endText();
      status = running.reason ? "aborted" : "failed";
      historyPort.appendResult({
        runId: input.runId,
        status,
      } satisfies ConversationResult);
      const code =
        running.reason ||
        (error instanceof ConversationError ? error.code : "MODEL_ERROR");
      // 不把供应商响应/URL/凭据直接发给客户端或写入日志，避免 endpoint 错误反射密钥。
      const failureMessage =
        code === "STOPPED"
          ? "Run stopped by user"
          : code === "TIMEOUT"
            ? "Model response timed out; retry when the endpoint is available"
            : code === "DISCONNECTED" || code === "SHUTDOWN"
              ? "Response cancelled"
              : "Model request failed. Check server configuration and endpoint availability; then retry.";
      const message = toolReturned
        ? `${failureMessage} Any changes already made by tools were not rolled back. Check the current state before repeating the request.`
        : failureMessage;
      emit({ type: "run_error", code, message });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", disconnected);
      unsubscribe?.();
      try {
        running.session?.dispose();
      } finally {
        // SDK 清理异常也不能悬挂已排队通知，否则 monitor.close 会永远等待投递。
        flushNotifications();
        active = undefined;
        release();
      }
    }
  };
  // P4 定时任务触发的服务端轮次：与客户端 run 互斥共用一把锁，但不走 AG-UI
  // emit、不做客户端校验；turn 与结果照常落 pi 历史，用户刷新/下一轮同步可见。
  // 崩溃哲学：失败只诚实标记（result entry），不做断点续跑。
  const trigger = async (
    text: string,
    runId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) => {
    if (closed || options.signal?.aborted) return { status: "failed" as const, text: "cancelled" };
    if (active) return { status: "failed" as const, text: "busy" };
    let release!: () => void;
    const running: ActiveRun = {
      runId,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    active = running;
    const aborted = () => { void cancel("STOPPED", runId).catch(() => undefined); };
    options.signal?.addEventListener("abort", aborted, { once: true });
    // 只有后台 worker 显式提供 timeout；定时 jobs 保持既有的无客户端超时语义。
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      void cancel("TIMEOUT", runId).catch(() => undefined);
    }, options.timeoutMs);
    let unsubscribe: (() => void) | undefined;
    let finalReason: string | undefined;
    let finalText = "";
    const turn: ConversationTurn = {
      userId: runId,
      text,
      runId,
      assistantId: "assistant-" + runId,
    };
    try {
      running.session = await openSession({ runId: running.runId });
      if (running.reason) throw new ConversationError(running.reason, "Response cancelled");
      historyPort.appendTurn(turn);
      running.session.syncContext();
      unsubscribe = running.session.subscribe((event) => {
        // 工具轮的终止消息可能没有文本，只在非空时覆盖最后一段回复。
        if (event.type === "assistant_end") {
          finalReason = event.reason;
          if (event.text) finalText = event.text;
        }
      });
      await running.session.prompt(text);
      await running.session.waitForIdle();
      const ok = !running.reason && finalReason && finalReason !== "error" && finalReason !== "aborted";
      historyPort.appendResult({
        runId,
        status: ok ? "completed" : "failed",
      } satisfies ConversationResult);
      return { status: ok ? ("completed" as const) : ("failed" as const), text: finalText };
    } catch {
      if (running.session) {
        await running.session.abort();
        await running.session.waitForIdle();
      }
      historyPort.appendResult({
        runId,
        status: "failed",
      } satisfies ConversationResult);
      return { status: "failed" as const, text: "" };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", aborted);
      unsubscribe?.();
      try {
        running.session?.dispose();
      } finally {
        flushNotifications();
        active = undefined;
        release();
      }
    }
  };
  return {
    history,
    snapshot,
    validate,
    run,
    trigger,
    notify,
    cancel,
    isRunning: () => Boolean(active),
    close: () => {
      closed = true;
      return closing ??= cancel("SHUTDOWN");
    },
  };
}
export type Conversation = Awaited<ReturnType<typeof createConversation>>;
