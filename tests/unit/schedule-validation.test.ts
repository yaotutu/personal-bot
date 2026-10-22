import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStrictDailyTime,
  isIsoWithTimezone,
  assertValidSchedule,
  InvalidScheduleError,
  nextRunAfter,
} from "../../src/features/jobs/schedule-calculator.js";

test("isStrictDailyTime accepts 00:00 to 23:59 and rejects invalid patterns", () => {
  // 合法边界
  assert.equal(isStrictDailyTime("00:00"), true);
  assert.equal(isStrictDailyTime("23:59"), true);
  assert.equal(isStrictDailyTime("09:00"), true);
  assert.equal(isStrictDailyTime("12:30"), true);

  // 非法值：不补零、越界、进位、空串、非法字符串
  assert.equal(isStrictDailyTime("9:00"), false);
  assert.equal(isStrictDailyTime("09:99"), false);
  assert.equal(isStrictDailyTime("24:00"), false);
  assert.equal(isStrictDailyTime("25:00"), false);
  assert.equal(isStrictDailyTime("12:60"), false);
  assert.equal(isStrictDailyTime("invalid"), false);
  assert.equal(isStrictDailyTime(""), false);
  assert.equal(isStrictDailyTime(" 09:00 "), false);
  assert.equal(isStrictDailyTime("12:00:00"), false);
});

test("isIsoWithTimezone verifies timezone offset presence", () => {
  assert.equal(isIsoWithTimezone("2030-01-01T00:00:00.000Z"), true);
  assert.equal(isIsoWithTimezone("2030-01-01T08:00:00+08:00"), true);
  assert.equal(isIsoWithTimezone("2030-01-01T00:00:00-05:00"), true);
  assert.equal(isIsoWithTimezone("2030-01-01T00:00:00"), false);
  assert.equal(isIsoWithTimezone("invalid"), false);
  assert.equal(isIsoWithTimezone(""), false);
});

test("assertValidSchedule throws InvalidScheduleError on invalid schedules", () => {
  assert.throws(() => assertValidSchedule(true, "09:99"), InvalidScheduleError);
  assert.throws(() => assertValidSchedule(true, "24:00"), InvalidScheduleError);
  assert.throws(() => assertValidSchedule(true, "9:00"), InvalidScheduleError);
  assert.throws(() => assertValidSchedule(true, "invalid"), InvalidScheduleError);
  assert.throws(() => assertValidSchedule(true, ""), InvalidScheduleError);

  assert.throws(() => assertValidSchedule(false, "2030-01-01T00:00:00"), InvalidScheduleError);
  assert.throws(() => assertValidSchedule(false, "invalid"), InvalidScheduleError);

  // 合法值不抛错
  assert.doesNotThrow(() => assertValidSchedule(true, "00:00"));
  assert.doesNotThrow(() => assertValidSchedule(true, "23:59"));
  assert.doesNotThrow(() => assertValidSchedule(false, "2030-01-01T00:00:00.000Z"));
});

test("nextRunAfter rejects invalid daily time without fallback or Date auto-overflow", () => {
  const after = new Date(2030, 0, 1, 10, 30);
  assert.throws(() => nextRunAfter(true, "invalid", after), InvalidScheduleError);
  assert.throws(() => nextRunAfter(true, "25:75", after), InvalidScheduleError);
  assert.throws(() => nextRunAfter(true, "09:99", after), InvalidScheduleError);
  assert.throws(() => nextRunAfter(true, "24:00", after), InvalidScheduleError);
  assert.throws(() => nextRunAfter(true, "9:00", after), InvalidScheduleError);

  // 严格计算：合法 00:00 和 23:59 正确排期
  const next00 = nextRunAfter(true, "00:00", after);
  // 10:30 之后遇到 00:00，必须排到明天 00:00
  assert.equal(next00, new Date(2030, 0, 2, 0, 0).toISOString());

  const next2359 = nextRunAfter(true, "23:59", after);
  // 10:30 之后遇到 23:59，排到今天 23:59
  assert.equal(next2359, new Date(2030, 0, 1, 23, 59).toISOString());

  // 恰好到点排明天
  const exact = new Date(2030, 0, 1, 12, 0);
  assert.equal(nextRunAfter(true, "12:00", exact), new Date(2030, 0, 2, 12, 0).toISOString());
});
