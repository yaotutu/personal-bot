/** 计算参考时间之后的下一次运行时刻（本地时区）。 */
export const nextRunAfter = (
  daily: boolean,
  at: string,
  after: Date,
): string => {
  // 一次性任务沿用 Date 的原有解析和 toISOString 行为，不额外校验输入。
  if (!daily) return new Date(at).toISOString();
  const [h, m] = at.split(":").map(Number);
  const next = new Date(after);
  next.setHours(h || 0, m || 0, 0, 0);
  // 到达设定时刻也推进到下一天，保持旧实现的“严格晚于 after”语义。
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
};
