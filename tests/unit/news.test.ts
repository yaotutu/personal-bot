import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { createNewsRepository } from "../../src/adapters/storage/news-repository.js";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { cleanRssText, parseRss2 } from "../../src/adapters/news/rss.js";
import { createInformationService } from "../../src/features/information/service.js";
import { createNewsService } from "../../src/features/news/service.js";
import { NEWS_INTERNAL_SPACE_ID } from "../../src/features/news/types.js";

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example Feed</title>${items}</channel></rss>`;

const item = (guid: string, title: string, date: string, content = "Details") =>
  `<item><guid>${guid}</guid><title>${title}</title><link>https://example.com/${guid}</link>` +
  `<description><![CDATA[<p>${content}</p><script>bad()</script>]]></description>` +
  `<pubDate>${date}</pubDate></item>`;

test("RSS2 parser validates stable items and strips executable markup", () => {
  const parsed = parseRss2(rss(
    item("a", "A &amp; B", "Wed, 29 Oct 2026 10:00:00 GMT", "Hello <b>world</b>") +
    item("b", "Second", "Thu, 30 Oct 2026 10:00:00 GMT"),
  ));
  assert.equal(parsed.title, "Example Feed");
  assert.equal(parsed.items[0]?.externalId, "a");
  assert.equal(parsed.items[0]?.title, "A & B");
  assert.equal(parsed.items[0]?.content, "Hello world");
  assert.equal(parsed.items[0]?.url, "https://example.com/a");
  assert.equal(parsed.items[0]?.publishedAt, "2026-10-29T10:00:00.000Z");
  assert.equal(cleanRssText("<style>x</style><p>safe</p>"), "safe");
  assert.equal(
    cleanRssText("&lt;script&gt;bad()&lt;/script&gt;&lt;p&gt;escaped safe&lt;/p&gt;"),
    "escaped safe",
  );
});

test("RSS2 parser rejects DTDs, malformed XML and items without stable fields", () => {
  assert.throws(() => parseRss2(`<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><title>x</title></channel></rss>`), {
    message: /DTD/,
  });
  assert.throws(() => parseRss2("<rss><channel>"), { message: /valid XML/ });
  assert.throws(() => parseRss2(rss(
    "<item><title>No identity</title><description>body</description></item>",
  )), { message: /guid/ });
  assert.throws(() => parseRss2(rss(
    "<item><guid>x</guid><title></title><description>body</description></item>",
  )), { message: /title/ });
  assert.throws(() => parseRss2(rss(
    "<item><guid>x</guid><title>No body</title><link>https://example.com/x</link></item>",
  )), { message: /content/ });
});

test("RSS2 parser enforces its nesting limit before traversing the parsed tree", () => {
  const nested = `${"<nested>".repeat(65)}value${"</nested>".repeat(65)}`;
  assert.throws(() => parseRss2(rss(
    "<item><guid>deep</guid><title>Deep</title><link>https://example.com/deep</link>" +
    `<description>${nested}</description><pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate></item>`,
  )), { message: /could not be parsed|nested too deeply/ });
});

