import type { DreamMessage, DreamWindow } from "./types.js";

/** 重叠上下文约 4k token；按字符粗估（约 3 字符/token），避免引入分词依赖。 */
export const CONTEXT_TOKENS = 4_000;
const CHARS_PER_TOKEN = 3;
/** 单批待整理消息的字符上限；超限则分批，批间用上一批尾部作为上下文。 */
export const BATCH_CHARS = 36_000;

const size = (message: DreamMessage) => message.text.length;

/**
 * 从完整消息序列切出一次整理窗口。
 * 游标之后的是待整理段；游标之前最近约 4k token 作为重叠上下文，
 * 这样相邻两次整理共享一段上下文，不会在硬断点处丢失前因后果。
 * 游标不存在于历史中（例如会话被重置）时视为从头开始，而不是静默丢弃数据。
 */
export const sliceWindow = (
  messages: readonly DreamMessage[],
  cursor: string | undefined,
  summary?: string,
): DreamWindow => {
  const at = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
  const start = at === -1 ? 0 : at + 1;
  const fresh = messages.slice(start);
  const context: DreamMessage[] = [];
  let used = 0;
  for (let index = start - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (used + size(message) > CONTEXT_TOKENS * CHARS_PER_TOKEN && context.length) break;
    context.unshift(message);
    used += size(message);
  }
  return { summary, context, fresh, lastId: fresh.at(-1)?.id };
};

/**
 * 把待整理段拆成多批。每批不超过字符上限（单条超长消息独占一批，不截断），
 * 后一批的上下文是前一批的尾部，保持批间重叠。
 */
export const splitBatches = (window: DreamWindow): DreamWindow[] => {
  if (!window.fresh.length) return [];
  const groups: DreamMessage[][] = [];
  let current: DreamMessage[] = [];
  let used = 0;
  for (const message of window.fresh) {
    if (current.length && used + size(message) > BATCH_CHARS) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += size(message);
  }
  groups.push(current);
  return groups.map((fresh, index) => {
    const previous = index === 0 ? window.context : tail(groups[index - 1]!);
    return { summary: window.summary, context: previous, fresh, lastId: fresh.at(-1)?.id };
  });
};

/** 取一批消息的尾部，约 4k token，作为下一批的重叠上下文。 */
const tail = (messages: DreamMessage[]): DreamMessage[] => {
  const kept: DreamMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (used + size(message) > CONTEXT_TOKENS * CHARS_PER_TOKEN && kept.length) break;
    kept.unshift(message);
    used += size(message);
  }
  return kept;
};
