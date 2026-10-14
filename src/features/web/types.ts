/** 搜索供应商返回的最小结构；协议和供应商细节留在 adapter。 */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/** HTTP adapter 返回的已解码文本页面，不把流/状态码等底层对象带进业务层。 */
export type FetchedWebPage = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
};

/** feature 只依赖业务 port；后续替换搜索供应商或增加代理时不影响工具层。 */
export type WebTransport = {
  search: (query: string, count: number) => Promise<WebSearchResult[]>;
  fetch: (url: string) => Promise<FetchedWebPage>;
};

export type WebService = {
  search: (query: string, count?: number) => Promise<string>;
  fetch: (
    url: string,
    extractMode?: "markdown" | "text",
    maxChars?: number,
  ) => Promise<string>;
};