test("recommendation processing projects decisions without retaining or notifying chat", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-service-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const layout = createDataLayout(dataDir);
  const informationRepository = createInformationRepository(layout);
  const newsRepository = createNewsRepository(layout.newsFile);
  let retained = false;
  let failNext = false;
  let modelInput: Parameters<Parameters<typeof createInformationService>[0]["runModel"]>[0] | undefined;
  const information = createInformationService({
    repository: informationRepository,
    spaceExists: async () => true,
    retainSpace: async () => {
      retained = true;
      return undefined;
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async (input) => {
      modelInput = input;
      if (failNext) return { ok: false, error: "MODEL_REQUEST_FAILED" };
      return {
        ok: true,
        result: {
          decisions: input.items.map((article, index) => ({
            itemId: article.id,
            decision: index === 0 ? "notify" as const : "silent" as const,
            reason: index === 0 ? "substantive release" : "routine",
          })),
          notifications: [],
          learnedNotes: "Values substantive releases.",
        },
      };
    },
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  let feed = rss(
    item("old", "Older", "Wed, 29 Oct 2026 10:00:00 GMT") +
    item("new", "Newer", "Thu, 30 Oct 2026 10:00:00 GMT"),
  );
  const news = createNewsService({
    repository: newsRepository,
    information,
    ensureInternalSpace: async () => undefined,
    fetchFeed: async () => parseRss2(feed),
  });
  await news.initialize();
  await news.savePreferences("Prefer primary sources and substantive engineering detail.");
  const { source } = await news.addSource({ url: "https://example.com/feed.xml" });
  assert.equal(source.title, "Example Feed");
  assert.equal((await news.refresh()).added, 2);
  feed = rss(
    item("old", "Older changed", "Wed, 29 Oct 2026 10:00:00 GMT", "Changed content") +
    item("new", "Newer changed", "Thu, 30 Oct 2026 10:00:00 GMT", "Changed content"),
  );
  assert.equal((await news.refresh()).added, 0, "duplicate GUIDs are accepted only once");

  const all = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.deepEqual(all.articles.map((article) => article.title), ["Newer", "Older"]);
  assert.ok(all.articles.every((article) => article.content === "Details"));
  await information.runNow(NEWS_INTERNAL_SPACE_ID);
  assert.equal(retained, false, "recommendation mode must not retain or notify a chat");
  assert.deepEqual(modelInput?.articleFeedback, []);
  assert.equal(modelInput?.preferences.notes, "Prefer primary sources and substantive engineering detail.");

  const recommended = await news.listArticles({ view: "recommended", savedOnly: false, limit: 20 });
  assert.equal(recommended.articles.length, 1);
  assert.equal(recommended.articles[0]?.recommendation?.reason, "substantive release");
  assert.deepEqual(await news.preferences(), {
    notes: "Prefer primary sources and substantive engineering detail.",
    learnedNotes: "Values substantive releases.",
  });

  const older = all.articles.find((article) => article.title === "Older")!;
  await news.setReaction(older.id, "like");
  await news.setReaction(older.id, "dislike");
  assert.equal((await news.getArticle(older.id)).article.feedback.reaction, "dislike");
  await news.setReaction(older.id, "like");
  await news.setSaved(older.id, true);
  await assert.rejects(news.addComment(older.id, "   "), /non-blank/);
  await assert.rejects(news.addComment(older.id, "x".repeat(4001)), /4000/);
  await news.addComment(older.id, "  useful context  ");
  const learnedBeforeFailure = await news.preferences();
  failNext = true;
  await information.ingestNews(NEWS_INTERNAL_SPACE_ID, [{
    source: "newssource_test",
    externalId: "after-success",
    title: "Failure must not overwrite preferences",
    content: "Content",
    metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
  }]);
  await information.runNow(NEWS_INTERNAL_SPACE_ID);
  assert.deepEqual(await news.preferences(), learnedBeforeFailure);
  await news.deleteSource(source.id);
  const retainedArticle = await news.getArticle(older.id);
  assert.equal(retainedArticle.article.feedback.reaction, "like");
  assert.equal(retainedArticle.article.feedback.saved, true);
  assert.equal(retainedArticle.article.feedback.comments[0]?.text, "useful context");
});

test("touching an old article makes its feedback recent for the next model input", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-feedback-"));
  const layout = createDataLayout(dataDir);
  const repository = createInformationRepository(layout);
  let captured: Parameters<Parameters<typeof createInformationService>[0]["runModel"]>[0] | undefined;
  const information = createInformationService({
    repository,
    spaceExists: async () => true,
    retainSpace: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async (input) => {
      captured = input;
      return {
        ok: true,
        result: {
          decisions: input.items.map((article) => ({
            itemId: article.id,
            decision: "silent" as const,
            reason: "not selected",
          })),
          notifications: [],
          learnedNotes: "",
        },
      };
    },
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  try {
    await information.configureSpace(NEWS_INTERNAL_SPACE_ID, {
      enabled: true, batchWindowSeconds: 0, mode: "recommendations",
    });
    const inserted = await information.ingestNews(NEWS_INTERNAL_SPACE_ID, Array.from({ length: 22 }, (_, index) => ({
      source: "newssource_test",
      externalId: `guid-${index}`,
      title: `Article ${index}`,
      content: `Content ${index}`,
      metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
    })));
    for (const article of inserted.slice(0, 21)) {
      await information.setArticleReaction(NEWS_INTERNAL_SPACE_ID, article.id, "like");
    }
    await information.setArticleReaction(NEWS_INTERNAL_SPACE_ID, inserted[0]!.id, "dislike");
    await information.runNow(NEWS_INTERNAL_SPACE_ID);
    assert.equal(captured?.articleFeedback[0]?.id, inserted[0]!.id);
    assert.equal(captured?.articleFeedback[0]?.reaction, "dislike");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("news pagination returns null nextCursor for an exact full page", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-pagination-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const layout = createDataLayout(dataDir);
  const information = createInformationService({
    repository: createInformationRepository(layout),
    spaceExists: async () => true,
    retainSpace: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const news = createNewsService({
    repository: createNewsRepository(layout.newsFile),
    information,
    ensureInternalSpace: async () => undefined,
    fetchFeed: async () => {
      throw new Error("not used");
    },
  });
  await news.initialize();
  await information.ingestNews(NEWS_INTERNAL_SPACE_ID, Array.from({ length: 20 }, (_, index) => ({
    source: "newssource_test",
    externalId: `guid-${index}`,
    title: `Article ${index}`,
    content: `Content ${index}`,
    metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
  })));

  const full = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.equal(full.articles.length, 20);
  assert.equal(full.nextCursor, null);

  const first = await news.listArticles({ view: "all", savedOnly: false, limit: 19 });
  assert.equal(first.articles.length, 19);
  assert.ok(first.nextCursor);
  const second = await news.listArticles({
    view: "all",
    savedOnly: false,
    limit: 19,
    cursor: first.nextCursor,
  });
  assert.equal(second.articles.length, 1);
  assert.equal(second.nextCursor, null);
});

test("background refresh keeps failed articles failed while explicit refresh requeues them", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const layout = createDataLayout(dataDir);
  const information = createInformationService({
    repository: createInformationRepository(layout),
    spaceExists: async () => true,
    retainSpace: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const feed = parseRss2(rss(item("retry", "Retry", "Wed, 29 Oct 2026 10:00:00 GMT")));
  const news = createNewsService({
    repository: createNewsRepository(layout.newsFile),
    information,
    ensureInternalSpace: async () => undefined,
    fetchFeed: async () => feed,
  });
  await news.initialize();
  await news.addSource({ url: "https://example.com/feed.xml" });
  await news.refresh({ retryFailed: true });
  await information.runNow(NEWS_INTERNAL_SPACE_ID);
  assert.deepEqual(await information.getNewsCounts(NEWS_INTERNAL_SPACE_ID), {
    processing: false,
    pendingCount: 0,
    failedCount: 1,
  });

  await news.refresh({ retryFailed: false });
  assert.deepEqual(await information.getNewsCounts(NEWS_INTERNAL_SPACE_ID), {
    processing: false,
    pendingCount: 0,
    failedCount: 1,
  });
  await news.refresh({ retryFailed: true });
  assert.deepEqual(await information.getNewsCounts(NEWS_INTERNAL_SPACE_ID), {
    processing: false,
    pendingCount: 1,
    failedCount: 0,
  });
});

test("concurrent news refresh is rejected without queueing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-refresh-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const layout = createDataLayout(dataDir);
  const information = createInformationService({
    repository: createInformationRepository(layout),
    spaceExists: async () => true,
    retainSpace: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const feed = parseRss2(rss(item("concurrent", "Concurrent", "Wed, 29 Oct 2026 10:00:00 GMT")));
  let calls = 0;
  let releaseRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const news = createNewsService({
    repository: createNewsRepository(layout.newsFile),
    information,
    ensureInternalSpace: async () => undefined,
    fetchFeed: async () => {
      calls++;
      if (calls === 1) return feed;
      markRefreshStarted();
      await refreshGate;
      return feed;
    },
  });
  await news.initialize();
  await news.addSource({ url: "https://example.com/feed.xml" });

  const active = news.refresh({ retryFailed: true });
  await refreshStarted;
  await assert.rejects(news.refresh({ retryFailed: true }), /already running/);
  releaseRefresh();
  await active;
});

test("one broken RSS source does not block another and its error stays controlled", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-source-error-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const layout = createDataLayout(dataDir);
  const information = createInformationService({
    repository: createInformationRepository(layout),
    spaceExists: async () => true,
    retainSpace: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const goodFeed = parseRss2(rss(item("good", "Good", "Wed, 29 Oct 2026 10:00:00 GMT")));
  const badFeed = parseRss2(rss(item("bad", "Bad", "Thu, 30 Oct 2026 10:00:00 GMT")));
  let failBad = false;
  const news = createNewsService({
    repository: createNewsRepository(layout.newsFile),
    information,
    ensureInternalSpace: async () => undefined,
    fetchFeed: async (url) => {
      if (url.includes("bad") && failBad) throw new Error("upstream-marker-4wrqxe7u");
      return url.includes("bad") ? badFeed : goodFeed;
    },
  });
  await news.initialize();
  const good = await news.addSource({ url: "https://example.com/good.xml" });
  await news.addSource({ url: "https://example.com/bad.xml" });
  failBad = true;

  assert.equal((await news.refresh({ retryFailed: true })).added, 1);
  const all = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.deepEqual(all.articles.map((article) => article.title), ["Good"]);
  const sources = (await news.listSources()).sources;
  assert.equal(sources.find((source) => source.id === good.source.id)?.lastError, null);
  assert.equal(
    sources.find((source) => source.url.includes("bad"))?.lastError,
    "RSS source fetch or parse failed",
  );
  assert.ok(!JSON.stringify(sources).includes("upstream-marker-4wrqxe7u"));
});
