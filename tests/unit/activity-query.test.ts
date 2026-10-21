import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityDetail, ActivityOverview } from "../../src/features/activities/types.js";
import {
  activityCursorMatchesFilter,
  queryActivities,
  type ActivityCursor,
} from "../../src/features/activities/query.js";
import { activitiesQuerySchema } from "../../src/http/contracts/activities.js";
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from "../../src/http/activity-cursor.js";

const makeActivity = (
  id: string,
  createdAt: string,
  overrides: Partial<ActivityOverview> = {},
): ActivityDetail => ({
  activity: {
    id,
    spaceId: "thread-1",
    title: `Activity ${id}`,
    goal: "Goal",
    deliverable: "Deliverable",
    status: "running",
    progress: "In progress",
    result: null,
    runIds: ["run-1"],
    currentRunId: "run-1",
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    ...overrides,
  },
  steps: [],
});

test("activity-query: empty and small lists return single page without nextCursor", () => {
  const empty = queryActivities([], { filter: {}, limit: 10 });
  assert.deepEqual(empty, {
    activities: [],
    hasMore: false,
    nextCursor: null,
  });

  const single = [makeActivity("act-1", "2026-10-18T10:00:00.000Z")];
  const page = queryActivities(single, { filter: {}, limit: 10 });
  assert.equal(page.activities.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("activity-query: stable ordering descending by createdAt then id tie-breaker", () => {
  const items = [
    makeActivity("act-b", "2026-10-18T10:00:00.000Z"),
    makeActivity("act-c", "2026-10-18T12:00:00.000Z"),
    makeActivity("act-a", "2026-10-18T10:00:00.000Z"),
  ];

  const page = queryActivities(items, { filter: {}, limit: 10 });
  assert.deepEqual(
    page.activities.map((a) => a.id),
    ["act-c", "act-b", "act-a"],
  );
});

test("activity-query: multi-page pagination with cursor across identical timestamps", () => {
  // 5 个活动，全部具有相同的时间戳，依靠 id 进行稳定全序排序
  const items = [
    makeActivity("act-1", "2026-10-18T10:00:00.000Z"),
    makeActivity("act-2", "2026-10-18T10:00:00.000Z"),
    makeActivity("act-3", "2026-10-18T10:00:00.000Z"),
    makeActivity("act-4", "2026-10-18T10:00:00.000Z"),
    makeActivity("act-5", "2026-10-18T10:00:00.000Z"),
  ];

  // 第 1 页：limit 2
  const page1 = queryActivities(items, { filter: {}, limit: 2 });
  assert.equal(page1.activities.length, 2);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(
    page1.activities.map((a) => a.id),
    ["act-5", "act-4"],
  );
  assert.ok(page1.nextCursor);

  // 第 2 页：limit 2
  const page2 = queryActivities(items, { filter: {}, limit: 2, cursor: page1.nextCursor! });
  assert.equal(page2.activities.length, 2);
  assert.equal(page2.hasMore, true);
  assert.deepEqual(
    page2.activities.map((a) => a.id),
    ["act-3", "act-2"],
  );
  assert.ok(page2.nextCursor);

  // 第 3 页：limit 2
  const page3 = queryActivities(items, { filter: {}, limit: 2, cursor: page2.nextCursor! });
  assert.equal(page3.activities.length, 1);
  assert.equal(page3.hasMore, false);
  assert.deepEqual(
    page3.activities.map((a) => a.id),
    ["act-1"],
  );
  assert.equal(page3.nextCursor, null);
});

test("activity-query: filter by spaceId and status", () => {
  const items = [
    makeActivity("act-1", "2026-10-18T10:00:00.000Z", { spaceId: "thread-a", status: "completed" }),
    makeActivity("act-2", "2026-10-18T11:00:00.000Z", { spaceId: "thread-b", status: "running" }),
    makeActivity("act-3", "2026-10-18T12:00:00.000Z", { spaceId: "thread-a", status: "running" }),
  ];

  const byThread = queryActivities(items, { filter: { spaceId: "thread-a" }, limit: 10 });
  assert.deepEqual(byThread.activities.map((a) => a.id), ["act-3", "act-1"]);

  const byStatus = queryActivities(items, { filter: { status: "running" }, limit: 10 });
  assert.deepEqual(byStatus.activities.map((a) => a.id), ["act-3", "act-2"]);

  const byBoth = queryActivities(items, { filter: { spaceId: "thread-a", status: "running" }, limit: 10 });
  assert.deepEqual(byBoth.activities.map((a) => a.id), ["act-3"]);
});

test("activity-query: invalid timestamp in stored activity throws instead of silent fallback", () => {
  const corrupt = [makeActivity("act-corrupt", "not-a-valid-date")];
  assert.throws(() => {
    queryActivities(corrupt, { filter: {}, limit: 10 });
  }, /Activity timestamp is invalid/);
});

test("activity-query: cursor round-trip encoding and canonical validation", () => {
  const cursor: ActivityCursor = {
    createdAt: "2026-10-18T10:00:00.000Z",
    id: "act-123",
    spaceId: "thread-main",
    status: "running",
  };

  const encoded = encodeActivityCursor(cursor);
  const decoded = decodeActivityCursor(encoded);
  assert.deepEqual(decoded, cursor);

  // 非法游标：带空白、padding、非 JSON、额外字段等，decode 必须拒绝返回 undefined
  assert.equal(decodeActivityCursor(""), undefined);
  assert.equal(decodeActivityCursor("not-base64-!@#$"), undefined);
  assert.equal(decodeActivityCursor(`${encoded} `), undefined);

  // 额外未知字段拒绝
  const withExtra = Buffer.from(JSON.stringify({ ...cursor, extra: 123 }), "utf8").toString("base64url");
  assert.equal(decodeActivityCursor(withExtra), undefined);
});

test("activity-query: activityCursorMatchesFilter checks bound filters", () => {
  const cursor: ActivityCursor = {
    createdAt: "2026-10-18T10:00:00.000Z",
    id: "act-1",
    spaceId: "thread-a",
    status: "running",
  };

  assert.equal(activityCursorMatchesFilter(cursor, { spaceId: "thread-a", status: "running" }), true);
  assert.equal(activityCursorMatchesFilter(cursor, { spaceId: "thread-b", status: "running" }), false);
  assert.equal(activityCursorMatchesFilter(cursor, { spaceId: "thread-a", status: "completed" }), false);
  assert.equal(activityCursorMatchesFilter(cursor, {}), false);

  const unboundedCursor: ActivityCursor = {
    createdAt: "2026-10-18T10:00:00.000Z",
    id: "act-1",
  };
  assert.equal(activityCursorMatchesFilter(unboundedCursor, {}), true);
  assert.equal(activityCursorMatchesFilter(unboundedCursor, { spaceId: "thread-a" }), false);
});

test("activity-query: activitiesQuerySchema accepts valid limits and rejects decimals/strings/extras", () => {
  assert.equal(activitiesQuerySchema.parse({}).limit, 20);
  assert.equal(activitiesQuerySchema.parse({ limit: "50" }).limit, 50);

  // 边界值
  assert.equal(activitiesQuerySchema.parse({ limit: "1" }).limit, 1);
  assert.equal(activitiesQuerySchema.parse({ limit: "100" }).limit, 100);

  // 越界、小数、非法字符拒绝
  for (const bad of ["0", "101", "-5", "1.5", "abc", " 20", ""]) {
    assert.equal(activitiesQuerySchema.safeParse({ limit: bad }).success, false);
  }

  // 严格模式拒绝未声明参数
  assert.equal(activitiesQuerySchema.safeParse({ unknownField: "test" }).success, false);
});
