import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createConversation } from "../../src/features/conversation/conversation-service.js";
import type { ConversationHistoryPort, ConversationExecution } from "../../src/features/conversation/ports.js";
import type { ConversationNotification, ExecutionEvent } from "../../src/features/conversation/types.js";
import { createConversationHub } from "../../src/features/conversation/conversation-hub.js";
import { createMonitorService } from "../../src/features/monitors/monitor-service.js";
import { createMonitorScheduler } from "../../src/features/monitors/monitor-scheduler.js";
import type { MonitorRepository } from "../../src/features/monitors/types.js";
import { createMessageFeedbackFixture } from "../support/message-session.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await flush(); }
  assert.fail("condition did not settle");
};
const repository = <T>(): { read: () => Promise<T[]>; update: <R>(change: (items: T[]) => { items?: T[]; result: R }) => Promise<R> } => {
  let items: T[] = [];
  return {
    read: async () => structuredClone(items),
    update: async (change) => {
      const changed = change(structuredClone(items));
      if (changed.items) items = changed.items;
      return structuredClone(changed.result);
    },
  };
};
const conversationFixture = async (t: TestContext) => {
  const facts: ConversationNotification[] = [];
  const calls: string[] = [];
  let listener: (event: ExecutionEvent) => void = () => {};
  const done = deferred();
  const history: ConversationHistoryPort = {
    history: () => facts.map((fact) => ({ id: fact.id, role: "assistant", content: fact.text })),
    sessionId: () => "unit-session", messageFacts: () => [],
    records: () => ({ turns: [], results: new Map() }), checkpoint: () => null,
    appendTurn: () => { calls.push("turn"); }, omitTurn: () => {}, restoreIfNoUser: () => {},
    appendResult: (result) => { calls.push(result.status); },
    appendNotification: (fact) => { facts.push(fact); },
  };
  const session: ConversationExecution = {
    prompt: async () => { calls.push("prompt"); await done.promise; listener({ type: "assistant_end", reason: "stop", text: "done" }); },
    waitForIdle: async () => {},
    abort: async () => { calls.push("abort"); done.resolve(); },
    dispose: () => {}, syncContext: () => {},
    subscribe: (next) => { listener = next; return () => {}; },
  };
  const messageFeedback = await createMessageFeedbackFixture({
    spaceId: "source", sessionId: "unit-session", facts: history.messageFacts,
  });
  t.after(messageFeedback.cleanup);
  const conversation = createConversation(
    { configured: true, runTimeoutMs: 5000 },
    { history, messages: messageFeedback.messages, openSession: async () => session },
  );
  return { conversation, calls, facts, done, history, session, messages: messageFeedback.messages };
};

test("hub permanently closes, drains successful creations even if another rejects", async (t) => {
  const fixture = await conversationFixture(t);
  let disposed = false;
  const good = deferred<typeof fixture.conversation>();
  const bad = deferred<typeof fixture.conversation>();
  const hub = createConversationHub((id) => id === "good" ? good.promise : bad.promise, async () => []);
  const first = hub.forThread("good");
  const second = hub.forThread("bad").catch(() => undefined);
  const closing = hub.closeAll();
  assert.throws(() => hub.forThread("new"), { code: "SHUTDOWN" });
  good.resolve({ ...fixture.conversation, close: async () => { disposed = true; return true; } });
  bad.reject(new Error("initialization failed"));
  await Promise.all([first, second, closing]);
  assert.equal(disposed, true);
  assert.equal(hub.closeAll(), closing);
});

test("retained task source survives idle cache eviction but deletion closes its old generation", async (t) => {
  const instances = new Map<string, Awaited<ReturnType<typeof conversationFixture>>>();
  const hub = createConversationHub(async (id) => {
    const fixture = await conversationFixture(t); instances.set(id, fixture); return fixture.conversation;
  }, async () => [...instances.keys()].map((id) => ({ id, updatedAt: new Date(0).toISOString() })));
  await hub.forThread("source");
  const retained = await hub.retainThread("source");
  assert.ok(retained);
  await hub.release("source");
  assert.equal(await hub.findThread("source"), retained.conversation);
  await retained.conversation.notify("kept", "fact");
  await hub.deleteThread("source", async () => { instances.delete("source"); });
  await assert.rejects(retained.conversation.notify("late", "late"), /closed/);
  const fresh = await hub.forThread("source");
  assert.notEqual(fresh, retained.conversation);
  retained.release(); retained.release();
  await hub.closeAll();
});

