import { mkdir } from "node:fs/promises";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../../config/load-config.js";
import { parseProposal, type ProposedChange } from "../../features/dream/proposal.js";
import type { DreamProposeResult } from "../../features/dream/service.js";
import type { DataLayout } from "../storage/data-layout.js";
import { projectExecutionEvent } from "./execution.js";
import { createResourceLoader } from "./resource-loader.js";

export const PROPOSE_NOTES_TOOL_NAME = "propose_notes";

const targetLiteral = Type.Union([
  Type.Literal("user"),
  Type.Literal("soul"),
  Type.Literal("instructions"),
  Type.Literal("memory"),
  Type.Literal("pending"),
]);

const suggestedLiteral = Type.Union([
  Type.Literal("user"),
  Type.Literal("soul"),
  Type.Literal("instructions"),
  Type.Literal("memory"),
]);

/**
 * Dream 受限整理轮唯一可用的工具：只能提交结构化笔记建议，不能传入文件路径。
 * 每次调用通过 parseProposal 严格校验，通过后记录在当前整理轮内存中。
 */
export const createProposeNotesTool = (
  onAccepted: (changes: ProposedChange[]) => void,
  onInvalid: () => void,
) =>
  defineTool({
    name: PROPOSE_NOTES_TOOL_NAME,
    label: "Propose consolidated notes",
    description:
      "Submit structured note changes for USER, SOUL, INSTRUCTIONS, MEMORY or pending review. " +
      "Call this at most once per turn with all proposed changes; pass an empty array if no changes are needed.",
    parameters: Type.Object(
      {
        changes: Type.Array(
          Type.Object(
            {
              target: targetLiteral,
              op: Type.Optional(
                Type.Union([
                  Type.Literal("add"),
                  Type.Literal("edit"),
                  Type.Literal("delete"),
                ]),
              ),
              id: Type.Optional(Type.String({ description: "Existing memory item id for edit/delete." })),
              suggestedTarget: Type.Optional(suggestedLiteral),
              text: Type.Optional(Type.String({ description: "Concise note text to save." })),
              source: Type.String({ description: "Message id from New messages that justifies this change." }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      const parsed = parseProposal(params);
      if (!parsed) {
        onInvalid();
        return {
          content: [{ type: "text", text: "Invalid proposal schema." }],
          details: { denied: true },
          isError: true,
        };
      }
      onAccepted(parsed);
      return {
        content: [{ type: "text", text: `Accepted ${parsed.length} proposed change(s).` }],
        details: undefined,
      };
    },
  });

/**
 * 通过 createAgentSession 运行受限整理轮：
 * - 使用内存 SessionManager，不产生用户会话 JSONL，不污染来源会话历史；
 * - 不装配用户 skills、extensions、联网、委派或文件读写工具；
 * - 关闭压缩与自动重试，失败诚实返回。
 */
export const createDreamProposer = (deps: {
  config: Config;
  layout: DataLayout;
  modelRuntime: ModelRuntime;
}) => async (input: {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<DreamProposeResult> => {
  const { config, layout, modelRuntime } = deps;
  if (!config.configured || !config.modelId) {
    return { ok: false, error: "Model is not configured" };
  }
  const model = modelRuntime.getModel("personal", config.modelId);
  if (!model) {
    return { ok: false, error: "Model is not configured" };
  }
  await mkdir(layout.agentDir, { recursive: true, mode: 0o700 });
  const collected: ProposedChange[] = [];
  let invalidCall = false;
  const tool = createProposeNotesTool(
    (changes) => {
      collected.push(...changes);
    },
    () => {
      invalidCall = true;
    },
  );
  const { session } = await createAgentSession({
    cwd: layout.agentDir,
    agentDir: layout.agentDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(layout.agentDir),
    resourceLoader: createResourceLoader(input.systemPrompt),
    thinkingLevel: "off",
    customTools: [tool],
    tools: [PROPOSE_NOTES_TOOL_NAME],
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });

  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  let stopReason: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.isError) {
      invalidCall = true;
    }
    const projected = projectExecutionEvent(event);
    if (projected?.type === "assistant_end") {
      stopReason = projected.reason;
    }
  });

  try {
    input.signal?.throwIfAborted();
    await session.prompt(input.userPrompt, { expandPromptTemplates: false });
    await session.waitForIdle();
    if (
      input.signal?.aborted ||
      !stopReason ||
      stopReason === "error" ||
      stopReason === "aborted"
    ) {
      return { ok: false, error: "Consolidation model request failed or was cancelled" };
    }
    if (invalidCall && !collected.length) {
      return { ok: false, error: "Model produced an invalid proposal" };
    }
    return { ok: true, changes: collected };
  } catch {
    await session.abort().catch(() => undefined);
    await session.waitForIdle().catch(() => undefined);
    return { ok: false, error: "Consolidation model request failed or was cancelled" };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
};
