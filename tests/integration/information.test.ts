import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createFakeModel, type ModelRequest } from "../support/fake-model.js";
import { createConfig } from "../../src/config/load-config.js";
import { createService } from "../../src/bootstrap/create-service.js";
import { conversationResponse } from "../../src/http/contracts/responses.js";
import { waitForTest } from "../support/http-client.js";

type Snapshot = ReturnType<typeof conversationResponse.parse>;
type RunDetail = {
  run: {
    id: string;
    status: string;
    itemIds: string[];
    model?: { status: string };
    decisions?: Array<{ itemId: string; decision: string }>;
    publications?: Array<{ status: string; notificationId?: string; receipt?: { sessionId: string; messageId: string } }>;
  };
  items: Array<{ id: string; status: string; content: string }>;
};

const requestText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => typeof part === "object" && part !== null && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "")
          .join("")
      : "";

const requestToolNames = (request: ModelRequest): string[] =>
  (request.tools ?? []).flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const direct = (tool as { name?: unknown }).name;
    const nested = (tool as { function?: { name?: unknown } }).function?.name;
    const name = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
    return name ? [name] : [];
  }).sort();

const fixture = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-"));
  const model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir, runTimeoutMs: 20_000 },
  });
  let service = await createService(config);
  const token = service.auth.login();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const restart = async () => {
    await service.close();
    service = await createService(config);
  };
  t.after(async () => {
    try { await service.close(); } finally {
      try { await model.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const call = async (path: string, init?: RequestInit) => {
    const response = await service.app.request(path, { headers, ...init });
    return { status: response.status, body: await response.json().catch(() => undefined) as unknown };
  };
  const setupSpace = async (spaceId: string, settings: { enabled: boolean; batchWindowSeconds: number }, instructions = "") => {
    assert.equal((await call(`/api/spaces/${spaceId}/instructions`, { method: "PUT", body: JSON.stringify({ instructions }) })).status, 200);
    const saved = await call(`/api/spaces/${spaceId}/information/settings`, {
      method: "PUT", body: JSON.stringify(settings),
    });
    assert.equal(saved.status, 200);
  };
  const history = async (spaceId: string) => conversationResponse.parse(
    (await call(`/api/conversation?spaceId=${encodeURIComponent(spaceId)}`)).body,
  );
  const runChat = async (spaceId: string, content: string) => {
    const before = await history(spaceId);
    const response = await service.app.request("/api/conversation/run", {
      headers,
      method: "POST",
      body: JSON.stringify({
        spaceId,
        runId: randomUUID(),
        expectedRevision: before.revision,
        message: { id: randomUUID(), content },
      }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const startFreeze = async (spaceId: string) => {
    const before = await history(spaceId);
    const requestBaseline = model.requests.length;
    const response = service.app.request("/api/conversation/run", {
      headers,
      method: "POST",
      body: JSON.stringify({
        spaceId,
        runId: randomUUID(),
        expectedRevision: before.revision,
        message: { id: randomUUID(), content: "freeze" },
      }),
    });
    await waitForTest(() => model.requests.slice(requestBaseline).some((request) =>
      request.messages.some((message) => requestText(message.content).includes("freeze"))), "freeze model request");
    return response;
  };
  return { call, dataDir, history, model, restart, runChat, service: () => service, setupSpace, startFreeze };
};

test("information HTTP ingestion, SDK decisions, notifications and feedback projection stay traceable", async (t) => {
  const h = await fixture(t);
  const spaceId = "information-main";
  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 }, "Always be concise.");
  assert.deepEqual(
    (await h.call(`/api/spaces/${spaceId}/information/settings`)).body,
    { enabled: true, batchWindowSeconds: 3600 },
  );

  const disabled = await h.call(`/api/spaces/information-missing/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "1", content: "x" }] }),
  });
  assert.equal(disabled.status, 404);

  const inserted = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [
      { source: "rss", externalId: "mixed-1", content: "NOTIFY server release", title: "Release", receivedAt: "2026-10-29T01:00:00.000Z" },
      { source: "rss", externalId: "mixed-2", content: " silent routine noise EMPTY_FINAL", title: "Noise" },
    ] }),
  });
  assert.equal(inserted.status, 200);
  const items = (inserted.body as { items: Array<{ id: string; content: string; title?: string }> }).items;
  assert.equal(items[0]?.title, "Release");
  assert.equal(items[1]?.content, " silent routine noise EMPTY_FINAL");

  const repeat = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-1", content: "NOTIFY server release", title: "Release", receivedAt: "2026-10-29T01:00:00.000Z" }] }),
  });
  assert.equal(repeat.status, 200);
  assert.deepEqual((repeat.body as { items: Array<{ id: string }> }).items.map((item) => item.id), [items[0]?.id]);
  const conflict = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-1", content: "different", title: "Release", receivedAt: "2026-10-29T01:00:00.000Z" }] }),
  });
  assert.equal(conflict.status, 409);
  const sameBatchConflict = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [
      { source: "rss", externalId: "same-batch", content: "one" },
      { source: "rss", externalId: "same-batch", content: "two" },
    ] }),
  });
  assert.equal(sameBatchConflict.status, 409);
  const listAfterConflicts = await h.call(`/api/spaces/${spaceId}/information/items?limit=100`);
  assert.equal((listAfterConflicts.body as { items: unknown[] }).items.length, 2);
  const omittedTimeRepeat = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-2", content: " silent routine noise EMPTY_FINAL", title: "Noise" }] }),
  });
  assert.equal(omittedTimeRepeat.status, 200);
  assert.equal((omittedTimeRepeat.body as { items: Array<{ id: string }> }).items[0]?.id, items[1]?.id);
  const titleConflict = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-1", content: "NOTIFY server release", title: "Changed", receivedAt: "2026-10-29T01:00:00.000Z" }] }),
  });
  assert.equal(titleConflict.status, 409);
  const timeConflict = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-1", content: "NOTIFY server release", title: "Release", receivedAt: "2026-10-29T02:00:00.000Z" }] }),
  });
  assert.equal(timeConflict.status, 409);

  const baseline = await h.history(spaceId);
  const runTraceBaseline = h.model.requests.length;
  const runResponse = await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
  assert.equal(runResponse.status, 200);
  const firstRun = runResponse.body as RunDetail;
  assert.equal(firstRun.run.status, "completed");
  assert.equal(firstRun.run.model?.status, "succeeded");
  assert.equal(firstRun.run.decisions?.find((decision) => decision.itemId === items[0]?.id)?.decision, "notify");
  assert.equal(firstRun.run.decisions?.find((decision) => decision.itemId === items[1]?.id)?.decision, "silent");
  assert.equal(firstRun.run.publications?.[0]?.status, "published");
  const receipt = firstRun.run.publications?.[0]?.receipt;
  assert.ok(receipt?.sessionId && receipt.messageId);
  const backgroundRequests = h.model.requests.slice(runTraceBaseline);
  assert.equal(backgroundRequests.length, 2);
  for (const request of backgroundRequests) {
    assert.deepEqual(requestToolNames(request), ["submit_information_result"]);
  }

  const afterNotify = await h.history(spaceId);
  assert.ok(afterNotify.messages.length > baseline.messages.length);
  const notification = afterNotify.messages.find((message) => message.id === receipt.messageId);
  assert.equal(notification?.metadata?.source, "notification");
  assert.ok(notification?.metadata?.notificationId);

  await h.call(`/api/spaces/${spaceId}/messages/${encodeURIComponent(receipt.messageId)}/feedback/comments`, {
    method: "POST", body: JSON.stringify({ sessionId: receipt.sessionId, text: "old preference" }),
  }).then(async (created) => {
    const comments = (created.body as { comments: Array<{ id: string }> }).comments;
    await h.call(`/api/spaces/${spaceId}/messages/${encodeURIComponent(receipt.messageId)}/feedback/comments/${comments.at(-1)!.id}`, {
      method: "PATCH", body: JSON.stringify({ sessionId: receipt.sessionId, text: "latest preference" }),
    });
  });
  await h.call(`/api/spaces/${spaceId}/messages/${encodeURIComponent(receipt.messageId)}/feedback/reaction`, {
    method: "PUT", body: JSON.stringify({ sessionId: receipt.sessionId, reaction: "like" }),
  });
  const preferences = await h.call(`/api/spaces/${spaceId}/information/preferences`);
  const examples = (preferences.body as { feedbackExamples: Array<{ comments: string[]; reaction: string; items: Array<{ source: string }> }> }).feedbackExamples;
  assert.equal(examples[0]?.reaction, "like");
  assert.deepEqual(examples[0]?.comments, ["latest preference"]);
  assert.equal(examples[0]?.items[0]?.source, "rss");

  const silent = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "silent-only", content: "silent only batch" }] }),
  });
  const silentId = (silent.body as { items: Array<{ id: string }> }).items[0]!.id;
  const silentRun = await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
  assert.equal((silentRun.body as RunDetail).run.decisions?.[0]?.decision, "silent");
  const afterSilent = await h.history(spaceId);
  assert.equal(afterSilent.revision, afterNotify.revision);
  assert.equal(afterSilent.messages.length, afterNotify.messages.length);

  const traceBaseline = h.model.requests.length;
  await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "feedback-check", content: "NOTIFY feedback check" }] }),
  });
  await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
  const feedbackRequest = h.model.requests.slice(traceBaseline).find((request) =>
    request.messages.some((message) => requestText(message.content).includes("UNTRUSTED INPUT DATA")),
  );
  assert.ok(feedbackRequest?.messages.some((message) => requestText(message.content).includes("latest preference")));

  const chatTraceBaseline = h.model.requests.length;
  const chatStream = await h.runChat(spaceId, "查询信息");
  assert.match(chatStream, /RUN_FINISHED/);
  assert.ok(h.model.requests.slice(chatTraceBaseline).some((request) =>
    requestToolNames(request).includes("information") &&
    request.messages.some((message) => requestText(message.content).includes("查询信息")),
  ));

  const other = "information-other";
  await h.setupSpace(other, { enabled: false, batchWindowSeconds: 15 });
  const isolated = await h.call(`/api/spaces/${other}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "mixed-1", content: "different space" }] }),
  });
  assert.equal(isolated.status, 409);
  const otherList = await h.call(`/api/spaces/${other}/information/items`);
  assert.deepEqual((otherList.body as { items: unknown[] }).items, []);

  const duplicateQuery = await h.call(`/api/spaces/${spaceId}/information/items?limit=1&limit=2`);
  assert.equal(duplicateQuery.status, 400);
  const invalidItem = await h.call(`/api/spaces/${spaceId}/information/items/${"bad".padEnd(129, "x")}`);
  assert.equal(invalidItem.status, 400);
  const invalidRun = await h.call(`/api/spaces/${spaceId}/information/runs/${"bad".padEnd(129, "x")}`);
  assert.equal(invalidRun.status, 400);
  assert.equal(silentId.length > 0, true);
});

