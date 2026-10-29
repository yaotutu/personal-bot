import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { defaultInformationState, type InformationState } from "../../src/features/information/types.js";

const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};

test("information repository serializes update and delete without file revival", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = createInformationRepository(createDataLayout(dataDir));

  await assert.rejects(
    repository.update("space", (state) => ({ state, result: state.settings })),
    /Information document not found/,
  );
  assert.equal(await repository.update("space", (state) => ({
    state: { ...state, settings: { enabled: true, batchWindowSeconds: 0 } },
    result: true,
  }), { allowCreate: true }), true);

  const holding = deferred();
  const writing = repository.update("space", async (state) => {
    await holding.promise;
    return { state: { ...state, preferences: { notes: "serialized" } }, result: undefined };
  });
  const removing = repository.removeSpace("space");
  holding.finish();
  await Promise.all([writing, removing]);
  assert.equal(existsSync(join(dataDir, "information", "space.json")), false);
  assert.deepEqual(await repository.read("space"), defaultInformationState());
  await assert.rejects(
    repository.update("space", (state) => ({ state, result: state.settings })),
    /Information document not found/,
  );
});

test("startup reconcile closes interrupted models and completed pending publications", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = createInformationRepository(createDataLayout(dataDir));
  const at = new Date().toISOString();
  const state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0 },
    items: [
      { id: "item-running", spaceId: "space", source: "rss", externalId: "1", content: "one", receivedAt: at, acceptedAt: at, status: "processing", runId: "run-running" },
      { id: "item-completed", spaceId: "space", source: "rss", externalId: "2", content: "two", receivedAt: at, acceptedAt: at, status: "processed", runId: "run-completed" },
    ],
    runs: [
      { id: "run-running", spaceId: "space", itemIds: ["item-running"], status: "running", createdAt: at, startedAt: at, publications: [] },
      {
        id: "run-completed", spaceId: "space", itemIds: ["item-completed"], status: "completed",
        createdAt: at, startedAt: at, model: { status: "succeeded" },
        decisions: [{ itemId: "item-completed", decision: "notify", reason: "test" }],
        publications: [{ notificationId: "notification", itemIds: ["item-completed"], text: "test", status: "pending" }],
      },
    ],
  };
  await repository.update("space", (current) => ({ state, result: current }), { allowCreate: true });
  await repository.reconcileOnStart();
  const reconciled = await repository.read("space");
  assert.equal(reconciled.items[0]?.status, "failed");
  assert.equal(reconciled.runs[0]?.status, "failed");
  assert.equal(reconciled.runs[1]?.model?.status, "succeeded");
  assert.equal(reconciled.runs[1]?.publications[0]?.status, "failed");
});
