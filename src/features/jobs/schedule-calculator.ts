/**
 * 严格 HH:mm 格式校验：仅接受 00:00 至 23:59（服务端本地时区），前导零必须完整。
 */
export const isStrictDailyTime = (value: string): boolean => {
  if (typeof value !== "string") return false;
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
};

/**
 * 校验是否为带明确时区（Z 或 ±HH:mm）的合法 ISO 8601 时间戳字符串。
 * 纯本地无时区时间（如 "2026-10-29T09:00:00"）返回 false。
 */
export const isIsoWithTimezone = (value: string): boolean => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!Number.isFinite(Date.parse(trimmed))) return false;
  return /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(trimmed);
};

/**
 * 排期校验错误：用于领域拒绝非法时刻设定（如 24:00、09:99、9:00 或非法 ISO）。
 */
export class InvalidScheduleError extends Error {
  readonly code = "INVALID_SCHEDULE_FORMAT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

/**
 * 校验任务排期设定（daily 与 at），非法值直接抛出 InvalidScheduleError。
 */
export const assertValidSchedule = (daily: boolean, at: string): void => {
  if (daily) {
    if (!isStrictDailyTime(at)) {
      throw new InvalidScheduleError(
        "Invalid daily time format: must be strict HH:mm between 00:00 and 23:59",
      );
    }
  } else {
    if (!isIsoWithTimezone(at)) {
      throw new InvalidScheduleError(
        "Invalid one-time schedule: ISO 8601 timestamp with timezone is required",
      );
    }
  }
};

/**
 * 计算参考时间之后的下一次运行时刻（本地时区）。
 * 遇到非法排期设定直接抛出 InvalidScheduleError，绝不进位或回退。
 */
export const nextRunAfter = (
  daily: boolean,
  at: string,
  after: Date,
): string => {
  assertValidSchedule(daily, at);

  if (!daily) return new Date(at).toISOString();

  const [h, m] = at.split(":").map(Number);
  const next = new Date(after);
  next.setHours(h, m, 0, 0);
  // 到达设定时刻也推进到下一天，保持严格晚于 after 语义。
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
};
