import { INSTRUCTIONS_LIMIT } from "./prompt.js";
import { purposeChanged, readPurpose } from "./purpose.js";
import type { DreamPending, DreamTarget } from "./types.js";

/**
 * 模型通过唯一的 propose_notes 工具提交的建议。
 * 模型只能指定“目标类别”，不能传文件路径；写入哪个文件由服务端按类别决定。
 */
export type ProposedChange =
  | { target: "user" | "soul" | "instructions"; text: string; source: string }
  | { target: "memory"; op: "add"; text: string; source: string }
  | { target: "memory"; op: "edit"; id: string; text: string; source: string }
  | { target: "memory"; op: "delete"; id: string; source: string }
  | { target: "pending"; suggestedTarget: DreamTarget; text: string; source: string };

const MAX_TEXT = 4_000;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;

/** 把工具参数解析成受信任的建议；任何字段不合法都整体拒绝，不做猜测式修复。 */
export const parseProposal = (value: unknown): ProposedChange[] | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes) || changes.length > 50) return undefined;
  const parsed: ProposedChange[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (!isText(item.source)) return undefined;
    const source = item.source.trim();
    if (item.target === "user" || item.target === "soul" || item.target === "instructions") {
      if (!isText(item.text)) return undefined;
      parsed.push({ target: item.target, text: item.text.trim(), source });
    } else if (item.target === "memory") {
      if (item.op === "add") {
        if (!isText(item.text)) return undefined;
        parsed.push({ target: "memory", op: "add", text: item.text.trim(), source });
      } else if (item.op === "edit") {
        if (!isText(item.id) || !isText(item.text)) return undefined;
        parsed.push({ target: "memory", op: "edit", id: item.id.trim(), text: item.text.trim(), source });
      } else if (item.op === "delete") {
        if (!isText(item.id)) return undefined;
        parsed.push({ target: "memory", op: "delete", id: item.id.trim(), source });
      } else return undefined;
    } else if (item.target === "pending") {
      const suggested = item.suggestedTarget;
      if (!isText(item.text) || (suggested !== "user" && suggested !== "soul" && suggested !== "instructions" && suggested !== "memory"))
        return undefined;
      parsed.push({ target: "pending", suggestedTarget: suggested, text: item.text.trim(), source });
    } else return undefined;
  }
  return parsed;
};

export type NoteTargets = "user" | "soul" | "instructions";
export type Rejected = { change: ProposedChange; reason: string };

/** 校验的上下文：当前内容与会话身份，全部来自服务端读取，不来自模型。 */
export type ProposalContext = {
  isMain: boolean;
  /** 会话是否声明了用途；没有用途就不能对 INSTRUCTIONS 作直接修改。 */
  hasPurpose: boolean;
  existingMemoryIds: ReadonlySet<string>;
  /** 当前整份指令文本，用于检查用途段与长度。 */
  instructions: string;
};

export type ProposalPlan = {
  /** 可以直接写入的变更。 */
  apply: Exclude<ProposedChange, { target: "pending" }>[];
  /** 需要用户决定的条目，来自模型主动标记或服务端降级。 */
  pending: Omit<DreamPending, "id" | "createdAt">[];
  /** 被服务端拒绝的建议，只进入报告计数，不写入。 */
  rejected: Rejected[];
};

/**
 * 服务端对建议的唯一裁决点：能直接写的、必须交给用户的、直接拒绝的。
 * 规则按“不确定就不写”的方向收紧：非主会话的全局写入降级为待确认，
 * 无用途会话的指令写入降级为待确认，引用不存在的记忆 id 直接拒绝。
 */
export const planProposal = (
  changes: readonly ProposedChange[],
  context: ProposalContext,
): ProposalPlan => {
  const plan: ProposalPlan = { apply: [], pending: [], rejected: [] };
  for (const change of changes) {
    if (change.target === "pending") {
      plan.pending.push({ text: change.text, suggestedTarget: change.suggestedTarget, reason: "ambiguous" });
      continue;
    }
    if ((change.target === "user" || change.target === "soul") && !context.isMain) {
      plan.pending.push({ text: change.text, suggestedTarget: change.target, reason: "global_from_session" });
      continue;
    }
    if (change.target === "instructions") {
      if (!context.hasPurpose) {
        plan.pending.push({ text: change.text, suggestedTarget: "instructions", reason: "no_purpose" });
        continue;
      }
      // 用途段不可被改写；指令总长也要受控，两项都在这里挡住。
      const next = appendInstructions(context.instructions, change.text);
      if (change.text.includes("## 会话用途") || purposeChanged(context.instructions, next)) {
        plan.rejected.push({ change, reason: "would change session purpose" });
        continue;
      }
      if (next.length > INSTRUCTIONS_LIMIT) {
        plan.rejected.push({ change, reason: "instructions too long" });
        continue;
      }
    }
    if (change.target === "memory" && change.op !== "add" && !context.existingMemoryIds.has(change.id)) {
      plan.rejected.push({ change, reason: "unknown memory id" });
      continue;
    }
    plan.apply.push(change);
  }
  return plan;
};

/**
 * 把一条新指令并入现有指令文本：追加到末尾，保持用途段在开头不变。
 * 去重在这里做：完全相同的行不重复追加。
 */
export const appendInstructions = (current: string, addition: string): string => {
  const base = current.trim();
  const line = addition.trim();
  if (!line) return base;
  if (base.split("\n").some((existing) => existing.trim() === line)) return base;
  if (!base) return line;
  // 若当前文本只有 `## 会话用途` 段落而尚无空行分隔，先空一行再追加规则，避免新规则并入用途段。
  const separator = base.includes("## 会话用途") && !base.includes("\n\n") ? "\n\n" : "\n";
  return `${base}${separator}${line}`;
};

/** 把一条新笔记并入 USER/SOUL 的纯文本；按行去重，其余内容原样保留。 */
export const appendNote = appendInstructions;

export { readPurpose };
