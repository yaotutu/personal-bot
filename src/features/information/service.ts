import { randomUUID } from "node:crypto";
import { projectFeedback } from "../messages/service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { InformationError } from "./errors.js";
import { parseInformationResult } from "./result.js";
import type {
  InformationFeedbackExample,
  InformationInputItem,
  InformationItem,
  InformationItemStatus,
  InformationModelInput,
  InformationModelResult,
  InformationPreferences,
  InformationRepository,
  InformationRun,
  InformationSettings,
  InformationState,
} from "./types.js";

export const MAX_INFORMATION_ITEMS_PER_BATCH = 20;
export const MAX_INFORMATION_BATCH_CHARS = 60_000;
const MAX_FEEDBACK_EXAMPLES = 10;
const MAX_FEEDBACK_ITEMS = 20;
const MAX_FEEDBACK_COMMENTS = 5;
const FEEDBACK_TEXT_LENGTH = 1000;
const FEEDBACK_CONTENT_LENGTH = 2000;
const ITEM_STATUSES = new Set<InformationItemStatus>(["pending", "processing", "processed", "failed"]);
const RUN_STATUSES = new Set<InformationRun["status"]>(["running", "completed", "failed", "cancelled"]);

type ActiveSlot = {
  spaceId: string;
  controller: AbortController;
  done: Promise<void>;
  release: () => void;
};

type SpacePause = {
  stopped: Promise<void>;
  resume: () => void;
};

type Cursor = { id: string; at: string; status?: string };

export type InformationServiceDependencies = {
  repository: InformationRepository;
  spaceExists: (spaceId: string) => Promise<boolean>;
  retainSpace: (spaceId: string) => Promise<{
    conversation: {
      sessionId: () => string;
      notify: (
        text: string,
        id: string,
        options?: { signal?: AbortSignal },
      ) => Promise<{ sessionId: string; messageId: string }>;
    };
    release: () => void;
  } | undefined>;
  feedback: MessageFeedbackRepository;
  runModel: (input: InformationModelInput, signal: AbortSignal) => Promise<InformationModelResult>;
  readInstructions: (spaceId: string) => Promise<string>;
  enabledSkillTexts: (spaceId: string) => Promise<string[]>;
};

const now = () => new Date().toISOString();
const keyOf = (source: string, externalId: string) => `${source}\0${externalId}`;
const sortedItems = (items: readonly InformationItem[]) =>
  [...items].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
const sortedRuns = (runs: readonly InformationRun[]) =>
  [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decodeCursor = (value: string): Cursor | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.id !== "string" || typeof parsed.at !== "string") return undefined;
    if (parsed.status !== undefined && typeof parsed.status !== "string") return undefined;
    return { id: parsed.id, at: parsed.at, ...(parsed.status === undefined ? {} : { status: parsed.status }) };
  } catch {
    return undefined;
  }
};
const validId = (value: string | undefined, label: string): string => {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InformationError("INVALID_INPUT", `Invalid information ${label}`);
  }
  return value;
};
const sameNewInput = (left: InformationInputItem, right: InformationInputItem) =>
  left.content === right.content &&
  (left.title ?? null) === (right.title ?? null) &&
  (left.receivedAt ?? null) === (right.receivedAt ?? null);
const matchesStoredInput = (stored: InformationItem, input: InformationInputItem) =>
  stored.content === input.content &&
  (stored.title ?? null) === (input.title ?? null) &&
  (input.receivedAt === undefined || input.receivedAt === stored.receivedAt);

