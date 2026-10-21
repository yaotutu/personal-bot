import { randomUUID } from "node:crypto";
import { MemoryLimitError, type MemoryService } from "../memory/memory-service.js";
import {
  buildDreamInput,
  composePrompt,
  DEFAULT_DREAM_PROMPT,
  fixedRules,
  INSTRUCTIONS_LIMIT,
} from "./prompt.js";
import {
  appendInstructions,
  appendNote,
  planProposal,
  readPurpose,
  type ProposedChange,
} from "./proposal.js";
import { purposeChanged } from "./purpose.js";
import type {
  DreamMessage,
  DreamPending,
  DreamRepository,
  DreamRunStatus,
  DreamState,
  DreamTarget,
} from "./types.js";
import { sliceWindow, splitBatches } from "./window.js";

export type DreamNotesPort = {
  readUser: () => Promise<string>;
  writeUser: (content: string) => Promise<void>;
  writeUserIfUnchanged: (content: string, expected: string) => Promise<boolean>;
  readSoul: () => Promise<string>;
  writeSoul: (content: string) => Promise<void>;
  writeSoulIfUnchanged: (content: string, expected: string) => Promise<boolean>;
  readInstructions: (spaceId: string) => Promise<string>;
  writeInstructions: (spaceId: string, content: string) => Promise<void>;
  writeInstructionsIfUnchanged: (
    spaceId: string,
    content: string,
    expected: string,
  ) => Promise<boolean>;
};

export type DreamPromptsPort = {
  readGlobalPrompt: () => Promise<string>;
  writeGlobalPrompt: (content: string) => Promise<void>;
  readSpacePrompt: (spaceId: string) => Promise<string>;
  writeSpacePrompt: (spaceId: string, content: string) => Promise<void>;
};

export type DreamConversationsPort = {
  listSpaceIds?: () => Promise<string[]>;
  listThreadIds?: () => Promise<string[]>;
  spaceExists?: (spaceId: string) => Promise<boolean>;
  threadExists?: (spaceId: string) => Promise<boolean>;
  isSpaceBusy?: (spaceId: string) => Promise<boolean>;
  isThreadBusy?: (spaceId: string) => Promise<boolean>;
  readTranscript: (
    spaceId: string,
  ) => Promise<{ messages: DreamMessage[]; summary?: string }>;
};

export type DreamProposeResult =
  | { ok: true; changes: ProposedChange[] }
  | { ok: false; error: string };

export type DreamDependencies = {
  repository: DreamRepository & DreamPromptsPort & { reconcileOnStart: () => Promise<void> };
  notes: DreamNotesPort;
  memory: Pick<MemoryService, "list" | "add" | "edit" | "forget">;
  conversations: DreamConversationsPort;
  propose: (input: {
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
  }) => Promise<DreamProposeResult>;
};

export type DreamSpaceView = DreamState & {
  spaceId: string;
  threadId?: string;
  prompt: string;
  purpose: string;
};

export type DreamOverview = {
  globalPrompt: string;
  defaultPrompt: string;
  intervalHours: number;
  running: boolean;
  spaces: DreamSpaceView[];
  threads: DreamSpaceView[];
};

export type DreamRunResult =
  | { ok: true; state: DreamSpaceView }
  | { ok: false; code: "not_found" | "conflict"; message: string };

export type DreamResolveResult =
  | { ok: true; state: DreamSpaceView }
  | { ok: false; code: "not_found" | "conflict"; message: string };

/** 固定 2 小时周期（毫秒），写成常量，不支持逐空间自定义间隔。 */
export const DREAM_INTERVAL_HOURS = 2;
export const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1_000;
const PENDING_LIMIT = 50;

/**
 * Dream 后台记忆整理业务服务：
 * - 进程内串行执行，避免多空间同时跑整理轮互相覆盖全局 USER/SOUL/memory；
 * - 游标只在整轮成功后推进，失败不动；
 * - 写入前比对读取时的文本版本，不覆盖用户在整理期间的新改动；
 * - 空间在整理期间被删除时停止提交，绝不因写 dream.json 或 INSTRUCTIONS.md 重建空间。
 */
