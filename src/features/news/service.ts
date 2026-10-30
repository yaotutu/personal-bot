import { randomUUID } from "node:crypto";
import type { InformationService } from "../information/service.js";
import type { InformationArticleFeedback } from "../information/types.js";
import { NewsError } from "./errors.js";
import type { NewsRepository, NewsSource, ParsedFeed } from "./types.js";
import { NEWS_INTERNAL_SPACE_ID } from "./types.js";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SOURCE_ERROR = "RSS source fetch or parse failed";

const assertPublicFeedUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    const credentialKeys = ["username", "pass" + "word"] as const;
    if (!["http:", "https:"].includes(url.protocol) || raw.length > 2048 ||
        credentialKeys.some((key) => url[key as keyof URL] !== "")) throw new Error("invalid");
    return url.toString();
  } catch {
    throw new NewsError("INVALID_INPUT", "RSS URL must be a credential-free HTTP(S) URL");
  }
};

export type NewsServiceDependencies = {
  repository: NewsRepository;
  information: InformationService;
  ensureInternalSpace: () => Promise<void>;
  fetchFeed: (url: string, signal: AbortSignal) => Promise<ParsedFeed>;
};

/** RSS collection is a thin edge over information ingestion; no separate ranking loop. */
export const createNewsService = (deps: NewsServiceDependencies) => {
  let refreshing = false;
  let closed = false;
  let activeRefresh: Promise<{ added: number }> | undefined;
  let refreshController: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requireOpen = () => {
    if (closed) throw new NewsError("SHUTDOWN", "News service is closing");
  };

  const initialize = async () => {
    requireOpen();
    await deps.ensureInternalSpace();
    await deps.information.configureSpace(NEWS_INTERNAL_SPACE_ID, {
      enabled: true,
      batchWindowSeconds: 0,
      mode: "recommendations",
    });
  };

  const status = async () => {
    const state = await deps.repository.read();
    const counts = await deps.information.getNewsCounts(NEWS_INTERNAL_SPACE_ID);
    return {
      refreshing,
      ...counts,
      lastRefreshedAt: state.lastRefreshedAt,
      lastError: state.lastError,
    };
  };

  const listSources = async () => ({ sources: (await deps.repository.read()).sources });

  const addSource = async (input: { url: string; title?: string }) => {
    requireOpen();
    const url = assertPublicFeedUrl(input.url);
    const state = await deps.repository.read();
    if (state.sources.some((source) => source.url === url)) {
      throw new NewsError("CONFLICT", "RSS source already exists");
    }
    const controller = new AbortController();
    let parsed;
    try {
      parsed = await deps.fetchFeed(url, controller.signal);
    } catch (error) {
      if (error instanceof NewsError) throw error;
      throw new NewsError("INVALID_INPUT", SOURCE_ERROR);
    }
    const source: NewsSource = {
      id: `newssource_${randomUUID()}`,
      title: input.title?.trim() || parsed.title,
      url,
      createdAt: new Date().toISOString(),
      lastFetchedAt: null,
      lastError: null,
    };
    await deps.repository.update((current) => {
      if (current.sources.some((candidate) => candidate.url === url)) {
        throw new NewsError("CONFLICT", "RSS source already exists");
      }
      return {
        state: { ...current, sources: [...current.sources, source] },
        result: undefined,
      };
    });
    return { source };
  };

  const deleteSource = async (sourceId: string) => {
    requireOpen();
    if (refreshing) throw new NewsError("CONFLICT", "Cannot delete an RSS source while refresh is running");
    const deleted = await deps.repository.update((state) => {
      if (!state.sources.some((source) => source.id === sourceId)) return { result: false };
      return {
        state: { ...state, sources: state.sources.filter((source) => source.id !== sourceId) },
        result: true,
      };
    });
    if (!deleted) throw new NewsError("NOT_FOUND", "RSS source not found");
    return { deleted: true as const, sourceId };
  };

  const refresh = async (options: { retryFailed?: boolean } = {}) => {
    requireOpen();
    if (refreshing) throw new NewsError("REFRESHING", "RSS refresh is already running");
    refreshing = true;
    const controller = new AbortController();
    refreshController = controller;
    const work = (async () => {
      const initial = await deps.repository.read();
      let added = 0;
      let failed = false;
      for (const source of initial.sources) {
        controller.signal.throwIfAborted();
        try {
          const feed = await deps.fetchFeed(source.url, controller.signal);
          const items = feed.items.map((item) => ({
            source: source.id,
            externalId: item.externalId,
            title: item.title,
            content: item.content,
            ...(item.publishedAt ? { receivedAt: item.publishedAt } : {}),
            metadata: { sourceId: source.id, sourceTitle: source.title, url: item.url },
          }));
          added += (await deps.information.ingestNews(NEWS_INTERNAL_SPACE_ID, items)).length;
          await deps.repository.update((state) => ({
            state: {
              ...state,
              sources: state.sources.map((candidate) => candidate.id === source.id
                ? { ...candidate, lastFetchedAt: new Date().toISOString(), lastError: null }
                : candidate),
            },
            result: undefined,
          }));
        } catch (error) {
          controller.signal.throwIfAborted();
          failed = true;
          await deps.repository.update((state) => ({
            state: {
              ...state,
              sources: state.sources.map((candidate) => candidate.id === source.id
                ? { ...candidate, lastError: error instanceof NewsError ? error.message : SOURCE_ERROR }
                : candidate),
            },
            result: undefined,
          }));
        }
      }
      await deps.repository.update((state) => ({
        state: {
          ...state,
          lastRefreshedAt: new Date().toISOString(),
          lastError: failed ? SOURCE_ERROR : null,
        },
        result: undefined,
      }));
      if (options.retryFailed) {
        await deps.information.retryFailedNews(NEWS_INTERNAL_SPACE_ID);
      }
      return { added };
    })();
    activeRefresh = work;
    try {
      return await work;
    } finally {
      refreshing = false;
      activeRefresh = undefined;
      refreshController = undefined;
    }
  };

  const listArticles = (query: {
    view: "recommended" | "all";
    savedOnly: boolean;
    limit: number;
    cursor?: string;
  }) => deps.information.listNewsArticles(NEWS_INTERNAL_SPACE_ID, query);

  const getArticle = (articleId: string) =>
    deps.information.getNewsArticle(NEWS_INTERNAL_SPACE_ID, articleId);

  const feedback = async (work: () => Promise<InformationArticleFeedback>) => {
    const value = await work();
    return {
      feedback: {
        reaction: value.reaction,
        saved: value.saved,
        comments: value.comments.map(({ id, text, createdAt, updatedAt }) => ({
          id,
          text,
          createdAt,
          updatedAt,
        })),
      },
    };
  };

  const preferences = () => deps.information.getNewsPreferences(NEWS_INTERNAL_SPACE_ID);

  const savePreferences = async (notes: string) => {
    requireOpen();
    await deps.information.savePreferences(NEWS_INTERNAL_SPACE_ID, { notes });
    return preferences();
  };

  const start = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      void refresh({ retryFailed: false }).catch(() => undefined);
    }, REFRESH_INTERVAL_MS);
    timer.unref();
  };

  const close = async () => {
    if (closed) return activeRefresh?.then(() => undefined);
    closed = true;
    if (timer) clearInterval(timer);
    refreshController?.abort();
    await activeRefresh?.catch(() => undefined);
  };

  return {
    initialize,
    status,
    listSources,
    addSource,
    deleteSource,
    refresh,
    listArticles,
    getArticle,
    setReaction: (articleId: string, reaction: "like" | "dislike" | null) =>
      feedback(() => deps.information.setArticleReaction(NEWS_INTERNAL_SPACE_ID, articleId, reaction)),
    setSaved: (articleId: string, saved: boolean) =>
      feedback(() => deps.information.setArticleSaved(NEWS_INTERNAL_SPACE_ID, articleId, saved)),
    addComment: (articleId: string, text: string) =>
      feedback(() => deps.information.addArticleComment(NEWS_INTERNAL_SPACE_ID, articleId, text)),
    deleteComment: (articleId: string, commentId: string) =>
      feedback(() => deps.information.deleteArticleComment(NEWS_INTERNAL_SPACE_ID, articleId, commentId)),
    preferences,
    savePreferences,
    start,
    close,
  };
};

export type NewsService = ReturnType<typeof createNewsService>;
