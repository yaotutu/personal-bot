import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  newsArticleDetailResponseSchema,
  newsArticleListResponseSchema,
  newsFeedbackResponseSchema,
  newsPreferencesResponseSchema,
  newsSourceListResponseSchema,
  newsStatusResponseSchema,
} from "../../src/http/contracts/news.js";

const FIRST_FEED = "https://hnrss.org/frontpage?count=3";
const SECOND_FEED = "https://hnrss.org/ask?count=3";
const ACCESS_KEY = "news-live-access";
const SUBMIT_TOOL = "submit_information_result";

type NewsLiveOptions = {
  configPath: string;
  keepArtifacts: boolean;
  allowPrivateTargets: boolean;
};
type NewsParseOutcome =
  | { kind: "help"; help: string }
  | { kind: "ok"; options: NewsLiveOptions }
  | { kind: "error"; message: string };

const newsHelp = `真实新闻服务端验收（会抓取公网 RSS、产生模型费用和外部网络流量）

用法：node --import tsx tests/live/news.ts --config <JSON配置路径> --allow-live [--keep-artifacts] [--allow-private-targets]
  --config <path>          必填；仅读取 model，不使用原实例的 DATA_DIR、会话、工具或凭据。
  --allow-live             必填；显式允许调用真实外部模型并产生费用。
  --keep-artifacts         可选；保留隔离数据与脱敏报告，默认全部回收。
  --allow-private-targets  可选；仅本新闻验收脚本显式允许私网/loopback/Fake-IP 目标，默认 false。
                           只用于本机 DNS 返回 198.18 Fake-IP 时的隔离真实验收；生产 SSRF 默认不变。
  --help                   只显示帮助，不读取配置、不抓取 RSS、不调用模型。

重复参数会拒绝。模型凭据只从配置读取并保留在内存，不写日志或临时配置。
本命令不在 pnpm check 中运行，不自动重试模型或工具，不修改正式业务数据。
`;

const parseNewsLiveOptions = (argv: readonly string[]): NewsParseOutcome => {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.includes("--help") || args.includes("-h")) return { kind: "help", help: newsHelp };
  let configPath: string | undefined;
  let allowLive = false;
  let keepArtifacts = false;
  let allowPrivateTargets = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (seen.has(name)) return { kind: "error", message: "Duplicate live test option" };
    seen.add(name);
    if (name === "--allow-live") allowLive = true;
    else if (name === "--keep-artifacts") keepArtifacts = true;
    else if (name === "--allow-private-targets") allowPrivateTargets = true;
    else if (name === "--config") {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--"))
        return { kind: "error", message: "--config requires a JSON file path" };
      configPath = value;
    } else {
      return { kind: "error", message: "Unknown live test option; use --help" };
    }
  }
  if (!configPath) return { kind: "error", message: "Missing --config <path>; no default configuration is read" };
  if (!allowLive) return { kind: "error", message: "Refusing model calls without --allow-live" };
  return { kind: "ok", options: { configPath, keepArtifacts, allowPrivateTargets } };
};

type Service = Awaited<ReturnType<typeof import("../../src/bootstrap/create-service.js").createService>>;
type Http = ReturnType<typeof serve>;
type Proxy = Awaited<ReturnType<typeof import("../support/live-model.js").createLiveModel>>;

const waitFor = async <T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 180_000) => {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const startHttp = async (service: Service) => {
  const http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!http.listening) await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return { http, baseUrl: `http://127.0.0.1:${address.port}` };
};

const stopHttp = async (http: Http) => {
  if ("closeAllConnections" in http) http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
};

