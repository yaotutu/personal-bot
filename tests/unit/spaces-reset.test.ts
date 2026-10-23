import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpaceRoutes } from "../../src/http/routes/spaces.js";
import type { HttpDependencies } from "../../src/bootstrap/types.js";

test("POST /:spaceId/reset invokes clearPendingByOriginSpaceId when clearSchedules is false", async () => {
  const calls: string[] = [];
  const mockMonitors = {
    clearPendingByOriginSpaceId: async (originSpaceId: string) => {
      calls.push(`clearPending:${originSpaceId}`);
      return 1;
    },
    removeByOriginSpaceId: async (originSpaceId: string) => {
      calls.push(`remove:${originSpaceId}`);
      return 1;
    },
    list: async () => [],
    get: async () => undefined,
    create: async () => ({} as never),
    control: async () => ({ ok: true as const, monitor: {} as never }),
    update: async () => undefined,
    remove: async () => true,
    check: async () => ({ outcome: { kind: "silent" as const } }),
    markNotified: async () => true,
  };
  const mockJobs = {
    removeByOriginSpaceId: async (originSpaceId: string) => {
      calls.push(`removeJobs:${originSpaceId}`);
      return 1;
    },
    list: async () => [],
  };
  const mockActions = {
    snapshotPending: async () => [],
    cancelBySpaceId: async () => [],
    get: async () => undefined,
  };
  const mockDream = {
    resetSpace: async (_spaceId: string) => {},
  };
  const mockHub = {
    spaces: async () => [],
    resetSpace: async (_spaceId: string, onReset: (hooks: { closeCurrent: () => Promise<void>; reopen: () => Promise<{ sessionId: () => string }> }) => Promise<unknown>) => {
      return onReset({
        closeCurrent: async () => {},
        reopen: async () => ({ sessionId: () => "new-session-id" }),
      });
    },
  };
  const layout = {
    dataDir: "/tmp/nonexistent",
    sessionsDir: "/tmp/nonexistent/sessions",
    workspaceDir: "/tmp/nonexistent/workspace",
  } as never;

  const app = createSpaceRoutes({
    conversationHub: mockHub,
    layout,
    jobs: mockJobs,
    monitors: mockMonitors,
    skills: {} as never,
    dream: mockDream,
    actions: mockActions,
  } as unknown as HttpDependencies);

  // 1. 重置 explicit space，clearSchedules: false -> 调用 clearPendingByOriginSpaceId
  const res1 = await app.request("/custom-space/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearSchedules: false }),
  });
  assert.equal(res1.status, 200);
  assert.deepEqual(calls, ["clearPending:custom-space"]);

  // 2. 重置 local-main，clearSchedules: false -> 调用 clearPendingByOriginSpaceId("local-main")
  calls.length = 0;
  const res2 = await app.request("/local-main/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearSchedules: false }),
  });
  assert.equal(res2.status, 200);
  assert.deepEqual(calls, ["clearPending:local-main"]);

  // 3. 重置并清理调度，clearSchedules: true -> 调用 removeByOriginSpaceId
  calls.length = 0;
  const res3 = await app.request("/custom-space/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearSchedules: true }),
  });
  assert.equal(res3.status, 200);
  assert.deepEqual(calls, ["removeJobs:custom-space", "remove:custom-space"]);
});