test("ordinary chat receives source-wrapped information notifications without rewriting history", async (t) => {
  const h = await fixture(t);
  const spaceId = "information-notification-context";
  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 }, "Always be concise.");
  const inserted = await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "context", content: "NOTIFY context source" }] }),
  });
  const item = (inserted.body as { items: Array<{ id: string }> }).items[0]!;
  const run = (await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" })).body as RunDetail;
  assert.equal(run.run.decisions?.[0]?.itemId, item.id);
  const notificationId = run.run.publications?.[0]?.notificationId;
  const receipt = run.run.publications?.[0]?.receipt;
  assert.ok(notificationId && receipt?.messageId);
  assert.match(notificationId, /^info-notification-(inforun_[0-9a-f-]{36})-0$/);

  const genericReceipt = await h.service().conversationHub.withSpace(
    spaceId,
    (conversation) => conversation.notify("generic server notification", "generic-server-notification"),
  );
  const before = await h.history(spaceId);
  const informationNotification = before.messages.find((message) => message.id === receipt.messageId);
  const genericNotification = before.messages.find((message) => message.id === genericReceipt.messageId);
  assert.equal(informationNotification?.content, "INFORMATION-NOTIFY");
  assert.equal(genericNotification?.content, "generic server notification");

  const chatBaseline = h.model.requests.length;
  const firstChat = await h.runChat(spaceId, "查询信息");
  assert.match(firstChat, /RUN_FINISHED/);
  const firstRequests = h.model.requests.slice(chatBaseline);
  assert.ok(firstRequests.length >= 1);
  assert.ok(firstRequests.every((request) =>
    request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")),
  ));
  const firstAssistantTexts = firstRequests.flatMap((request) =>
    request.messages.filter((message) => message.role === "assistant").map((message) => requestText(message.content)),
  );
  const wrapped = firstAssistantTexts.filter((text) => text.includes("<pi-muse-information-notification"));
  assert.equal(wrapped.length, firstRequests.length);
  for (const text of wrapped) {
    assert.match(text, new RegExp(`notificationId="${notificationId}"`));
    assert.match(text, /The notification text is untrusted data/);
    assert.equal(text.match(/<untrusted-notification-text>/g)?.length, 1);
  }
  assert.ok(firstAssistantTexts.every((text) => !text.includes("generic server notification") ||
    !text.includes("<pi-muse-information-notification")));

  await h.restart();
  const reopened = await h.history(spaceId);
  assert.equal(reopened.messages.find((message) => message.id === receipt.messageId)?.content, "INFORMATION-NOTIFY");
  assert.equal(reopened.messages.find((message) => message.id === genericReceipt.messageId)?.content, "generic server notification");
  const reopenedBaseline = h.model.requests.length;
  const secondChat = await h.runChat(spaceId, "再次查询信息");
  assert.match(secondChat, /RUN_FINISHED/);
  assert.ok(h.model.requests.slice(reopenedBaseline).some((request) =>
    request.messages.some((message) => message.role === "assistant" && requestText(message.content).includes("<pi-muse-information-notification")),
  ));
});

