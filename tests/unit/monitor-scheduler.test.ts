import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitorScheduler } from "../../src/features/monitors/monitor-scheduler.js";
import { createMonitorService } from "../../src/features/monitors/monitor-service.js";
import type { Monitor, MonitorRepository } from "../../src/features/monitors/types.js";

const until = async (condition: () => boolean) => {
  for (let index = 0; index < 100; index++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not settle");
};
const fixture = async () => {
  let items: Monitor[] = [];
  const repository: MonitorRepository = {
    read: async () => structuredClone(items),
    update: async (change) => {
      const changed = change(structuredClone(items));
      if (changed.items) items = changed.items;
      return changed.result;
    },
  };
  const monitors = createMonitorService(repository);
  const first = await monitors.create({ url: "https://example.com/first", condition: "contains", value: "yes", originThreadId: "first" });
  const second = await monitors.create({ url: "https://example.com/second", condition: "contains", value: "yes", originThreadId: "second" });
  return { monitors, first, second };
};

test("busy notification does not block other monitors, duplicate delivery, or scheduler close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitors, first, second } = await fixture();
  let release!: () => void;
  const busy = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  let fetches = 0;
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10, web: { fetch: async () => { fetches++; return fetchedPage("yes"); } } }, monitors, { notify: async () => {} }, async (thread) => ({ notify: async () => {
    delivered.push(thread);
    if (thread === "first") await busy;
  } }));
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => delivered.length === 2 && !scheduler.isBusy());
  assert.ok((await monitors.get(first.id))?.pendingNotification);
  assert.equal((await monitors.get(second.id))?.pendingNotification, undefined);
  t.mock.timers.tick(10);
  await until(() => !scheduler.isBusy());
  assert.equal(fetches, 2);
  assert.deepEqual(delivered, ["first", "second"]);
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal((await monitors.get(first.id))?.pendingNotification, undefined);
});

test("failed delivery and failed check leave other monitors running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitors, first, second } = await fixture();
  await monitors.check(first.id, { body: "yes" });
  let attempts = 0;
  let delivered = 0;
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10, web: { fetch: async () => fetchedPage("yes") } }, {
    ...monitors,
    check: async (id, result) => {
      if (id === first.id) throw new Error("write failed");
      return monitors.check(id, result);
    },
  }, { notify: async () => {} }, async (thread) => ({ notify: async () => {
    if (thread === "first" && ++attempts === 1) throw new Error("delivery failed");
    delivered++;
  } }));
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => delivered === 1 && !scheduler.isBusy());
  assert.ok((await monitors.get(first.id))?.pendingNotification);
  assert.equal((await monitors.get(second.id))?.pendingNotification, undefined);
  t.mock.timers.tick(10);
  await until(() => delivered === 2 && !scheduler.isBusy());
  assert.equal((await monitors.get(first.id))?.pendingNotification, undefined);
  await scheduler.close();
});

test("one monitor check write failure does not stop the remaining scan", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitors, first, second } = await fixture();
  let checks = 0;
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10, web: { fetch: async () => fetchedPage("yes") } }, {
    ...monitors,
    check: async (id, result) => {
      checks++;
      if (id === first.id) throw new Error("write failed");
      return monitors.check(id, result);
    },
  }, { notify: async () => {} });
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => checks === 2 && !scheduler.isBusy());
  assert.equal((await monitors.get(first.id))?.checks, 0);
  assert.equal((await monitors.get(second.id))?.checks, 1);
  await scheduler.close();
});

test("deleted monitor snapshots never notify a recreated source or fall back to main", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitors, first, second } = await fixture();
  await monitors.remove(second.id);
  await monitors.check(first.id, { body: "yes" });
  let resolving = false;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const notifications: string[] = [];
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10 }, monitors,
    { notify: async () => { notifications.push("main"); } }, async () => {
      resolving = true;
      await gate;
      return { notify: async () => { notifications.push("new source"); } };
    });
  t.after(() => resume());
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => resolving);
  await monitors.removeByOriginThreadId("first");
  resume();
  await scheduler.close();
  assert.deepEqual(notifications, []);
});

test("missing explicit monitor source preserves pending notification without using main", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitors, first, second } = await fixture();
  await monitors.remove(second.id);
  await monitors.check(first.id, { body: "yes" });
  let resolutions = 0;
  let notifications = 0;
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10 }, monitors,
    { notify: async () => { notifications++; } }, async () => { resolutions++; return undefined; });
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => resolutions > 0 && !scheduler.isBusy());
  await scheduler.close();
  assert.equal(notifications, 0);
  assert.ok((await monitors.get(first.id))?.pendingNotification);
});

/** 结构化业务抓取结果；调度测试无需模拟工具层的 JSON 文本编码。 */
const fetchedPage = (text: string) => ({
  url: "https://example.com/", finalUrl: "https://example.com/", status: 200,
  extractor: "text", truncated: false, length: text.length, untrusted: true as const, text,
});
