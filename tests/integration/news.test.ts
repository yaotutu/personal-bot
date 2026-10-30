import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { threadInstructionsFile } from "../../src/adapters/storage/data-layout.js";
import { readThreadInstructions } from "../../src/adapters/storage/thread-instructions.js";
import { NEWS_INTERNAL_SPACE_ID } from "../../src/features/news/types.js";
import {
  newsArticleListResponseSchema,
  newsFeedbackResponseSchema,
} from "../../src/http/contracts/news.js";

const configFor = (dataDir: string) => createConfig({
  schemaVersion: 1,
  server: {},
  model: { baseUrl: "http://127.0.0.1:1", id: "test-model", apiKey: "k" },
  runtime: { dataDir, runTimeoutMs: 1000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
});

const start = async (t: test.TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-http-"));
  const service = await createService(configFor(dataDir));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    service,
    headers: { Authorization: `Bearer ${service.auth.login()}` },
  };
};

test("news HTTP surface is authenticated, stable and keeps its internal space private", async (t) => {
  const { service, headers } = await start(t);
  const spaces = await service.app.request("/api/spaces", { headers });
  assert.equal(spaces.status, 200);
  assert.deepEqual(
    ((await spaces.json()) as { spaces: Array<{ id: string }> }).spaces.map((space) => space.id),
    ["local-main"],
  );

  for (const path of ["/api/news/status", "/api/news/sources", "/api/news/preferences"]) {
    assert.equal((await service.app.request(path, { headers })).status, 200, path);
  }
  const allArticles = await service.app.request("/api/news/articles?savedOnly=false", { headers });
  assert.equal(allArticles.status, 200);
  assert.deepEqual(newsArticleListResponseSchema.parse(await allArticles.json()), {
    articles: [],
    nextCursor: null,
  });
  const savedArticles = await service.app.request("/api/news/articles?savedOnly=true", { headers });
  assert.equal(savedArticles.status, 200);
  assert.deepEqual(newsArticleListResponseSchema.parse(await savedArticles.json()), {
    articles: [],
    nextCursor: null,
  });
  const invalidSaved = await service.app.request("/api/news/articles?savedOnly=1", { headers });
  assert.equal(invalidSaved.status, 400);
  const [article] = await service.information.ingestNews(NEWS_INTERNAL_SPACE_ID, [{
    source: "newssource_http",
    externalId: "article-feedback-contract",
    title: "Feedback response contract",
    content: "Strict feedback response projection.",
    metadata: {
      sourceId: "newssource_http",
      sourceTitle: "HTTP Feed",
      url: "https://example.com/article-feedback-contract",
    },
  }]);
  assert.ok(article);
  const feedbackCall = async (label: string, path: string, init: RequestInit) => {
    const response = await service.app.request(path, { ...init, headers });
    assert.equal(response.status, 200, label);
    const parsed = newsFeedbackResponseSchema.parse(await response.json());
    assert.deepEqual(Object.keys(parsed.feedback).sort(), ["comments", "reaction", "saved"]);
    assert.equal(Object.hasOwn(parsed.feedback, "itemId"), false);
    return parsed;
  };
  const reacted = await feedbackCall(
    "reaction response",
    `/api/news/articles/${article.id}/reaction`,
    { method: "PUT", body: JSON.stringify({ reaction: "like" }) },
  );
  assert.equal(reacted.feedback.reaction, "like");
  const saved = await feedbackCall(
    "saved response",
    `/api/news/articles/${article.id}/saved`,
    { method: "PUT", body: JSON.stringify({ saved: true }) },
  );
  assert.equal(saved.feedback.saved, true);
  const commented = await feedbackCall(
    "comment response",
    `/api/news/articles/${article.id}/comments`,
    { method: "POST", body: JSON.stringify({ text: "  strict comment  " }) },
  );
  assert.equal(commented.feedback.comments.length, 1);
  const comment = commented.feedback.comments[0]!;
  assert.match(comment.id, /^comment_/);
  assert.equal(comment.text, "strict comment");
  assert.equal(comment.createdAt, comment.updatedAt);
  const deletedComment = await feedbackCall(
    "delete comment response",
    `/api/news/articles/${article.id}/comments/${comment.id}`,
    { method: "DELETE" },
  );
  assert.equal(deletedComment.feedback.reaction, "like");
  assert.equal(deletedComment.feedback.saved, true);
  assert.deepEqual(deletedComment.feedback.comments, []);
  const credentialUrl = new URL("https://example.com/feed.xml");
  credentialUrl.username = "user";
  (credentialUrl as unknown as Record<string, string>)["pass" + "word"] = "opaque";
  const credentialSource = await service.app.request("/api/news/sources", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: credentialUrl.toString() }),
  });
  assert.equal(credentialSource.status, 400);

  for (const path of [
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}/instructions`,
    `/api/spaces/news%2Dinternal/instructions`,
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}/skills`,
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}/dream`,
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}/information/settings`,
    `/api/conversation?spaceId=${NEWS_INTERNAL_SPACE_ID}`,
    `/api/jobs?spaceId=${NEWS_INTERNAL_SPACE_ID}`,
    `/api/workspace/files?scope=space&spaceId=${NEWS_INTERNAL_SPACE_ID}&path=.`,
  ]) {
    assert.equal((await service.app.request(path, { headers })).status, 404, path);
  }
  const ordinaryPrefix = await service.app.request("/api/spaces/news-internal-extra/instructions", { headers });
  assert.equal(ordinaryPrefix.status, 200, "only the exact reserved ID is hidden");
  const dream = await service.app.request("/api/agent/dream", { headers });
  assert.equal(dream.status, 200);
  assert.ok(!JSON.stringify(await dream.json()).includes(NEWS_INTERNAL_SPACE_ID));
  const reset = await service.app.request(
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}/reset`,
    { method: "POST", headers, body: "{}" },
  );
  assert.equal(reset.status, 404);
  const deleted = await service.app.request(
    `/api/spaces/${NEWS_INTERNAL_SPACE_ID}`,
    { method: "DELETE", headers },
  );
  assert.equal(deleted.status, 404);
  const run = await service.app.request("/api/conversation/run", {
    method: "POST",
    headers,
    body: JSON.stringify({
      spaceId: NEWS_INTERNAL_SPACE_ID,
      runId: "run-1",
      expectedRevision: "empty",
      message: { id: "message-1", content: "hello" },
    }),
  });
  assert.equal(run.status, 400);
  const monitor = await service.app.request("/api/monitors", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: "https://example.com",
      condition: "change",
      originSpaceId: NEWS_INTERNAL_SPACE_ID,
    }),
  });
  assert.equal(monitor.status, 404);
});

test("ordinary information HTTP contracts do not expose internal recommendation fields", async (t) => {
  const { service, headers } = await start(t);
  const settings = await service.app.request("/api/spaces/local-main/information/settings", { headers });
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { enabled: false, batchWindowSeconds: 15 });
  const preferences = await service.app.request("/api/spaces/local-main/information/preferences", { headers });
  assert.equal(preferences.status, 200);
  assert.deepEqual(await preferences.json(), { notes: "", feedbackExamples: [] });
});

test("news default instructions require Chinese output without translating RSS", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-instructions-"));
  const service = await createService(configFor(dataDir));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const instructions = await readThreadInstructions(
    threadInstructionsFile(service.layout, NEWS_INTERNAL_SPACE_ID),
  );
  assert.match(instructions, /recommendation reasons and learnedNotes in concise Simplified Chinese/);
  assert.match(instructions, /Keep RSS titles and article content in their original language; never translate them/);
});

test("news initialization preserves existing internal instructions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-existing-instructions-"));
  const instructionsFile = join(dataDir, "sessions", NEWS_INTERNAL_SPACE_ID, "INSTRUCTIONS.md");
  const custom = "# User-managed news instructions\n\nKeep this exact text.";
  await mkdir(join(dataDir, "sessions", NEWS_INTERNAL_SPACE_ID), { recursive: true });
  await writeFile(instructionsFile, custom);
  const service = await createService(configFor(dataDir));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(await readFile(instructionsFile, "utf8"), custom);
});