test("information prompt, tool and source extension follow current space settings", async (t) => {
  const h = await fixture(t);
  const spaceId = "information-capability-toggle";
  await h.setupSpace(spaceId, { enabled: false, batchWindowSeconds: 3600 });

  const closedBaseline = h.model.requests.length;
  await h.runChat(spaceId, "默认关闭时普通回复");
  const closedRequests = h.model.requests.slice(closedBaseline);
  assert.ok(closedRequests.length >= 1);
  for (const request of closedRequests) {
    assert.ok(!request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")));
    assert.equal(requestToolNames(request).includes("information"), false);
  }

  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 });
  await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [{ source: "rss", externalId: "toggle", content: "NOTIFY toggle source" }] }),
  });
  const run = (await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" })).body as RunDetail;
  const receipt = run.run.publications?.[0]?.receipt;
  assert.ok(receipt?.messageId);

  const enabledBaseline = h.model.requests.length;
  await h.runChat(spaceId, "查询信息");
  const enabledRequests = h.model.requests.slice(enabledBaseline);
  assert.ok(enabledRequests.length >= 1);
  for (const request of enabledRequests) {
    assert.ok(request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")));
    assert.equal(requestToolNames(request).includes("information"), true);
    assert.ok(request.messages.some((message) => message.role === "assistant" && requestText(message.content).includes("<pi-muse-information-notification")));
  }

  const other = "information-capability-other";
  await h.setupSpace(other, { enabled: false, batchWindowSeconds: 3600 });
  const otherBaseline = h.model.requests.length;
  await h.runChat(other, "另一个空间普通回复");
  for (const request of h.model.requests.slice(otherBaseline)) {
    assert.ok(!request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")));
    assert.equal(requestToolNames(request).includes("information"), false);
  }

  const beforeDisable = await h.history(spaceId);
  await h.setupSpace(spaceId, { enabled: false, batchWindowSeconds: 3600 });
  assert.deepEqual(await h.history(spaceId), beforeDisable);
  const disabledBaseline = h.model.requests.length;
  await h.runChat(spaceId, "关闭后普通回复");
  const disabledRequests = h.model.requests.slice(disabledBaseline);
  for (const request of disabledRequests) {
    assert.ok(!request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")));
    assert.equal(requestToolNames(request).includes("information"), false);
    assert.ok(request.messages.some((message) => message.role === "assistant" && requestText(message.content).includes("INFORMATION-NOTIFY")));
    assert.ok(!request.messages.some((message) => message.role === "assistant" && requestText(message.content).includes("<pi-muse-information-notification")));
  }

  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 });
  const reenabledBaseline = h.model.requests.length;
  await h.runChat(spaceId, "重新启用后普通回复");
  assert.ok(h.model.requests.slice(reenabledBaseline).some((request) =>
    request.messages.some((message) => message.role === "system" && requestText(message.content).includes("## Information background notifications")) &&
    requestToolNames(request).includes("information") &&
    request.messages.some((message) => message.role === "assistant" && requestText(message.content).includes("<pi-muse-information-notification")),
  ));
});