/** 信息域服务：持久化输入与执行事实，但执行轮本身完全交给 pi SDK runner。 */
export const createInformationService = (deps: InformationServiceDependencies) => {
  let active: ActiveSlot | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pausedSpaceCounts = new Map<string, number>();

  // 全局执行槽必须在第一个 await 前同步占住，手动/自动争用不会重复 claim。
  const reserveSlot = (spaceId: string): ActiveSlot => {
    if (closed) throw new InformationError("SHUTDOWN", "Information processing is closing");
    if (active) throw new InformationError("BUSY", "Another information run is active");
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const slot: ActiveSlot = {
      spaceId,
      controller,
      done,
      release: () => {
        if (active === slot) active = undefined;
        release();
      },
    };
    active = slot;
    return slot;
  };
  const requireOpen = () => {
    if (closed) throw new InformationError("SHUTDOWN", "Information processing is closing");
  };
  const isPaused = (spaceId: string) => pausedSpaceCounts.has(spaceId);
  const requireSpace = async (spaceId: string) => {
    if (!(await deps.spaceExists(spaceId))) throw new InformationError("SPACE_NOT_FOUND", "Space not found");
  };
  const page = <T extends { id: string }>(
    values: readonly T[],
    cursorAt: (value: T) => string,
    limit: number,
    cursor?: string,
    scope?: string,
  ) => {
    let after: Cursor | undefined;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after || after.status !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid information cursor");
      }
    }
    const filtered = after
      ? values.filter((value) => {
        const at = cursorAt(value);
        return at < after!.at || (at === after!.at && value.id < after!.id);
      })
      : [...values];
    const selected = filtered.slice(0, limit);
    // 游标指向本页最后一条已返回记录，避免用未返回项造成下一页跳过。
    const last = selected.at(-1);
    return {
      values: selected,
      nextCursor: selected.length === limit && last
        ? encodeCursor({ id: last.id, at: cursorAt(last), ...(scope ? { status: scope } : {}) })
        : undefined,
    };
  };

  const getSettings = async (spaceId: string) => {
    await requireSpace(spaceId);
    return (await deps.repository.read(spaceId)).settings;
  };
  const saveSettings = async (spaceId: string, settings: InformationSettings) => {
    requireOpen();
    await requireSpace(spaceId);
    return deps.repository.update(spaceId, (state) => ({
      state: { ...state, settings },
      result: settings,
    }), { allowCreate: true });
  };

  const feedbackExamples = async (
    spaceId: string,
    state: InformationState,
    sessionId: string,
  ): Promise<InformationFeedbackExample[]> => {
    const candidates = sortedRuns(state.runs).flatMap((run) =>
      run.publications
        .filter((publication) => publication.status === "published" && publication.receipt?.sessionId === sessionId)
        .map((publication) => ({ run, publication })),
    );
    if (!candidates.length) return [];
    // 反馈文件缺失是合法空反馈；损坏/I/O 失败必须暴露，不能伪装成无偏好。
    const document = await deps.feedback.read(spaceId, sessionId);
    const examples: InformationFeedbackExample[] = [];
    for (const { run, publication } of candidates) {
      const feedback = projectFeedback(document, publication.receipt!.messageId);
      if (!feedback.reaction && !feedback.comments.length) continue;
      const comments = feedback.comments.slice(0, MAX_FEEDBACK_COMMENTS);
      const itemById = new Map(state.items.map((item) => [item.id, item]));
      examples.push({
        runId: run.id,
        notificationId: publication.notificationId,
        text: publication.text.slice(0, FEEDBACK_TEXT_LENGTH),
        reaction: feedback.reaction,
        comments: comments.map((comment) => comment.text.slice(0, FEEDBACK_TEXT_LENGTH)),
        commentsTruncated: feedback.comments.length > MAX_FEEDBACK_COMMENTS ||
          feedback.comments.some((comment) => comment.text.length > FEEDBACK_TEXT_LENGTH),
        items: publication.itemIds.slice(0, MAX_FEEDBACK_ITEMS).map((itemId) => {
          const item = itemById.get(itemId);
          return {
            id: itemId,
            source: item?.source ?? "unknown",
            ...(item?.title ? { title: item.title.slice(0, FEEDBACK_TEXT_LENGTH) } : {}),
            content: (item?.content ?? "").slice(0, FEEDBACK_CONTENT_LENGTH),
            contentTruncated: (item?.content.length ?? 0) > FEEDBACK_CONTENT_LENGTH,
          };
        }),
      });
      if (examples.length >= MAX_FEEDBACK_EXAMPLES) break;
    }
    return examples;
  };
  const getPreferences = async (spaceId: string) => {
    await requireSpace(spaceId);
    const state = await deps.repository.read(spaceId);
    const retained = await deps.retainSpace(spaceId);
    if (!retained) return { notes: state.preferences.notes, feedbackExamples: [] };
    try {
      return {
        notes: state.preferences.notes,
        feedbackExamples: await feedbackExamples(spaceId, state, retained.conversation.sessionId()),
      };
    } finally {
      retained.release();
    }
  };
  const savePreferences = async (spaceId: string, preferences: InformationPreferences) => {
    requireOpen();
    await requireSpace(spaceId);
    return deps.repository.update(spaceId, (state) => ({
      state: { ...state, preferences },
      result: preferences,
    }), { allowCreate: true });
  };

  const ingest = async (spaceId: string, inputs: readonly InformationInputItem[]) => {
    requireOpen();
    await requireSpace(spaceId);
    const state = await deps.repository.read(spaceId);
    if (!state.settings.enabled) throw new InformationError("DISABLED", "Information ingestion is disabled");
    return deps.repository.update(spaceId, (current) => {
      if (!current.settings.enabled) throw new InformationError("DISABLED", "Information ingestion is disabled");
      const acceptedAt = now();
      const existing = new Map(current.items.map((item) => [keyOf(item.source, item.externalId), item]));
      const batch = new Map<string, InformationInputItem & { id: string }>();
      const returned: InformationItem[] = [];
      for (const input of inputs) {
        const key = keyOf(input.source, input.externalId);
        const stored = existing.get(key);
        if (stored) {
          if (!matchesStoredInput(stored, input)) {
            throw new InformationError("CONFLICT", "Information source and externalId conflict with existing content");
          }
          if (!returned.some((item) => keyOf(item.source, item.externalId) === key)) returned.push(stored);
          continue;
        }
        const previous = batch.get(key);
        if (previous) {
          if (!sameNewInput(previous, input)) {
            throw new InformationError("CONFLICT", "Duplicate information key has different content");
          }
          continue;
        }
        batch.set(key, { ...input, id: `info_${randomUUID()}` });
      }
      const planned = [...batch.entries()].map(([key, input]) => {
        const item: InformationItem = {
          id: input.id,
          spaceId,
          source: input.source,
          externalId: input.externalId,
          ...(input.title ? { title: input.title } : {}),
          content: input.content,
          receivedAt: input.receivedAt ?? acceptedAt,
          acceptedAt,
          status: "pending",
        };
        void key;
        returned.push(item);
        return item;
      });
      return {
        state: { ...current, items: [...current.items, ...planned] },
        result: returned,
      };
    }, { allowCreate: true });
  };

  const listItems = async (spaceId: string, options: { status?: string; limit?: number; cursor?: string }) => {
    await requireSpace(spaceId);
    const status = options.status;
    if (status !== undefined && !ITEM_STATUSES.has(status as InformationItemStatus)) {
      throw new InformationError("INVALID_INPUT", "Invalid information item status");
    }
    const values = sortedItems((await deps.repository.read(spaceId)).items)
      .filter((item) => !status || item.status === status);
    const result = page(values, (item) => item.acceptedAt, options.limit ?? 20, options.cursor, status);
    return { items: result.values, nextCursor: result.nextCursor };
  };
  const getItem = async (spaceId: string, rawItemId: string) => {
    await requireSpace(spaceId);
    const itemId = validId(rawItemId, "itemId");
    const state = await deps.repository.read(spaceId);
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new InformationError("NOT_FOUND", "Information item not found");
    return { item, runs: sortedRuns(state.runs.filter((run) => run.itemIds.includes(itemId))) };
  };
  const listRuns = async (spaceId: string, options: { status?: string; limit?: number; cursor?: string }) => {
    await requireSpace(spaceId);
    const status = options.status;
    if (status !== undefined && !RUN_STATUSES.has(status as InformationRun["status"])) {
      throw new InformationError("INVALID_INPUT", "Invalid information run status");
    }
    const values = sortedRuns((await deps.repository.read(spaceId)).runs)
      .filter((run) => !status || run.status === status);
    const result = page(values, (run) => run.createdAt, options.limit ?? 20, options.cursor, status);
    return { runs: result.values, nextCursor: result.nextCursor };
  };
  const getRun = async (spaceId: string, rawRunId: string) => {
    await requireSpace(spaceId);
    const runId = validId(rawRunId, "runId");
    const state = await deps.repository.read(spaceId);
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new InformationError("NOT_FOUND", "Information run not found");
    return {
      run,
      items: run.itemIds.map((itemId) => state.items.find((item) => item.id === itemId))
        .filter((item): item is InformationItem => Boolean(item)),
    };
  };

  const claim = async (spaceId: string, force: boolean) =>
    deps.repository.update(spaceId, (state) => {
      if (isPaused(spaceId)) return { result: undefined as InformationRun | undefined };
      if (!state.settings.enabled) return { result: undefined as InformationRun | undefined };
      const pending = [...state.items]
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
      const first = pending[0];
      if (!first) return { result: undefined };
      if (!force && Date.now() < Date.parse(first.acceptedAt) + state.settings.batchWindowSeconds * 1000) {
        return { result: undefined };
      }
      const selected: InformationItem[] = [];
      let chars = 0;
      for (const item of pending) {
        if (selected.length >= MAX_INFORMATION_ITEMS_PER_BATCH) break;
        if (selected.length && chars + item.content.length > MAX_INFORMATION_BATCH_CHARS) continue;
        selected.push(item);
        chars += item.content.length;
      }
      const nowText = now();
      const run: InformationRun = {
        id: `inforun_${randomUUID()}`,
        spaceId,
        itemIds: selected.map((item) => item.id),
        status: "running",
        createdAt: nowText,
        startedAt: nowText,
        publications: [],
      };
      const selectedIds = new Set(run.itemIds);
      return {
        state: {
          ...state,
          items: state.items.map((item) => selectedIds.has(item.id)
            ? { ...item, status: "processing" as const, runId: run.id }
            : item),
          runs: [...state.runs, run],
        },
        result: run,
      };
    });

  const failRun = async (spaceId: string, runId: string, error: string, cancelled = false) =>
    deps.repository.update(spaceId, (state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "running") return { result: undefined };
      const finishedAt = now();
      return {
        state: {
          ...state,
          items: state.items.map((item) => item.runId === runId && item.status === "processing"
            ? { ...item, status: "failed" }
            : item),
          runs: state.runs.map((candidate) => candidate.id === runId
            ? {
              ...candidate,
              status: cancelled ? "cancelled" as const : "failed" as const,
              finishedAt,
              model: { status: "failed" as const, error },
            }
            : candidate),
        },
        result: undefined,
      };
    });

  const markPublication = async (
    spaceId: string,
    runId: string,
    notificationId: string,
    outcome: { status: "published"; receipt: { sessionId: string; messageId: string } } | { status: "failed"; error: string },
  ) => deps.repository.update(spaceId, (state) => ({
    state: {
      ...state,
      runs: state.runs.map((run) => run.id !== runId ? run : {
        ...run,
        publications: run.publications.map((publication) => publication.notificationId !== notificationId
          ? publication
          : outcome.status === "published"
            ? { ...publication, status: "published", receipt: { ...outcome.receipt, notificationId } }
            : { ...publication, status: "failed", error: outcome.error }),
      }),
    },
    result: undefined,
  }));

  const process = async (slot: ActiveSlot, claimed: InformationRun) => {
    const { controller } = slot;
    let retained: Awaited<ReturnType<typeof deps.retainSpace>> | undefined;
    try {
      controller.signal.throwIfAborted();
      retained = await deps.retainSpace(claimed.spaceId);
      controller.signal.throwIfAborted();
      if (!retained) {
        await failRun(claimed.spaceId, claimed.id, "Target space disappeared", true);
        return;
      }
      {
        const targetSessionId = retained.conversation.sessionId();
        const state = await deps.repository.read(claimed.spaceId);
        const items = claimed.itemIds
          .map((id) => state.items.find((item) => item.id === id))
          .filter((item): item is InformationItem => Boolean(item));
        const input: InformationModelInput = {
          spaceId: claimed.spaceId,
          runId: claimed.id,
          instructions: await deps.readInstructions(claimed.spaceId),
          enabledSkillTexts: await deps.enabledSkillTexts(claimed.spaceId),
          preferences: state.preferences,
          items: items.map(({ id, source, externalId, title, content, receivedAt }) => ({
            id, source, externalId, ...(title ? { title } : {}), content, receivedAt,
          })),
          feedbackExamples: await feedbackExamples(claimed.spaceId, state, targetSessionId),
        };
        controller.signal.throwIfAborted();
        const result = await deps.runModel(input, controller.signal);
        if (!result.ok) {
          await failRun(claimed.spaceId, claimed.id, result.error, result.error === "CANCELLED");
          return;
        }
        let parsed: ReturnType<typeof parseInformationResult>;
        try {
          parsed = parseInformationResult(result.result, claimed.itemIds);
        } catch {
          await failRun(claimed.spaceId, claimed.id, "INVALID_MODEL_RESULT");
          return;
        }
        // 模型已成功时先保留这个事实；若取消/目标会话已变化，只把投递标失败，不重跑模型。
        const deliveryCancelled = controller.signal.aborted ||
          retained.conversation.sessionId() !== targetSessionId;
        const deliveryError = controller.signal.aborted
          ? "Cancelled before notification delivery"
          : "Target session changed before notification delivery";
        await deps.repository.update(claimed.spaceId, (current) => {
          const run = current.runs.find((candidate) => candidate.id === claimed.id);
          if (!run || run.status !== "running") return { result: undefined };
          const publications = parsed.notifications.map((notification, index) => ({
            notificationId: `info-notification-${claimed.id}-${index}`,
            itemIds: notification.itemIds,
            text: notification.text,
            status: deliveryCancelled ? "failed" as const : "pending" as const,
            ...(deliveryCancelled ? { error: deliveryError } : {}),
          }));
          return {
            state: {
              ...current,
              items: current.items.map((item) => item.runId === claimed.id && item.status === "processing"
                ? { ...item, status: "processed" as const }
                : item),
              runs: current.runs.map((candidate) => candidate.id === claimed.id
                ? {
                  ...candidate,
                  status: "completed" as const,
                  finishedAt: now(),
                  model: { status: "succeeded" as const },
                  decisions: parsed.decisions,
                  publications,
                }
                : candidate),
            },
            result: undefined,
          };
        });
        if (deliveryCancelled) return;
        const completed = await deps.repository.read(claimed.spaceId);
        const run = completed.runs.find((candidate) => candidate.id === claimed.id);
        for (const publication of run?.publications ?? []) {
          const settingsNow = await deps.repository.read(claimed.spaceId);
          if (!settingsNow.settings.enabled) {
            await markPublication(claimed.spaceId, claimed.id, publication.notificationId, {
              status: "failed", error: "Information processing disabled before notification delivery",
            });
            continue;
          }
          if (controller.signal.aborted) {
            await markPublication(claimed.spaceId, claimed.id, publication.notificationId, {
              status: "failed", error: "Cancelled before notification delivery",
            });
            continue;
          }
          if (retained.conversation.sessionId() !== targetSessionId) {
            await markPublication(claimed.spaceId, claimed.id, publication.notificationId, {
              status: "failed", error: "Target session changed before notification delivery",
            });
            continue;
          }
          try {
            const receipt = await retained.conversation.notify(
              publication.text,
              publication.notificationId,
              { signal: controller.signal },
            );
            await markPublication(claimed.spaceId, claimed.id, publication.notificationId, {
              status: "published", receipt,
            });
          } catch {
            await markPublication(claimed.spaceId, claimed.id, publication.notificationId, {
              status: "failed", error: controller.signal.aborted
                ? "Cancelled before notification delivery"
                : "Notification delivery failed",
            });
          }
        }
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error && error.message === "Notification cancelled"
        ? "Cancelled before notification delivery"
        : cancelled ? "CANCELLED" : "Information processing failed";
      await failRun(claimed.spaceId, claimed.id, message, cancelled).catch(() => undefined);
      // 取消是已接纳 run 的正常终态：runNow 继续读回 cancelled 记录，不能把 AbortError 冒成 HTTP 500。
      if (!cancelled && (!(error instanceof InformationError) || error.code !== "SHUTDOWN")) throw error;
    } finally {
      retained?.release();
      slot.release();
    }
  };

  const runNow = async (spaceId: string) => {
    requireOpen();
    if (isPaused(spaceId)) throw new InformationError("SPACE_PAUSED", "Space lifecycle is changing");
    const slot = reserveSlot(spaceId);
    try {
      await requireSpace(spaceId);
      const state = await deps.repository.read(spaceId);
      if (!state.settings.enabled) throw new InformationError("DISABLED", "Information processing is disabled");
      if (!state.items.some((item) => item.status === "pending")) {
        throw new InformationError("NO_PENDING", "No pending information");
      }
      const claimed = await claim(spaceId, true);
      if (!claimed) throw new InformationError("NO_PENDING", "No pending information");
      await process(slot, claimed);
      return getRun(spaceId, claimed.id);
    } finally {
      slot.release();
    }
  };
  const runDue = (spaceId: string) => {
    if (closed || active || isPaused(spaceId)) return Promise.resolve(false);
    const slot = reserveSlot(spaceId);
    let processStarted = false;
    return (async () => {
      try {
        if (isPaused(spaceId)) return false;
        const claimed = await claim(spaceId, false);
        if (!claimed) return false;
        processStarted = true;
        void process(slot, claimed).catch(() => undefined);
        return true;
      } finally {
        // process 接管后负责释放；未到期/无待处理在这里立即释放全局槽。
        if (!processStarted) slot.release();
      }
    })();
  };
  const nextDueSpace = async () => {
    const spaceIds = await deps.repository.listSpaceIds();
    for (const spaceId of spaceIds) {
      if (!(await deps.spaceExists(spaceId))) continue;
      const state = await deps.repository.read(spaceId);
      if (!state.settings.enabled) continue;
      if (isPaused(spaceId)) continue;
      const first = state.items
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id))[0];
      if (first && Date.now() >= Date.parse(first.acceptedAt) + state.settings.batchWindowSeconds * 1000) return spaceId;
    }
    return undefined;
  };

  const query = async (input: {
    spaceId: string;
    action: "overview" | "items" | "item" | "runs" | "run" | "preferences";
    status?: string;
    limit?: number;
    cursor?: string;
    itemId?: string;
    runId?: string;
  }) => {
    if (input.action === "overview") {
      const settings = await getSettings(input.spaceId);
      const preferences = await getPreferences(input.spaceId);
      const items = await listItems(input.spaceId, { limit: 5 });
      const runs = await listRuns(input.spaceId, { limit: 5 });
      return { settings, preferences, items, runs };
    }
    if (input.action === "preferences") return getPreferences(input.spaceId);
    if (input.action === "item") return getItem(input.spaceId, input.itemId ?? "");
    if (input.action === "run") return getRun(input.spaceId, input.runId ?? "");
    if (input.action === "items") return listItems(input.spaceId, { status: input.status, limit: input.limit, cursor: input.cursor });
    return listRuns(input.spaceId, { status: input.status, limit: input.limit, cursor: input.cursor });
  };

  const cancelSpace = async (spaceId: string) => {
    const current = active;
    if (current?.spaceId === spaceId) {
      abortQuietly(current.controller);
      await current.done;
    }
  };
  const abortQuietly = (controller: AbortController) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(new Error("Information processing cancelled"));
    } catch (error) {
      // 本项目只需要进入 aborted 状态；abort 分发本身不能让生命周期路由失败。
      void error;
    }
  };
  /** 同步暂停新后台轮并等待旧轮退出；嵌套调用用引用计数收口。 */
  const pauseSpace = (spaceId: string): SpacePause => {
    const count = (pausedSpaceCounts.get(spaceId) ?? 0) + 1;
    pausedSpaceCounts.set(spaceId, count);
    const current = active?.spaceId === spaceId ? active : undefined;
    if (current) abortQuietly(current.controller);
    let resumed = false;
    return {
      stopped: current ? current.done.then(() => undefined) : Promise.resolve(),
      resume: () => {
        if (resumed) return;
        resumed = true;
        const next = (pausedSpaceCounts.get(spaceId) ?? 1) - 1;
        if (next > 0) pausedSpaceCounts.set(spaceId, next);
        else pausedSpaceCounts.delete(spaceId);
      },
    };
  };
  const removeSpace = async (spaceId: string) => {
    requireOpen();
    await cancelSpace(spaceId);
    await deps.repository.removeSpace(spaceId);
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    const current = active;
    if (current) abortQuietly(current.controller);
    closing = (async () => { if (current) await current.done; })();
    return closing;
  };

  return {
    getSettings,
    saveSettings,
    getPreferences,
    savePreferences,
    ingest,
    listItems,
    getItem,
    listRuns,
    getRun,
    runNow,
    runDue,
    nextDueSpace,
    query,
    cancelSpace,
    pauseSpace,
    removeSpace,
    close,
  };
};

export type InformationService = Awaited<ReturnType<typeof createInformationService>>;