const execute = async (options: NewsLiveOptions) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error("Model configuration is required");

  let root: string | undefined;
  let dataDir: string | undefined;
  let service: Service | undefined;
  let http: Http | undefined;
  let proxy: Proxy | undefined;
  let baseUrl: string | undefined;
  let token: string | undefined;
  let serviceVersion: unknown;
  let failure: string | undefined;
  const evidence: Array<{ name: string; detail: Record<string, unknown> }> = [];

  const configFor = (dir: string) => createConfig({
    server: { host: "127.0.0.1", accessKey: ACCESS_KEY },
    model: {
      baseUrl: proxy!.baseUrl,
      id: model.modelId,
      apiKey: "proxy-placeholder",
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    },
    runtime: {
      dataDir: dir,
      runTimeoutMs: 180_000,
      schedulerIntervalMs: 200,
      monitorScanIntervalMs: 60_000,
    },
    tools: {
      presentation: { default: "summary" },
      web: { enabled: false, allowPrivateTargets: options.allowPrivateTargets },
      browser: { enabled: false },
    },
  });
  const login = async (url: string) => {
    const response = await fetch(url + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: ACCESS_KEY }),
    });
    assert.equal(response.status, 200);
    token = ((await response.json()) as { token: string }).token;
  };
  const api = async (path: string, init: RequestInit = {}) => {
    assert.ok(baseUrl && token);
    const response = await fetch(baseUrl + path, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, text };
  };
  const expect = async (label: string, path: string, status: number, init?: RequestInit) => {
    const result = await api(path, init);
    assert.equal(result.status, status, `${label}: ${result.text.slice(0, 300)}`);
    return result.body;
  };
  const status = async () => newsStatusResponseSchema.parse(await expect("status", "/api/news/status", 200));
  const allArticles = async () =>
    newsArticleListResponseSchema.parse(await expect("articles", "/api/news/articles?view=all&limit=100", 200));
  const recommended = async () =>
    newsArticleListResponseSchema.parse(await expect("recommended", "/api/news/articles?view=recommended&limit=100", 200));
  const acceptedSubmitCount = () => proxy!.traces.filter((trace) =>
    trace.toolNames.includes(SUBMIT_TOOL) &&
    trace.toolResults.some((result) => result.includes("Accepted information decisions."))).length;
  const waitAnalysis = async (label: string, baseline: number) => {
    await waitFor(label, async () => {
      const current = await status();
      return acceptedSubmitCount() > baseline && !current.processing && current.pendingCount === 0
        ? current
        : undefined;
    });
  };
  const record = (name: string, detail: Record<string, unknown>) => {
    evidence.push({ name, detail });
    process.stdout.write(`[PASS] ${name}\n`);
  };

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-news-live-"));
    dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
    service = await createService(configFor(dataDir));
    ({ http, baseUrl } = await startHttp(service));
    await login(baseUrl);
    serviceVersion = ((await expect("health", "/api/health", 200)) as { serviceVersion: unknown }).serviceVersion;

    process.stdout.write("真实新闻验收已授权：将抓取公网 RSS 并产生外部模型费用；数据均为临时隔离实例。\n");
    if (options.allowPrivateTargets) {
      process.stdout.write("本脚本已显式允许私网/Fake-IP RSS 目标；仅限当前隔离实例。\n");
    }
    const coldPreferences = newsPreferencesResponseSchema.parse(
      await expect("cold preferences", "/api/news/preferences", 200),
    );
    assert.deepEqual(coldPreferences, { notes: "", learnedNotes: "" });
    const spaces = (await expect("spaces", "/api/spaces", 200)) as { spaces: Array<{ id: string }> };
    assert.ok(!spaces.spaces.some((space) => space.id === "news-internal"));
    assert.equal((await api("/api/spaces/news-internal/instructions")).status, 404);
    const mainHistoryBefore = await expect("main history", "/api/conversation?spaceId=local-main", 200);

    const firstSource = (await expect("add first source", "/api/news/sources", 200, {
      method: "POST", body: JSON.stringify({ url: FIRST_FEED }),
    }) as { source: { id: string; title: string; url: string } }).source;
    assert.equal(firstSource.url, FIRST_FEED);
    assert.ok(firstSource.title);
    const firstBaseline = acceptedSubmitCount();
    const firstRefresh = (await expect("refresh first", "/api/news/refresh", 200, {
      method: "POST", body: "{}",
    })) as { added: number };
    assert.ok(firstRefresh.added > 0, "real RSS source must add at least one article");
    const duplicateRefresh = (await expect("refresh duplicate", "/api/news/refresh", 200, {
      method: "POST", body: "{}",
    })) as { added: number };
    assert.equal(duplicateRefresh.added, 0);

    await waitAnalysis("first structured analysis", firstBaseline);
    const firstRecommended = await recommended();
    assert.ok(firstRecommended.articles.length > 0, "cold-start feed should produce a non-empty recommendation");
    assert.ok(firstRecommended.articles.every((article) => article.recommendation?.reason));
    assert.ok(firstRecommended.articles.every((article, index, values) =>
      index === 0 || values[index - 1]!.publishedAt >= article.publishedAt));
    const firstArticle = firstRecommended.articles[0]!;
    record("real-rss-and-cold-start", {
      sourceId: firstSource.id,
      added: firstRefresh.added,
      recommended: firstRecommended.articles.length,
    });

    const commentText =
      `I prefer practical engineering deep dives and primary sources over funding news. LIVE_NEWS_FEEDBACK_${Date.now()}`;
    const reactionLike = newsFeedbackResponseSchema.parse(
      await expect("reaction like", `/api/news/articles/${firstArticle.id}/reaction`, 200, {
        method: "PUT", body: JSON.stringify({ reaction: "like" }),
      }),
    );
    assert.equal(reactionLike.feedback.reaction, "like");
    const reactionDislike = newsFeedbackResponseSchema.parse(
      await expect("reaction dislike", `/api/news/articles/${firstArticle.id}/reaction`, 200, {
        method: "PUT", body: JSON.stringify({ reaction: "dislike" }),
      }),
    );
    assert.equal(reactionDislike.feedback.reaction, "dislike");
    const reactionFinal = newsFeedbackResponseSchema.parse(
      await expect("reaction final", `/api/news/articles/${firstArticle.id}/reaction`, 200, {
        method: "PUT", body: JSON.stringify({ reaction: "like" }),
      }),
    );
    assert.equal(reactionFinal.feedback.reaction, "like");
    const savedResponse = newsFeedbackResponseSchema.parse(
      await expect("saved", `/api/news/articles/${firstArticle.id}/saved`, 200, {
        method: "PUT", body: JSON.stringify({ saved: true }),
      }),
    );
    assert.equal(savedResponse.feedback.saved, true);
    const commentResponse = newsFeedbackResponseSchema.parse(
      await expect("comment", `/api/news/articles/${firstArticle.id}/comments`, 200, {
      method: "POST", body: JSON.stringify({ text: `  ${commentText}  ` }),
      }),
    );
    assert.equal(commentResponse.feedback.comments[0]?.text, commentText);
    const disposable = newsFeedbackResponseSchema.parse(
      await expect("second comment", `/api/news/articles/${firstArticle.id}/comments`, 200, {
        method: "POST", body: JSON.stringify({ text: "delete me" }),
      }),
    );
    const disposableId = disposable.feedback.comments.find((comment) => comment.text === "delete me")!.id;
    const afterDelete = newsFeedbackResponseSchema.parse(
      await expect(
        "delete comment",
        `/api/news/articles/${firstArticle.id}/comments/${disposableId}`,
        200,
        { method: "DELETE" },
      ),
    );
    assert.equal(afterDelete.feedback.reaction, "like");
    assert.equal(afterDelete.feedback.saved, true);
    assert.deepEqual(afterDelete.feedback.comments.map((comment) => comment.text), [commentText]);
    const savedOnly = newsArticleListResponseSchema.parse(
      await expect("saved filter", "/api/news/articles?view=all&savedOnly=true&limit=100", 200),
    );
    assert.ok(savedOnly.articles.some((article) => article.id === firstArticle.id));

    const secondSource = (await expect("add second source", "/api/news/sources", 200, {
      method: "POST", body: JSON.stringify({ url: SECOND_FEED, title: "HN Ask" }),
    }) as { source: { id: string } }).source;
    const secondBaseline = acceptedSubmitCount();
    const secondRefresh = (await expect("refresh second", "/api/news/refresh", 200, {
      method: "POST", body: "{}",
    })) as { added: number };
    assert.ok(secondRefresh.added > 0);
    await waitAnalysis("feedback-informed analysis", secondBaseline);
    const secondTraces = proxy.traces.slice(-20).filter((trace) =>
      trace.toolNames.includes(SUBMIT_TOOL) &&
      trace.toolResults.some((result) => result.includes("Accepted information decisions.")));
    assert.ok(secondTraces.length > 0);
    assert.ok(secondTraces.some((trace) => trace.users.join("\n").includes(commentText)));
    const learned = newsPreferencesResponseSchema.parse(
      await expect("learned preferences", "/api/news/preferences", 200),
    );
    assert.ok(learned.learnedNotes.trim().length > 0, "successful feedback round must update learnedNotes");
    record("feedback-in-next-round", {
      articleId: firstArticle.id,
      learnedNotesLength: learned.learnedNotes.length,
      secondAdded: secondRefresh.added,
    });

    await expect("delete first source", `/api/news/sources/${firstSource.id}`, 200, { method: "DELETE" });
    const retained = newsArticleDetailResponseSchema.parse(
      await expect("retained article", `/api/news/articles/${firstArticle.id}`, 200),
    ).article;
    assert.equal(retained.feedback.reaction, "like");
    assert.equal(retained.feedback.saved, true);
    assert.ok(retained.feedback.comments.some((comment) => comment.text === commentText));
    const sourcesAfterDelete = newsSourceListResponseSchema.parse(
      await expect("sources after delete", "/api/news/sources", 200),
    );
    assert.ok(!sourcesAfterDelete.sources.some((source) => source.id === firstSource.id));
    assert.ok(sourcesAfterDelete.sources.some((source) => source.id === secondSource.id));
    record("source-delete-retains-articles", { articleId: firstArticle.id });

    const mainHistoryAfter = await expect("main history after news", "/api/conversation?spaceId=local-main", 200);
    assert.deepEqual(mainHistoryAfter, mainHistoryBefore, "news collection must not mutate the main chat");
    assert.ok(!(await allArticles()).articles.some((article) => article.content.includes("news-internal")));
    record("hidden-space-and-chat-isolation", { articleCount: (await allArticles()).articles.length });

    const articleCountBeforeRestart = (await allArticles()).articles.length;
    const currentService = service;
    const currentHttp = http;
    service = undefined;
    http = undefined;
    await currentService.close();
    await stopHttp(currentHttp);
    service = await createService(configFor(dataDir));
    ({ http, baseUrl } = await startHttp(service));
    await login(baseUrl);
    const restartedStatus = await status();
    const restartedArticles = await allArticles();
    const restartedArticle = newsArticleDetailResponseSchema.parse(
      await expect("restarted article", `/api/news/articles/${firstArticle.id}`, 200),
    ).article;
    const restartedPreferences = newsPreferencesResponseSchema.parse(
      await expect("restarted preferences", "/api/news/preferences", 200),
    );
    assert.equal(restartedStatus.refreshing, false);
    assert.equal(restartedArticles.articles.length, articleCountBeforeRestart);
    assert.equal(restartedArticle.feedback.reaction, "like");
    assert.equal(restartedArticle.feedback.saved, true);
    assert.equal(restartedPreferences.learnedNotes, learned.learnedNotes);
    assert.ok(!((await expect("restarted spaces", "/api/spaces", 200)) as {
      spaces: Array<{ id: string }>;
    }).spaces.some((space) => space.id === "news-internal"));
    record("restart-persistence", {
      articles: restartedArticles.articles.length,
      learnedNotesLength: restartedPreferences.learnedNotes.length,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    if (root && proxy && options.keepArtifacts) {
      const summary = {
        passed: failure === undefined,
        failure: failure ?? null,
        scenarios: evidence,
        realModelRequests: proxy.traces.length,
        acceptedStructuredSubmissions: acceptedSubmitCount(),
        serviceVersion: serviceVersion ?? null,
        cleanupFailures,
      };
      await writeFile(join(root, "summary.json"),
        redactApiKey(JSON.stringify(summary, null, 2), model.apiKey) + "\n", { mode: 0o600 });
      await writeFile(join(root, "tool-traces.json"),
        redactApiKey(JSON.stringify(proxy.traces, null, 2), model.apiKey) + "\n", { mode: 0o600 });
      process.stdout.write(`[ARTIFACTS] ${root}\n`);
    }
    if (http) {
      try { await stopHttp(http); } catch (error) { cleanupFailures.push(`HTTP close: ${String(error)}`); }
    }
    if (service) {
      try { await service.close(); } catch (error) { cleanupFailures.push(`service close: ${String(error)}`); }
    }
    if (proxy) {
      try { await proxy.close(); } catch (error) { cleanupFailures.push(`proxy close: ${String(error)}`); }
    }
    if (root && !options.keepArtifacts) {
      try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(`cleanup: ${String(error)}`); }
    }
    if (cleanupFailures.length) {
      process.exitCode = 1;
      process.stderr.write(`[CLEANUP-FAIL] ${cleanupFailures.join("; ")}\n`);
    }
  }
};

const outcome = parseNewsLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help);
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else {
  try {
    await execute(outcome.options);
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
