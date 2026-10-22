import type { AgentStatus, StatusRun, RunOutcome } from "../workspace/agent-status.js";
import type { ActivityRun } from "../activities/types.js";
import { ConversationError, rejectConversation } from "./errors.js";
import { validateConversationInput } from "./validate-input.js";
import type { ConversationDependencies, ConversationExecution } from "./ports.js";
import type { CancelReason, ConversationEvent, ConversationInput, ConversationResult, ConversationTurn, ConversationNotification } from "./types.js";

type ActiveRun = {
  runId: string;
  done: Promise<void>;
  session?: ConversationExecution;
  reason?: CancelReason;
  status?: StatusRun;
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
  const executionStatus = (runId: string): AgentStatus | undefined => {
    if (active?.runId === runId && active.status) return active.status.snapshot();
    const saved = historyPort.agentStatuses?.().findLast((status) => status.runId === runId);
    return saved ? structuredClone(saved) : undefined;
  };
  const beginStatus = (spaceId: string, runId: string, source: "chat" | "job", jobId?: string) => {
    const previous = executionStatus(runId);
    return dependencies.beginStatus?.({ spaceId, runId, source, jobId, initialRevision: (previous?.revision ?? 0) + 1 });
  };
  const statusActivity = (activity: ActivityRun | undefined, status: StatusRun | undefined): ActivityRun | undefined => {
    if (!activity || !status) return activity;
    // 状态变化时同时刷新运行状态投影与全局活动推送。
    // 方案定稿：只在活动状态变化时推送概览；progress 文本的过程性更新不单独推，
    // 面板在用户查看时通过 GET /api/activities/:id 拉到最新进展，避免长时间任务推几十条。
    // lastPushedStatus 初始化 undefined 而不是当前状态：resume 进现有活动时首轮不变更也要推一次，
    // 让重连后的客户端拿到该活动的最新概览。
    let lastPushedStatus: string | undefined;
    const push = (overview: Parameters<StatusRun["activity"]>[0]) => {
      if (!dependencies.publishActivity || overview.status === lastPushedStatus) return;
      lastPushedStatus = overview.status;
      try { dependencies.publishActivity(overview); } catch { /* 展示推送不拥有活动生命周期。 */ }
    };
    const sync = <T extends Parameters<StatusRun["activity"]>[0]>(overview: T) => {
      status.activity(overview);
      push(overview);
      return overview;
    };
    return { ...activity,
      start: (input) => sync(activity.start(input)), resume: (id) => sync(activity.resume(id)),
      update: (progress) => sync(activity.update(progress)), wait: (question) => sync(activity.wait(question)),
      complete: (result) => sync(activity.complete(result)),
      // finish 是运行收尾，活动在这里进入 completed/failed/stopped/interrupted/awaiting_continuation 等
      // 状态（见 activity-session.ts），也必须推送，否则完成事件永远到不了客户端。
      finish: (outcome, delivered) => {
        const overview = activity.finish(outcome, delivered);
        // 终态或 awaiting_continuation 都是状态变化；走同一 push 去重，重复 finish 不会重复通知。
        if (overview) push(overview);
        return overview;
      },
    };
  };
  const finishStatus = async (running: ActiveRun, spaceId: string, outcome: RunOutcome) => {
    await dependencies.cancelApprovals?.(spaceId, running.runId);
    if (running.status) historyPort.appendAgentStatus?.(running.status.finish(outcome));
  };
  const run = async (
    input: ConversationInput,
    emit: (event: ConversationEvent) => void,
    signal?: AbortSignal,
  ) => {
    const currentSpaceId = input.spaceId || dependencies.spaceId || "local-main";
    input.spaceId = currentSpaceId;
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
    // 只扣除非审批等待时间；多个审批重叠时，直到最后一个结束才恢复剩余预算。
    // 使用单调时钟计时，不重置预算；Stop/断流仍直接 cancel，不依赖此 timer。
    let remainingMs = config.runTimeoutMs;
    let countingSince = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resumeTimeout = () => {
      countingSince = performance.now();
      timeout = setTimeout(() => {
        void cancel("TIMEOUT", running.runId).catch(() => undefined);
      }, remainingMs);
    };
    resumeTimeout();
    const pendingApprovals = new Set<string>();
    let unsubscribeApprovals: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const turn: ConversationTurn = {
      userId: user.id,
      text: user.content as string,
      runId: input.runId,
      assistantId: "assistant-" + input.runId,
    };
    let activity: ActivityRun | undefined;
    let delivered = false;
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
      // 在打开模型执行前订阅，避免漏掉本轮（含子代理）刚登记的审批。
      unsubscribeApprovals = dependencies.subscribeApprovals?.(currentSpaceId, running.runId, ({ id, pending }) => {
        if (pending) {
          if (pendingApprovals.size === 0) {
            clearTimeout(timeout);
            timeout = undefined;
            remainingMs = Math.max(0, remainingMs - (performance.now() - countingSince));
          }
          pendingApprovals.add(id);
        } else if (pendingApprovals.delete(id) && pendingApprovals.size === 0 && !running.reason) {
          resumeTimeout();
        }
      });
      emit({
        type: "run_started",
        assistantId: turn.assistantId,
        spaceId: currentSpaceId,
        runId: input.runId,
      });
      if (replay) {
        emit({ type: "history_snapshot", messages: history() });
        status = "completed";
      } else {
        // 初始化或刚开始就停止时，不应先隐藏待重试的旧消息。先打开宿主，
        // 再提交 context edit，并同步宿主内存中的模型上下文。
        running.status = beginStatus(currentSpaceId, running.runId, "chat");
        activity = statusActivity(dependencies.activities?.beginRun(running.runId), running.status);
        running.session = await openSession({ runId: running.runId, activity, status: running.status });
        if (running.reason)
          throw new ConversationError(running.reason, "Response cancelled");
        // 只在宿主初始化成功且尚未取消时隐藏待重试轮，保持早停时旧历史可见。
        if (previous) historyPort.omitTurn(previous.runId);
        historyPort.appendTurn(turn);
        turnRecorded = true;
        running.session.syncContext();
        unsubscribe = running.session.subscribe((event) => {
          if (event.type === "assistant_end") {
            finalReason = event.reason;
            delivered = Boolean(event.text.trim());
          }
          else {
            if (event.type === "tool_result") toolReturned = true;
            emit(event);
          }
        });
        await running.session.prompt(turn.text);
        // prompt 完成 + waitForIdle 才允许提交终态；message_end 的 public listener
        // 早于 pi 内部 appendMessage，不能在 listener 内发 RUN_FINISHED。
        await running.session.waitForIdle();
        running.status?.finalizing();
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
        activity?.finish("completed", delivered);
        await finishStatus(running, currentSpaceId, "succeeded");
      }
      emit({
        type: "run_finished",
        spaceId: currentSpaceId,
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
      activity?.finish(running.reason === "STOPPED" || running.reason === "DISCONNECTED" ? "stopped" : running.reason === "SHUTDOWN" ? "interrupted" : "failed");
      await finishStatus(running, currentSpaceId, running.reason ? "cancelled" : "failed");
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
      unsubscribeApprovals?.();
      signal?.removeEventListener("abort", disconnected);
      unsubscribe?.();
      try {
        running.session?.dispose();
      } finally {
        // SDK 清理异常也不能悬挂已排队通知，否则 monitor.close 会永远等待投递。
        activity?.close();
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
    options: { signal?: AbortSignal; timeoutMs?: number; jobId?: string; spaceId?: string } = {},
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
    let activity: ActivityRun | undefined;
    let finalReason: string | undefined;
    let finalText = "";
    const turn: ConversationTurn = {
      userId: runId,
      text,
      runId,
      assistantId: "assistant-" + runId,
    };
    const sourceSpaceId = dependencies.spaceId ?? options.spaceId ?? "local-main";
    try {
      running.status = beginStatus(sourceSpaceId, running.runId, "job", options.jobId);
      activity = statusActivity(dependencies.activities?.beginRun(running.runId), running.status);
      running.session = await openSession({ runId: running.runId, activity, status: running.status });
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
      running.status?.finalizing();
      const ok = !running.reason && finalReason && finalReason !== "error" && finalReason !== "aborted";
      historyPort.appendResult({
        runId,
        status: ok ? "completed" : "failed",
      } satisfies ConversationResult);
      activity?.finish(ok ? "completed" : running.reason === "STOPPED" ? "stopped" : running.reason === "SHUTDOWN" ? "interrupted" : "failed", Boolean(finalText.trim()));
      await finishStatus(running, sourceSpaceId, ok ? "succeeded" : running.reason ? "cancelled" : "failed");
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
      activity?.finish(running.reason === "STOPPED" ? "stopped" : running.reason === "SHUTDOWN" ? "interrupted" : "failed");
      await finishStatus(running, sourceSpaceId, running.reason ? "cancelled" : "failed");
      return { status: "failed" as const, text: "" };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", aborted);
      unsubscribe?.();
      try {
        running.session?.dispose();
      } finally {
        activity?.close();
        flushNotifications();
        active = undefined;
        release();
      }
    }
  };
  return {
    sessionId: () => historyPort.sessionId?.() ?? dependencies.spaceId ?? "local-main",
    executionStatus,
    activities: () => dependencies.activities?.details() ?? [],
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
