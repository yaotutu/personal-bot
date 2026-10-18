import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceEvents } from "../../src/features/workspace/workspace-events.js";
import { createWorkspaceEventRoutes } from "../../src/http/routes/events.js";

/**
 * 工作区通知：单测只覆盖纯行为与协议面——
 * - createWorkspaceEvents：订阅/多订阅/退订/幂等关闭 + 坏订阅者隔离。
 * - createWorkspaceEventRoutes：ready 首帧/两类通知/心跳/有界合并/abort 清理/关闭后订阅无业务。
 * 业务侧由集成测试保护；不引入调试 API，用包裹层观察活跃订阅数。
 */

const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<string[]> => {
  const decoder = new TextDecoder();
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(decoder.decode(value, { stream: true }));
  }
  return frames;
};

const newSubscriber = (label: string, log: string[]) => ({
  notify: (event: string) => log.push(`${label}:${event}`),
  close: () => log.push(`${label}:close`),
});

test("createWorkspaceEvents: subscribe notifies and unsubscribe stops delivery", () => {
  const events = createWorkspaceEvents();
  const log: string[] = [];
  const unsub = events.subscribe(newSubscriber("s1", log));
  events.invalidate("workspace_updated");
  events.invalidate("actions_updated");
  unsub();
  events.invalidate("workspace_updated");
  assert.deepEqual(log, ["s1:workspace_updated", "s1:actions_updated"]);
});

test("createWorkspaceEvents: multiple subscribers each receive every invalidate", () => {
  const events = createWorkspaceEvents();
  const log: string[] = [];
  events.subscribe(newSubscriber("a", log));
  events.subscribe(newSubscriber("b", log));
  events.invalidate("workspace_updated");
  assert.deepEqual(log.sort(), ["a:workspace_updated", "b:workspace_updated"]);
});

test("createWorkspaceEvents: close is idempotent and disconnects every subscriber", () => {
  const events = createWorkspaceEvents();
  const log: string[] = [];
  events.subscribe(newSubscriber("s1", log));
  events.subscribe(newSubscriber("s2", log));
  events.close();
  events.close(); // 二次关闭不应抛错或重复通知
  events.invalidate("workspace_updated");
  assert.deepEqual(log.sort(), ["s1:close", "s2:close"]);
});

test("createWorkspaceEvents: a throwing subscriber is dropped and does not block siblings", () => {
  const events = createWorkspaceEvents();
  const log: string[] = [];
  const bad = { notify: () => { throw new Error("bad"); }, close: () => log.push("bad:close") };
  events.subscribe(bad);
  events.subscribe(newSubscriber("ok", log));
  events.invalidate("workspace_updated"); // 坏订阅者被踢出，好的仍收到
  assert.deepEqual(log, ["bad:close", "ok:workspace_updated"]); // disconnect 顺带调用 close（受控 try/catch）
  events.invalidate("workspace_updated"); // 此后坏订阅者不再被调用
  assert.deepEqual(log, ["bad:close", "ok:workspace_updated", "ok:workspace_updated"]);
});

test("createWorkspaceEvents: subscribing after close is a no-op unsubscribe", () => {
  const events = createWorkspaceEvents();
  const log: string[] = [];
  events.close();
  const unsub = events.subscribe(newSubscriber("s", log));
  events.invalidate("actions_updated");
  unsub(); // 关闭后应返回空函数，不抛错
  // 实现会在 closed 时直接 disconnect：新订阅者的 close 立刻被调用，但不会被登记、不会收 notify。
  assert.deepEqual(log, ["s:close"]);
});

const trackedEvents = () => {
  const events = createWorkspaceEvents();
  const original = events.subscribe.bind(events);
  let active = 0;
  const wrap = {
    ...events,
    subscribe: (sub: Parameters<typeof original>[0]) => {
      active++;
      const unsub = original(sub);
      return () => { active--; unsub(); };
    },
    active: () => active,
  };
  return wrap;
};

test("routes: GET /api/events emits a single ready frame with empty data", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const [first] = await collect(reader, 1);
  assert.equal(first, "event: ready\ndata: {}\n\n");
  reader.cancel();
});