test("invalid structured model submissions fail without retry or notification", async (t) => {
  const h = await fixture(t);
  const spaceId = "information-invalid";
  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 });
  await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST",
    body: JSON.stringify({ items: [
      { source: "rss", externalId: "invalid", content: "INVALID_SUBMISSION item" },
      { source: "rss", externalId: "other", content: "also requires exact coverage" },
    ] }),
  });
  const traceBaseline = h.model.requests.length;
  const failed = await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
  assert.equal(failed.status, 200);
  const detail = failed.body as RunDetail;
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.run.model?.status, "failed");
  assert.deepEqual(detail.run.publications, []);
  assert.equal(detail.items.every((item) => item.status === "failed"), true);
  assert.equal(h.model.requests.length - traceBaseline >= 2, true);
  assert.equal((await h.history(spaceId)).messages.length, 0);
  const retry = await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
  assert.equal(retry.status, 409);
  assert.equal((retry.body as { code?: string }).code, "NO_PENDING");
});

test("information runner allows one invalid correction but rejects duplicate or SDK-failed submissions", async (t) => {
  const h = await fixture(t);
  const run = async (spaceId: string, content: string) => {
    await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 3600 });
    const ingested = await h.call(`/api/spaces/${spaceId}/information/items`, {
      method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: spaceId, content }] }),
    });
    assert.equal(ingested.status, 200);
    const baseline = h.model.requests.length;
    const response = await h.call(`/api/spaces/${spaceId}/information/runs`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    return { detail: response.body as RunDetail, requests: h.model.requests.length - baseline };
  };

  const corrected = await run("information-correction", "NOTIFY INVALID_THEN_VALID item");
  assert.equal(corrected.detail.run.status, "completed");
  assert.equal(corrected.detail.run.model?.status, "succeeded");
  assert.equal(corrected.detail.run.decisions?.[0]?.decision, "notify");
  assert.equal(corrected.detail.run.publications?.[0]?.status, "published");
  assert.equal(corrected.requests, 3);
  assert.equal(
    (await h.history("information-correction")).messages.filter((message) => message.metadata?.source === "notification").length,
    1,
  );

  const onlyInvalid = await run("information-only-invalid", "INVALID_SUBMISSION item");
  assert.equal(onlyInvalid.detail.run.status, "failed");
  assert.equal(onlyInvalid.detail.run.model?.status, "failed");
  assert.deepEqual(onlyInvalid.detail.run.publications, []);
  assert.equal(onlyInvalid.requests, 2);

  const twoValid = await run("information-two-valid", "NOTIFY TWO_VALID_SUBMISSIONS item");
  assert.equal(twoValid.detail.run.status, "failed");
  assert.equal(twoValid.detail.run.model?.status, "failed");
  assert.deepEqual(twoValid.detail.run.publications, []);
  assert.equal(twoValid.requests, 3);

  const sdkError = await run("information-sdk-error", "NOTIFY VALID_THEN_SDK_ERROR item");
  assert.equal(sdkError.detail.run.status, "failed");
  assert.equal(sdkError.detail.run.model?.status, "failed");
  assert.deepEqual(sdkError.detail.run.publications, []);
  assert.equal(sdkError.requests, 2);

  for (const spaceId of ["information-only-invalid", "information-two-valid", "information-sdk-error"]) {
    assert.equal((await h.history(spaceId)).messages.length, 0, `${spaceId} must not write chat history`);
  }
});

