export const NEWS_INTERNAL_SPACE_ID = "news-internal";

export type NewsSource = {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  lastFetchedAt: string | null;
  lastError: string | null;
};

export type NewsState = {
  schemaVersion: 1;
  sources: NewsSource[];
  lastRefreshedAt: string | null;
  lastError: string | null;
};

export const defaultNewsState = (): NewsState => ({
  schemaVersion: 1,
  sources: [],
  lastRefreshedAt: null,
  lastError: null,
});

export type NewsRepository = {
  read: () => Promise<NewsState>;
  update: <T>(change: (state: NewsState) => { state?: NewsState; result: T }) => Promise<T>;
  validate: () => Promise<void>;
};

export type ParsedFeedItem = {
  externalId: string;
  title: string;
  url: string | null;
  content: string;
  publishedAt?: string;
};

export type ParsedFeed = {
  title: string;
  items: ParsedFeedItem[];
};