test("routes: workspace_updated and actions_updated both surface as SSE frames", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  await collect(reader, 1); // ready
  events.invalidate("workspace_updated");
  events.invalidate("actions_updated");
  const frames = await collect(reader, 2);
  assert.deepEqual(frames, [
    "event: workspace_updated\ndata: {}\n\n",
    "event: actions_updated\ndata: {}\n\n",
  ]);
  reader.cancel();
});

test("routes: 30s timer emits keep-alive comment, not as a tracked event", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  await collect(reader, 1); // ready
  t.mock.timers.tick(30_000); // 同步触发 setInterval 回调；flush 在回调里入队心跳注释
  const [comment] = await collect(reader, 1);
  assert.equal(comment, ": keep-alive\n\n");
  reader.cancel();
});

test("routes: slow reader back-pressures; many same-type invalidates merge into a bounded queue without losing the other type", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  await collect(reader, 1); // ready
  // 不读期间 controller 队列被填满（highWaterMark=1），flush 提前返回，
  // 100 次同类通知在 pending Set 中只保留一个槽位，类型不同不互挤。
  for (let i = 0; i < 100; i++) events.invalidate("workspace_updated");
  events.invalidate("actions_updated");
  const frames = await collect(reader, 3);
  assert.equal(frames[0], "event: workspace_updated\ndata: {}\n\n");
  assert.equal(frames[1], "event: workspace_updated\ndata: {}\n\n"); // 排空后 pending 还有一条
  assert.equal(frames[2], "event: actions_updated\ndata: {}\n\n");  // 另一类未丢
  reader.cancel();
});

test("routes: request abort removes the subscriber; further invalidates do not touch the closed stream", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  const reader = response.body!.getReader();
  await collect(reader, 1); // ready
  assert.equal(events.active(), 1);
  controller.abort();
  // abort 触发 disconnect，订阅应立刻被清掉；不依赖定时器或后续读取。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.active(), 0);
  events.invalidate("workspace_updated"); // 无订阅者可触达，不再产生帧
  const { done } = await reader.read();
  assert.equal(done, true);
});

test("routes: cancelling the reader (client disconnect) clears the subscriber", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  await collect(reader, 1);
  assert.equal(events.active(), 1);
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.active(), 0);
});

test("routes: service-level close (events.close) tears down every active subscriber", async () => {
  const events = trackedEvents();
  const app = createWorkspaceEventRoutes(events);
  const [ra, rb] = await Promise.all([app.request("/api/events"), app.request("/api/events")]);
  const readerA = ra.body!.getReader();
  const readerB = rb.body!.getReader();
  await collect(readerA, 1);
  await collect(readerB, 1);
  assert.equal(events.active(), 2);
  events.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.active(), 0);
  await readerA.cancel();
  await readerB.cancel();
});

test("routes: close-before-subscribe hands the route a no-op and the stream ends without a ready frame", async () => {
  const events = trackedEvents();
  events.close();
  const app = createWorkspaceEventRoutes(events);
  const response = await app.request("/api/events");
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const { value, done } = await reader.read();
  assert.equal(done, true);
  assert.equal(value, undefined);
});

test("routes: createWorkspaceEventRoutes carries no business reference; tearing down is purely stream lifecycle", async () => {
  // 接口契约：路由只持有 events 句柄；不应意外调用任何业务方法。
  // 用一个代理 events 拦截所有属性访问，断言整个生命周期里路由只用到 subscribe，
  // 没有任何业务方法（invalidate / close / 等）被路由触发。
  const events = createWorkspaceEvents();
  const calls: string[] = [];
  const proxy = new Proxy(events, {
    get(target, prop, receiver) {
      if (typeof prop === "string") calls.push(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  const app = createWorkspaceEventRoutes(proxy as typeof events);
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  await collect(reader, 1);
  await reader.cancel(); // 触发路由内部 disconnect；观察代理记录
  await new Promise((resolve) => setImmediate(resolve));
  // 路由整个生命周期只调用了 subscribe；没有任何业务方法被触发。
  assert.ok(calls.includes("subscribe"), "route should call events.subscribe");
  assert.ok(!calls.includes("invalidate"), "route must not call events.invalidate");
  assert.ok(!calls.includes("close"), "route must not call events.close directly");
});