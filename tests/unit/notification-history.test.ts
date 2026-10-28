import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataLayout, threadSessionsDir } from "../../src/adapters/storage/data-layout.js";
import { createSessionHistory } from "../../src/adapters/pi/session-history.js";
import { createMessageFeedbackRepository } from "../../src/adapters/storage/message-feedback-repository.js";
import { createMessageFeedbackSession } from "../../src/features/messages/service.js";
import { createConversation } from "../../src/features/conversation/conversation-service.js";
import { TURN_ENTRY_TYPE } from "../../src/features/conversation/types.js";
import { createNotificationMessage } from "../../src/adapters/pi/notification-message.js";

test("notification alone persists a new pi session and survives reopen without model execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-bot-notification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  const { history } = await createSessionHistory(layout, "source-thread");
  const repository = createMessageFeedbackRepository(layout);
  const make = (port: typeof history) => createConversation({ configured: false, runTimeoutMs: 1000 }, {
    history: port,
    messages: createMessageFeedbackSession({
      spaceId: "source-thread",
      sessionId: () => port.sessionId(),
      facts: port.messageFacts,
      repository,
    }),
    openSession: async () => { assert.fail("notification must never open an execution session"); },
  });
  const first = make(history);
  await first.notify("📋 服务端任务完成事实", "stable-notification");
  await first.close();
  const directory = threadSessionsDir(layout, "source-thread");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const persisted = await readFile(join(directory, files[0]!), "utf8");
  assert.match(persisted, /server-notification/);
  const reopened = await createSessionHistory(layout, "source-thread");
  assert.deepEqual(reopened.history.history(), [{ id: "stable-notification", role: "assistant", content: "📋 服务端任务完成事实" }]);
  // 标准 pi 上下文也可见服务端事实，不需要伪造用户请求去让模型重述。
  assert.ok(reopened.manager.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("服务端任务完成事实")));
  const second = make(reopened.history);
  await second.notify("不会重复", "stable-notification");
  assert.equal(reopened.history.history().length, 1);
  assert.equal(await readFile(join(directory, files[0]!), "utf8"), persisted);
  await second.close();
});

test("server facts keep independent IDs instead of merging into adjacent model replies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-bot-notification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { manager, history } = await createSessionHistory(createDataLayout(root), "thread");
  manager.appendCustomEntry(TURN_ENTRY_TYPE, { runId: "run", userId: "user", assistantId: "assistant-run", text: "question" });
  const { personalBotNotificationId: _id, ...assistant } = createNotificationMessage({ id: "unused", text: "answer" });
  manager.appendMessage({ ...assistant, provider: "personal", model: "test" });
  history.appendNotification({ id: "notice-1", text: "first fact" });
  history.appendNotification({ id: "notice-2", text: "second fact" });
  assert.deepEqual(history.history().map((message) => [message.id, message.content]), [
    ["assistant-run", "answer"], ["notice-1", "first fact"], ["notice-2", "second fact"],
  ]);
});

test("retrying a failed model turn preserves later independent task notifications", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-bot-notification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  const { manager, history } = await createSessionHistory(layout, "thread");
  history.appendTurn({ runId: "failed-run", userId: "question", assistantId: "answer", text: "question" });
  manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
  const { personalBotNotificationId: _id, ...assistant } = createNotificationMessage({ id: "unused", text: "partial reply" });
  manager.appendMessage({ ...assistant, provider: "personal", model: "test" });
  history.appendResult({ runId: "failed-run", status: "failed" });
  history.appendNotification({ id: "task-fact", text: "task result" });
  history.omitTurn("failed-run");
  assert.deepEqual(history.history(), [{ id: "task-fact", role: "assistant", content: "task result" }]);
  assert.ok(manager.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("task result")));
  const reopened = await createSessionHistory(layout, "thread");
  assert.deepEqual(reopened.history.history(), history.history());
});