test("automatic scheduler processes an immediate batch and restart preserves pending facts", async (t) => {
  const h = await fixture(t);
  const spaceId = "information-auto";
  await h.setupSpace(spaceId, { enabled: true, batchWindowSeconds: 0 });
  await h.call(`/api/spaces/${spaceId}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "imap", externalId: "auto", content: "NOTIFY automatic item" }] }),
  });
  const detail = await waitForTest(async () => {
    const page = await h.call(`/api/spaces/${spaceId}/information/runs`);
    const run = (page.body as { runs: RunDetail["run"][] }).runs[0];
    return run?.status === "completed" &&
      Boolean(run.publications?.length) &&
      run.publications?.every((publication) => publication.status !== "pending")
      ? run
      : undefined;
  }, "automatic information run", 4000);
  assert.equal(detail.publications?.[0]?.status, "published");

  // 模拟崩溃后遗留：running 与“模型已完成但发布未确认”都必须启动校准，且不重跑模型。
  const file = join(h.dataDir, "information", `${spaceId}.json`);
  const state = JSON.parse(await readFile(file, "utf8")) as {
    items: Array<{ status: string }>;
    runs: RunDetail["run"][];
  };
  const interrupted = state.runs[0]!;
  interrupted.status = "running";
  state.items.forEach((item) => { item.status = "processing"; });
  interrupted.publications?.forEach((publication) => {
    publication.status = "pending";
    delete publication.receipt;
  });
  await writeFile(file, JSON.stringify({ ...state, runs: [interrupted, ...state.runs.slice(1)] }, null, 2) + "\n");
  const before = h.model.requests.length;
  await h.restart();
  assert.equal(h.model.requests.length, before);
  const after = await h.call(`/api/spaces/${spaceId}/information/runs`);
  const restarted = (after.body as { runs: RunDetail["run"][] }).runs[0]!;
  assert.equal(restarted.status, "failed");
  assert.equal(restarted.publications?.[0]?.status, "failed");
});

test("disable, reset and delete cancel queued notifications without fallback or revival", async (t) => {
  const h = await fixture(t);
  const resetSpace = "information-reset";
  await h.setupSpace(resetSpace, { enabled: true, batchWindowSeconds: 3600 });
  const freezeReset = await h.startFreeze(resetSpace);

  await h.call(`/api/spaces/${resetSpace}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "disable", content: "NOTIFY disable cancellation" }] }),
  });
  const disablingRun = h.call(`/api/spaces/${resetSpace}/information/runs`, { method: "POST", body: "{}" });
  await waitForTest(async () => {
    const page = await h.call(`/api/spaces/${resetSpace}/information/runs`);
    return (page.body as { runs: RunDetail["run"][] }).runs[0]?.publications?.[0]?.status === "pending";
  }, "queued notification before disable", 4000);
  const disabled = await h.call(`/api/spaces/${resetSpace}/information/settings`, {
    method: "PUT", body: JSON.stringify({ enabled: false, batchWindowSeconds: 3600 }),
  });
  assert.equal(disabled.status, 200);
  const disabledRun = await disablingRun;
  assert.equal(disabledRun.status, 200);
  assert.equal((disabledRun.body as RunDetail).run.publications?.[0]?.status, "failed");
  assert.equal((await h.history(resetSpace)).messages.filter((message) => message.metadata?.source === "notification").length, 0);

  await h.call(`/api/spaces/${resetSpace}/information/settings`, {
    method: "PUT", body: JSON.stringify({ enabled: true, batchWindowSeconds: 3600 }),
  });
  await h.call(`/api/spaces/${resetSpace}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "reset", content: "NOTIFY reset cancellation" }] }),
  });
  const resettingRun = h.call(`/api/spaces/${resetSpace}/information/runs`, { method: "POST", body: "{}" });
  await waitForTest(async () => {
    const page = await h.call(`/api/spaces/${resetSpace}/information/runs`);
    const runs = (page.body as { runs: RunDetail["run"][] }).runs;
    return runs.some((run) => run.publications?.some((publication) => publication.status === "pending"));
  }, "queued notification before reset", 4000);
  const reset = await h.call(`/api/spaces/${resetSpace}/reset`, { method: "POST", body: "{}" });
  assert.equal(reset.status, 200);
  const resetRun = await resettingRun;
  assert.equal((resetRun.body as RunDetail).run.publications?.[0]?.status, "failed");
  assert.match(await (await freezeReset).text(), /RUN_ERROR/);
  const resetHistory = await h.history(resetSpace);
  assert.deepEqual(resetHistory.messages, []);
  const preserved = await h.call(`/api/spaces/${resetSpace}/information/settings`);
  assert.deepEqual(preserved.body, { enabled: true, batchWindowSeconds: 3600 });

  const deleteSpace = "information-delete";
  await h.setupSpace(deleteSpace, { enabled: true, batchWindowSeconds: 3600 });
  const freezeDelete = await h.startFreeze(deleteSpace);
  await h.call(`/api/spaces/${deleteSpace}/information/items`, {
    method: "POST", body: JSON.stringify({ items: [{ source: "rss", externalId: "delete", content: "NOTIFY delete cancellation" }] }),
  });
  const deletingRun = h.call(`/api/spaces/${deleteSpace}/information/runs`, { method: "POST", body: "{}" });
  await waitForTest(async () => {
    const page = await h.call(`/api/spaces/${deleteSpace}/information/runs`);
    return (page.body as { runs: RunDetail["run"][] }).runs[0]?.publications?.[0]?.status === "pending";
  }, "queued notification before delete", 4000);
  const deleted = await h.call(`/api/spaces/${deleteSpace}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const deletedRun = await deletingRun;
  if (deletedRun.status === 200) {
    assert.equal((deletedRun.body as RunDetail).run.publications?.[0]?.status, "failed");
  } else {
    assert.equal(deletedRun.status, 404);
  }
  assert.match(await (await freezeDelete).text(), /RUN_ERROR/);
  await assert.rejects(readFile(join(h.dataDir, "information", `${deleteSpace}.json`)), { code: "ENOENT" });
});
