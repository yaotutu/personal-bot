import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createFakeModel } from "../support/fake-model.js";
import { createConfig } from "../../src/config/load-config.js";
import { createService } from "../../src/bootstrap/create-service.js";
import { conversationResponse } from "../../src/http/contracts/responses.js";
import { messageFeedbackResponse } from "../../src/http/contracts/messages.js";

type Snapshot = ReturnType<typeof conversationResponse.parse>;

const fixture = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-message-feedback-"));
  const model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir },
  });
  let service = await createService(config);
  const headers = {
    Authorization: `Bearer ${service.auth.login()}`,
    "Content-Type": "application/json",
  };
  const close = async () => {
    await service.close();
    service = await createService(config);
  };
  t.after(async () => {
    try { await service.close(); } finally {
      try { await model.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const request = (path: string, init?: RequestInit) =>
    service.app.request(path, { headers, ...init });
  const get = async (spaceId: string) => {
    const response = await request(`/api/conversation?spaceId=${encodeURIComponent(spaceId)}`);
    assert.equal(response.status, 200);
    return conversationResponse.parse(await response.json());
  };
  const runToCompletion = async (spaceId: string, text: string, ids = { run: randomUUID(), message: randomUUID() }) => {
    const before = await get(spaceId);
    const response = await request("/api/conversation/run", {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        runId: ids.run,
        expectedRevision: before.revision,
        message: { id: ids.message, content: text },
      }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /RUN_FINISHED/);
    return { ids, stream, before };
  };
  const feedback = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await request(path, init);
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  return { dataDir, request, get, runToCompletion, feedback, restart: close, service: () => service };
};

const targetMessage = (snapshot: Snapshot, role: "user" | "assistant") => {
  const message = snapshot.messages.find((item) => item.role === role);
  assert.ok(message?.metadata && message.feedback);
  return message as typeof message & {
    metadata: NonNullable<typeof message.metadata>;
    feedback: NonNullable<typeof message.feedback>;
  };
};

test("message feedback persists full events, coordinates sessions, and never changes chat history", async (t) => {
  const h = await fixture(t);
  const spaceId = "feedback-integration";
  const first = await h.runToCompletion(spaceId, "hello");
  const afterRun = await h.get(spaceId);
  const user = targetMessage(afterRun, "user");
  const assistant = targetMessage(afterRun, "assistant");
  assert.equal(user.metadata.source, "chat");
  assert.equal(user.metadata.feedbackAvailable, true);
  assert.ok(afterRun.sessionId);

  const reactionPath = (id: string) =>
    `/api/spaces/${spaceId}/messages/${encodeURIComponent(id)}/feedback/reaction`;
  let result = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: afterRun.sessionId, reaction: "like" }),
  });
  assert.equal(result.status, 200);
  assert.equal(messageFeedbackResponse.parse(result.body).reaction, "like");
  result = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: afterRun.sessionId, reaction: "dislike" }),
  });
  assert.equal(messageFeedbackResponse.parse(result.body).reaction, "dislike");
  result = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: afterRun.sessionId, reaction: null }),
  });
  assert.equal(messageFeedbackResponse.parse(result.body).reaction, null);

  const commentPath = (id: string) =>
    `/api/spaces/${spaceId}/messages/${encodeURIComponent(id)}/feedback/comments`;
  result = await h.feedback(commentPath(assistant.id), {
    method: "POST", body: JSON.stringify({ sessionId: afterRun.sessionId, text: " first " }),
  });
  assert.equal(result.status, 200);
  let current = messageFeedbackResponse.parse(result.body);
  assert.equal(current.comments.length, 1);
  assert.equal(current.comments[0]!.text, "first");
  const commentId = current.comments[0]!.id;
  result = await h.feedback(`${commentPath(assistant.id)}/${commentId}`, {
    method: "PATCH", body: JSON.stringify({ sessionId: afterRun.sessionId, text: "edited" }),
  });
  current = messageFeedbackResponse.parse(result.body);
  assert.notEqual(current.comments[0]!.updatedAt, current.comments[0]!.createdAt);
  assert.equal(current.comments[0]!.text, "edited");

  const eventsResponse = await h.feedback(
    `/api/spaces/${spaceId}/messages/${encodeURIComponent(assistant.id)}/feedback/events?sessionId=${encodeURIComponent(afterRun.sessionId)}`,
  );
  assert.equal(eventsResponse.status, 200);
  const events = (eventsResponse.body as { events: Array<{ type: string; fromText?: string; toText?: string }> }).events;
  assert.deepEqual(events.map((event) => event.type), ["comment_added", "comment_edited"]);
  assert.equal(events[1]!.fromText, "first");
  assert.equal(events[1]!.toText, "edited");
  const userEvents = await h.feedback(
    `/api/spaces/${spaceId}/messages/${encodeURIComponent(user.id)}/feedback/events?sessionId=${encodeURIComponent(afterRun.sessionId)}`,
  );
  assert.deepEqual(
    (userEvents.body as { events: Array<{ type: string }> }).events.map((event) => event.type),
    ["reaction_changed", "reaction_changed", "reaction_changed"],
  );

  const afterFeedback = await h.get(spaceId);
  assert.equal(afterFeedback.revision, afterRun.revision);
  assert.equal(afterFeedback.messages.length, afterRun.messages.length);
  assert.equal(afterFeedback.messages.find((item) => item.id === assistant.id)?.feedback?.comments.length, 1);

  // 服务重启后重新投影 PI 事实并读取独立反馈文件，不迁移或清空真实历史。
  await h.restart();
  const restarted = await h.get(spaceId);
  assert.equal(restarted.sessionId, afterRun.sessionId);
  assert.equal(restarted.messages.find((item) => item.id === assistant.id)?.feedback?.comments[0]?.text, "edited");

  // completed 幂等重放必须仍是可反馈历史，而不是被当作当前生成轮。
  const replay = await h.request("/api/conversation/run", {
    method: "POST",
    body: JSON.stringify({
      spaceId,
      runId: first.ids.run,
      expectedRevision: "stale-after-completion",
      message: { id: first.ids.message, content: "hello" },
    }),
  });
  assert.equal(replay.status, 200);
  const replayStream = await replay.text();
  const snapshotMessage = JSON.parse(replayStream.split("\n").find((line) => line.includes('"MESSAGES_SNAPSHOT"'))!.slice(6)) as {
    messages: Array<{ id: string; metadata?: { feedbackAvailable: boolean } }>;
  };
  assert.equal(snapshotMessage.messages.find((item) => item.id === assistant.id)?.metadata?.feedbackAvailable, true);

  // 反馈期间模型可继续运行；只有当前 run 的目标不可用，旧历史仍可操作。
  const beforeFreeze = await h.get(spaceId);
  const freezeIds = { run: randomUUID(), message: randomUUID() };
  const freezeResponse = h.request("/api/conversation/run", {
    method: "POST",
    body: JSON.stringify({
      spaceId, runId: freezeIds.run, expectedRevision: beforeFreeze.revision,
      message: { id: freezeIds.message, content: "freeze" },
    }),
  });
  // 等到 run_started 后用独立 HTTP 读当前快照并反馈旧消息。
  await new Promise((resolve) => setTimeout(resolve, 100));
  const runningSnapshot = await h.get(spaceId);
  const currentUser = runningSnapshot.messages.find((item) => item.id === freezeIds.message);
  assert.equal(currentUser?.metadata?.feedbackAvailable, false);
  const currentReaction = await h.feedback(reactionPath(currentUser!.id), {
    method: "PUT", body: JSON.stringify({ sessionId: runningSnapshot.sessionId, reaction: "like" }),
  });
  assert.equal(currentReaction.status, 404);
  const oldReaction = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: runningSnapshot.sessionId, reaction: "like" }),
  });
  assert.equal(oldReaction.status, 200);
  assert.equal((await h.request("/api/conversation/stop", {
    method: "POST",
    body: JSON.stringify({ spaceId, runId: freezeIds.run }),
  })).status, 200);
  assert.match(await (await freezeResponse).text(), /RUN_ERROR/);

  // reset 生成新 sessionId；旧反馈代次拒绝且文件不迁移到新会话。
  const reset = await h.request(`/api/spaces/${spaceId}/reset`, {
    method: "POST", body: JSON.stringify({ clearSchedules: false }),
  });
  assert.equal(reset.status, 200);
  const newSessionId = ((await reset.json()) as { sessionId: string }).sessionId;
  const oldSessionCall = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: afterRun.sessionId, reaction: "like" }),
  });
  assert.equal(oldSessionCall.status, 409);
  await assert.rejects(stat(join(h.dataDir, "messages", spaceId)), { code: "ENOENT" });
  const newSnapshot = await h.get(spaceId);
  assert.equal(newSnapshot.sessionId, newSessionId);
  assert.deepEqual(newSnapshot.messages, []);

  const deleteResult = await h.request(`/api/spaces/${spaceId}`, { method: "DELETE" });
  assert.equal(deleteResult.status, 200);
  const missing = await h.feedback(reactionPath(user.id), {
    method: "PUT", body: JSON.stringify({ sessionId: newSessionId, reaction: "like" }),
  });
  assert.equal(missing.status, 404);
});