test("trigger cancelled while session opens never starts prompt; closed coordinator rejects new runs", async (t) => {
  const fixture = await conversationFixture(t);
  const opened = deferred<ConversationExecution>();
  const conversation = createConversation(
    { configured: true, runTimeoutMs: 1 },
    { history: fixture.history, messages: fixture.messages, openSession: () => opened.promise },
  );
  const pending = conversation.trigger("scheduled", "job");
  const closing = conversation.close();
  opened.resolve(fixture.session);
  assert.equal((await pending).status, "failed");
  await closing;
  assert.equal(fixture.calls.includes("prompt"), false);
  assert.equal((await conversation.trigger("later", "later")).status, "failed");
  await assert.rejects(conversation.run({ spaceId: "main", runId: "r", expectedRevision: "empty", message: { id: "u", content: "hello" } }, () => {}), { code: "SHUTDOWN" });
});

test("busy conversation queues factual notification without another model turn and deduplicates IDs", async (t) => {
  const { conversation, calls, done, facts } = await conversationFixture(t);
  const running = conversation.trigger("job", "job");
  await until(() => calls.includes("prompt"));
  const delivered = conversation.notify("monitor changed", "notification-1");
  assert.equal(facts.length, 0);
  done.resolve();
  await running;
  await delivered;
  await conversation.notify("monitor changed", "notification-1");
  assert.deepEqual(facts, [{ id: "notification-1", text: "monitor changed" }]);
  assert.equal(calls.filter((call) => call === "prompt").length, 1);
});

test("monitor close after an in-flight fetch never records a new check or dispatches", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const monitors = createMonitorService(repository() as MonitorRepository);
  const monitor = await monitors.create({ url: "https://example.com", condition: "change" });
  const fetched = deferred<ReturnType<typeof fetchedPage>>();
  let fetching = false;
  const notifications: string[] = [];
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10, web: { fetch: async () => { fetching = true; return fetched.promise; } } }, monitors, { notify: async (text) => { notifications.push(text); } });
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => fetching);
  const closing = scheduler.close();
  fetched.resolve(fetchedPage("changed"));
  await closing;
  assert.equal((await monitors.get(monitor.id))?.checks, 0);
  assert.equal(notifications.length, 0);
});

test("monitor delivery failure preserves observed change for next scan without refetching or model execution", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const monitors = createMonitorService(repository() as MonitorRepository);
  const monitor = await monitors.create({ url: "https://example.com", condition: "contains", value: "yes" });
  let fetches = 0;
  let attempts = 0;
  const notifications: string[] = [];
  const scheduler = createMonitorScheduler({ monitorScanIntervalMs: 10, web: { fetch: async () => { fetches++; return fetchedPage("yes"); } } }, monitors, { notify: async (text) => { if (++attempts === 1) throw new Error("disk busy"); notifications.push(text); } });
  scheduler.start();
  t.mock.timers.tick(10);
  await until(() => attempts === 1 && !scheduler.isBusy());
  assert.ok((await monitors.get(monitor.id))?.pendingNotification);
  assert.equal((await monitors.get(monitor.id))?.lastNotifiedAt, undefined);
  t.mock.timers.tick(10);
  await until(() => attempts === 2 && !scheduler.isBusy());
  assert.equal(fetches, 1);
  assert.equal(notifications.length, 1);
  assert.equal((await monitors.get(monitor.id))?.pendingNotification, undefined);
  assert.ok((await monitors.get(monitor.id))?.lastNotifiedAt);
  await scheduler.close();
});

/** 结构化业务抓取结果；调度测试无需模拟工具层的 JSON 文本编码。 */
const fetchedPage = (text: string) => ({
  url: "https://example.com/", finalUrl: "https://example.com/", status: 200,
  extractor: "text", truncated: false, length: text.length, untrusted: true as const, text,
});