export const createDreamService = (deps: DreamDependencies) => {
  const { repository, notes, memory, conversations, propose } = deps;
  let activeRun: { spaceId: string; abort: () => void; done: Promise<void> } | undefined;
  let closed = false;
  const checkSpaceExists = (id: string): Promise<boolean> => {
    const fn = conversations.spaceExists ?? conversations.threadExists;
    return fn ? fn(id) : Promise.resolve(true);
  };
  const checkSpaceBusy = (id: string): Promise<boolean> => {
    const fn = conversations.isSpaceBusy ?? conversations.isThreadBusy;
    return fn ? fn(id) : Promise.resolve(false);
  };
  const listSpaceIds = (): Promise<string[]> => {
    const fn = conversations.listSpaceIds ?? conversations.listThreadIds;
    return fn ? fn() : Promise.resolve([]);
  };

  const describeSpace = async (spaceId: string): Promise<DreamSpaceView> => {
    const [state, prompt, instructions] = await Promise.all([
      repository.read(spaceId),
      repository.readSpacePrompt(spaceId),
      notes.readInstructions(spaceId),
    ]);
    return {
      ...state,
      spaceId,
      threadId: spaceId,
      prompt,
      purpose: readPurpose(instructions),
    };
  };

  const describeAll = async (): Promise<DreamOverview> => {
    const [globalPrompt, spaceIds] = await Promise.all([
      repository.readGlobalPrompt(),
      listSpaceIds(),
    ]);
    const spaces = await Promise.all(spaceIds.map((id) => describeSpace(id)));
    return {
      globalPrompt,
      defaultPrompt: DEFAULT_DREAM_PROMPT,
      intervalHours: DREAM_INTERVAL_HOURS,
      running: Boolean(activeRun),
      spaces,
      threads: spaces,
    };
  };

  /** 执行单个空间的一轮整理；manual=false（定时扫描）在无新消息时静默跳过，不落盘。 */
  const executeSpace = async (
    spaceId: string,
    manual: boolean,
    outerSignal?: AbortSignal,
  ): Promise<DreamRunResult> => {
    if (closed || outerSignal?.aborted) {
      return { ok: false, code: "conflict", message: "Dream service is closing" };
    }
    if (activeRun) {
      return { ok: false, code: "conflict", message: "A Dream consolidation is already running" };
    }
    if (!(await checkSpaceExists(spaceId))) {
      return { ok: false, code: "not_found", message: "Space not found" };
    }
    if (await checkSpaceBusy(spaceId)) {
      return {
        ok: false,
        code: "conflict",
        message: "Wait for the current conversation response to finish before consolidating",
      };
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
    let finishRun!: () => void;
    activeRun = {
      spaceId,
      abort: () => controller.abort(),
      done: new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
    };

    try {
      const initial = await repository.read(spaceId);
      const transcript = await conversations.readTranscript(spaceId);
      const window = sliceWindow(transcript.messages, initial.cursor, transcript.summary);
      const startedAt = new Date().toISOString();

      if (!window.fresh.length) {
        if (manual && (await checkSpaceExists(spaceId))) {
          await repository.update(spaceId, (state) => ({
            state: {
              ...state,
              lastRun: { at: startedAt, status: "completed", changed: [], processed: 0 },
            },
            result: undefined,
          }), { allowCreate: false });
        }
        return { ok: true, state: await describeSpace(spaceId) };
      }

      // 崩溃保护：调用模型前先落盘 running，若进程中途崩溃，下次启动会诚实改为 failed。
      await repository.update(spaceId, (state) => ({
        state: {
          ...state,
          lastRun: {
            at: startedAt,
            status: "running",
            changed: [],
            processed: window.fresh.length,
          },
        },
        result: undefined,
      }), { allowCreate: false });

      const batches = splitBatches(window);
      const changed = new Set<DreamTarget>();
      const addedPending: DreamPending[] = [];
      let hadFailure = false;
      let failureMessage: string | undefined;
      const fail = (message: string) => {
        hadFailure = true;
        failureMessage ??= message;
      };

      for (const batch of batches) {
        if (controller.signal.aborted || closed) {
          fail("Consolidation cancelled");
          break;
        }
        if (!(await checkSpaceExists(spaceId))) {
          return { ok: false, code: "not_found", message: "Space not found" };
        }
        if (await checkSpaceBusy(spaceId)) {
          fail("Conversation became busy during consolidation");
          break;
        }

        const [state, globalPrompt, sessionPrompt, user, soul, instructions, memories] =
          await Promise.all([
            repository.read(spaceId),
            repository.readGlobalPrompt(),
            repository.readSpacePrompt(spaceId),
            notes.readUser(),
            notes.readSoul(),
            notes.readInstructions(spaceId),
            memory.list(),
          ]);
        const purpose = readPurpose(instructions);
        const isMain = spaceId === "local-main";
        const systemPrompt =
          composePrompt({
            global: globalPrompt,
            session: sessionPrompt,
            inherit: state.inheritGlobalPrompt,
          }) +
          "\n\n" +
          fixedRules(purpose, isMain);
        const userPrompt = buildDreamInput(batch, {
          user,
          soul,
          instructions,
          memories: memories.map((item) => ({ id: item.id, text: item.text })),
        });

        const proposed = await propose({
          systemPrompt,
          userPrompt,
          signal: controller.signal,
        });
        if (!proposed.ok) {
          fail(proposed.error);
          break;
        }
        if (controller.signal.aborted || closed) {
          fail("Consolidation cancelled");
          break;
        }
        if (!(await checkSpaceExists(spaceId))) {
          return { ok: false, code: "not_found", message: "Space not found" };
        }

        const plan = planProposal(proposed.changes, {
          isMain,
          hasPurpose: Boolean(purpose),
          existingMemoryIds: new Set(memories.map((item) => item.id)),
          instructions,
        });

        // 1. USER.md：合并本批全部 user 建议后做一次条件写入，版本不符则放弃覆盖。
        let nextUser = user;
        for (const item of plan.apply) {
          if (item.target === "user") nextUser = appendNote(nextUser, item.text);
        }
        if (nextUser !== user) {
          const ok = await notes.writeUserIfUnchanged(nextUser, user);
          if (ok) changed.add("user");
          else fail("USER.md was modified concurrently; skipped overwriting");
        }

        // 2. SOUL.md：同理按读取版本条件写入。
        let nextSoul = soul;
        for (const item of plan.apply) {
          if (item.target === "soul") nextSoul = appendNote(nextSoul, item.text);
        }
        if (nextSoul !== soul) {
          const ok = await notes.writeSoulIfUnchanged(nextSoul, soul);
          if (ok) changed.add("soul");
          else fail("SOUL.md was modified concurrently; skipped overwriting");
        }

        // 3. INSTRUCTIONS.md：提交前再次核查会话仍存在、用途段未变且未超上限。
        let nextInstructions = instructions;
        for (const item of plan.apply) {
          if (item.target === "instructions") {
            nextInstructions = appendInstructions(nextInstructions, item.text);
          }
        }
        if (nextInstructions !== instructions) {
          if (
            purposeChanged(instructions, nextInstructions) ||
            nextInstructions.length > INSTRUCTIONS_LIMIT
          ) {
            fail("Instructions change rejected by safety check");
          } else if (await checkSpaceExists(spaceId)) {
            const ok = await notes.writeInstructionsIfUnchanged(
              spaceId,
              nextInstructions,
              instructions,
            );
            if (ok) changed.add("instructions");
            else fail("INSTRUCTIONS.md was modified concurrently; skipped overwriting");
          }
        }

        // 4. memory.json：走同一个 MemoryService，按文本去重，上限错误记录为受控失败。
        const existingMemoryTexts = new Set(
          memories.map((entry) => entry.text.replace(/\s+/g, " ").trim()),
        );
        for (const item of plan.apply) {
          if (item.target !== "memory") continue;
          try {
            if (item.op === "add") {
              const normalized = item.text.replace(/\s+/g, " ").trim();
              if (existingMemoryTexts.has(normalized)) continue;
              existingMemoryTexts.add(normalized);
              await memory.add(item.text, `dream:${spaceId}`);
              changed.add("memory");
            } else if (item.op === "edit") {
              if (await memory.edit(item.id, item.text)) changed.add("memory");
            } else if (item.op === "delete") {
              if (await memory.forget(item.id)) changed.add("memory");
            }
          } catch (error) {
            fail(
              error instanceof MemoryLimitError
                ? error.message
                : "Failed to update long-term memory",
            );
          }
        }

        const now = new Date().toISOString();
        for (const item of plan.pending) {
          addedPending.push({ ...item, id: randomUUID(), createdAt: now });
        }
      }

      if (!(await checkSpaceExists(spaceId))) {
        return { ok: false, code: "not_found", message: "Space not found" };
      }

      const status: DreamRunStatus = !hadFailure
        ? "completed"
        : changed.size > 0 || addedPending.length > 0
          ? "partial"
          : "failed";

      await repository.update(spaceId, (state) => {
        const seen = new Set(
          state.pending.map((item) => `${item.suggestedTarget}:${item.text}`),
        );
        const mergedPending = [...state.pending];
        for (const item of addedPending) {
          const key = `${item.suggestedTarget}:${item.text}`;
          if (!seen.has(key) && mergedPending.length < PENDING_LIMIT) {
            seen.add(key);
            mergedPending.push(item);
          }
        }
        return {
          state: {
            ...state,
            // 游标只在整轮成功后推进；失败或部分完成保留原游标，下次从原位置重读。
            cursor: status === "completed" ? (window.lastId ?? state.cursor) : state.cursor,
            lastRun: {
              at: startedAt,
              status,
              changed: [...changed],
              processed: window.fresh.length,
              ...(failureMessage ? { error: failureMessage } : {}),
            },
            pending: mergedPending,
          },
          result: undefined,
        };
      }, { allowCreate: false });

      return { ok: true, state: await describeSpace(spaceId) };
    } finally {
      outerSignal?.removeEventListener("abort", forwardAbort);
      activeRun = undefined;
      finishRun();
    }
  };

  return {
    reconcileOnStart: () => repository.reconcileOnStart(),
    isBusy: () => Boolean(activeRun),
    describeAll,
    describeSpace,
    describeThread: describeSpace,
    saveGlobalPrompt: async (prompt: string) => {
      await repository.writeGlobalPrompt(prompt);
      return describeAll();
    },
    updateSpaceSettings: async (
      spaceId: string,
      patch: { enabled?: boolean; inheritGlobalPrompt?: boolean; prompt?: string },
    ): Promise<DreamSpaceView> => {
      if (patch.prompt !== undefined) {
        await repository.writeSpacePrompt(spaceId, patch.prompt);
      }
      if (patch.enabled !== undefined || patch.inheritGlobalPrompt !== undefined) {
        await repository.update(spaceId, (state) => ({
          state: {
            ...state,
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.inheritGlobalPrompt !== undefined
              ? { inheritGlobalPrompt: patch.inheritGlobalPrompt }
              : {}),
          },
          result: undefined,
        }));
      }
      return describeSpace(spaceId);
    },
    updateThreadSettings(
      spaceId: string,
      patch: { enabled?: boolean; inheritGlobalPrompt?: boolean; prompt?: string },
    ) {
      return this.updateSpaceSettings(spaceId, patch);
    },
    runNow: (spaceId: string, signal?: AbortSignal) => executeSpace(spaceId, true, signal),
    /** 周期调度入口：逐个扫描已启用且有新消息的空间，忙空间直接跳过。 */
    runScheduledTick: async (signal?: AbortSignal) => {
      if (closed || activeRun || signal?.aborted) return;
      const spaceIds = await listSpaceIds();
      for (const spaceId of spaceIds) {
        if (closed || signal?.aborted) return;
        const state = await repository.read(spaceId);
        if (!state.enabled) continue;
        if (await checkSpaceBusy(spaceId)) continue;
        await executeSpace(spaceId, false, signal);
      }
    },
    resolvePending: async (
      spaceId: string,
      pendingId: string,
      decision: { action: "apply"; target?: DreamTarget } | { action: "dismiss" },
    ): Promise<DreamResolveResult> => {
      if (!(await checkSpaceExists(spaceId))) {
        return { ok: false, code: "not_found", message: "Space not found" };
      }
      const state = await repository.read(spaceId);
      const found = state.pending.find((item) => item.id === pendingId);
      if (!found) {
        return { ok: false, code: "not_found", message: "Pending item not found" };
      }
      if (decision.action === "apply") {
        const target = decision.target ?? found.suggestedTarget;
        try {
          if (target === "user") {
            const current = await notes.readUser();
            await notes.writeUser(appendNote(current, found.text));
          } else if (target === "soul") {
            const current = await notes.readSoul();
            await notes.writeSoul(appendNote(current, found.text));
          } else if (target === "instructions") {
            const current = await notes.readInstructions(spaceId);
            const next = appendInstructions(current, found.text);
            if (next.length > 20_000) {
              return { ok: false, code: "conflict", message: "Instructions exceed maximum length" };
            }
            await notes.writeInstructions(spaceId, next);
          } else {
            await memory.add(found.text, `dream:${spaceId}`);
          }
        } catch (error) {
          if (error instanceof MemoryLimitError) {
            return { ok: false, code: "conflict", message: error.message };
          }
          throw error;
        }
      }
      await repository.update(spaceId, (current) => ({
        state: {
          ...current,
          pending: current.pending.filter((item) => item.id !== pendingId),
        },
        result: undefined,
      }), { allowCreate: false });
      return { ok: true, state: await describeSpace(spaceId) };
    },
    /**
     * 重置空间会话时同步清理该空间的 Dream 游标、最近运行与待定建议，
     * 保留 enabled 与 inheritGlobalPrompt 配置；若当前正在整理该空间则先取消并等待收尾。
     */
    resetSpace: async (spaceId: string): Promise<void> => {
      if (activeRun?.spaceId === spaceId) {
        activeRun.abort();
        await activeRun.done;
      }
      await repository.update(
        spaceId,
        (state) => ({
          state: {
            enabled: state.enabled,
            inheritGlobalPrompt: state.inheritGlobalPrompt,
            pending: [],
          },
          result: undefined,
        }),
        { allowCreate: false },
      );
    },
    close: async () => {
      closed = true;
      if (activeRun) {
        activeRun.abort();
        await activeRun.done;
      }
    },
  };
};

export type DreamService = ReturnType<typeof createDreamService>;