test("message feedback validates auth, ownership, notification facts, and raw event scope", async (t) => {
  const h = await fixture(t);
  const conversation = await h.service().conversationHub.forSpace("local-main");
  await conversation.notify("notification fact", "feedback-notification");
  const snapshot = await h.get("local-main");
  const notification = snapshot.messages.find((item) => item.id === "feedback-notification");
  assert.ok(notification?.metadata && notification.feedback);
  assert.equal(notification.metadata!.source, "notification");
  assert.equal(notification.metadata!.feedbackAvailable, true);
  const sessionId = snapshot.sessionId;
  assert.ok(sessionId);

  const base = `/api/spaces/local-main/messages/feedback-notification/feedback`;
  assert.equal((await h.feedback(`${base}?sessionId=${encodeURIComponent(sessionId)}`)).status, 200);
  assert.equal((await h.feedback(`${base}?sessionId=other-session`)).status, 409);
  assert.equal((await h.service().app.request(base)).status, 401);
  assert.equal((await h.feedback(`/api/spaces/missing-space/messages/x/feedback?sessionId=s`)).status, 404);

  const eventsPath = `${base}/events?sessionId=${encodeURIComponent(sessionId)}`;
  const events = (await (await h.feedback(eventsPath)).body as { events: unknown[] }).events;
  assert.deepEqual(events, []);

  // 通知没有 runId；空闲和流式运行期间都不能被空 runId 比较误禁用。
});
