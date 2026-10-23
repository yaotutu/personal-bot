import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitorService } from "../../src/features/monitors/monitor-service.js";
import type { Monitor, MonitorRepository } from "../../src/features/monitors/types.js";

const createFixture = () => {
  let items: Monitor[] = [];
  const repository: MonitorRepository = {
    read: async () => structuredClone(items),
    update: async (change) => {
      const changed = change(structuredClone(items));
      if (changed.items) items = changed.items;
      return changed.result;
    },
  };
  const service = createMonitorService(repository);
  return { service, getRaw: () => items };
};

test("clearPendingByOriginSpaceId clears explicit space and defaults missing originSpaceId to local-main", async () => {
  const { service } = createFixture();

  // 1. 创建显式空间监控与无 originSpaceId（缺省）监控
  const explicit = await service.create({
    url: "https://example.com/explicit",
    condition: "contains",
    value: "ALERT",
    originSpaceId: "space-custom",
  });
  const defaultMain = await service.create({
    url: "https://example.com/main",
    condition: "contains",
    value: "ALERT",
    // 省略 originSpaceId
  });

  // 模拟检查产生待投递通知
  await service.check(explicit.id, { body: "ALERT-FOUND" });
  await service.check(defaultMain.id, { body: "ALERT-FOUND" });

  assert.ok((await service.get(explicit.id))?.pendingNotification);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 2. 清理无关空间，不影响已有待投递项
  const clearedOther = await service.clearPendingByOriginSpaceId("other-space");
  assert.equal(clearedOther, 0);
  assert.ok((await service.get(explicit.id))?.pendingNotification);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 3. 清理显式空间，仅清除该显式空间的待投递项
  const clearedExplicit = await service.clearPendingByOriginSpaceId("space-custom");
  assert.equal(clearedExplicit, 1);
  assert.equal((await service.get(explicit.id))?.pendingNotification, undefined);
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  // 4. 清理 local-main，清除缺省 originSpaceId 的待投递项
  const clearedMain = await service.clearPendingByOriginSpaceId("local-main");
  assert.equal(clearedMain, 1);
  assert.equal((await service.get(defaultMain.id))?.pendingNotification, undefined);
});

test("PATCH monitor modifying originSpaceId discards pendingNotification to prevent leak to new space", async () => {
  const { service } = createFixture();

  // 1. 从显式空间改绑到另一显式空间
  const explicit = await service.create({
    url: "https://example.com/task1",
    condition: "contains",
    value: "KW",
    originSpaceId: "space-alpha",
  });
  await service.check(explicit.id, { body: "KW" });
  assert.ok((await service.get(explicit.id))?.pendingNotification);

  // 仅修改无关字段（如 title），pendingNotification 保留
  const updatedTitle = await service.update(explicit.id, { title: "Renamed Title" });
  assert.ok(updatedTitle?.pendingNotification);

  // 修改 originSpaceId 改绑到新空间，必须丢弃旧通知
  const rebound = await service.update(explicit.id, { originSpaceId: "space-beta" });
  assert.equal(rebound?.originSpaceId, "space-beta");
  assert.equal(rebound?.pendingNotification, undefined);

  // 2. 缺省 originSpaceId (local-main) 改绑到新空间，也丢弃旧通知
  const defaultMain = await service.create({
    url: "https://example.com/task2",
    condition: "contains",
    value: "KW",
  });
  await service.check(defaultMain.id, { body: "KW" });
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);

  const reboundMain = await service.update(defaultMain.id, { originSpaceId: "space-gamma" });
  assert.equal(reboundMain?.originSpaceId, "space-gamma");
  assert.equal(reboundMain?.pendingNotification, undefined);

  // 3. 显式修改为相同 originSpaceId 时，不丢弃通知
  await service.check(defaultMain.id, { body: "NO-MATCH" });
  await service.check(defaultMain.id, { body: "KW-NEW" });
  assert.ok((await service.get(defaultMain.id))?.pendingNotification);
  const sameSpaceUpdate = await service.update(defaultMain.id, { originSpaceId: "space-gamma" });
  assert.ok(sameSpaceUpdate?.pendingNotification);
});
