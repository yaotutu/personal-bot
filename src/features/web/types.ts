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
  search: (query: string, count: number, signal?: AbortSignal) => Promise<WebSearchResult[]>;
  fetch: (url: string, signal?: AbortSignal) => Promise<FetchedWebPage>;
};

/** 受控失败与成功结果通过 error 字段区分，不向调用方泄漏 transport 异常。 */
export type WebFailure = { error: string; url?: string };
export type WebSearchResponse = {
  results: WebSearchResult[];
  warnings: string[];
  truncated: boolean;
};
export type WebFetchResponse = {
  url: string;
  finalUrl: string;
  status: number;
  extractor: string;
  truncated: boolean;
  length: number;
  untrusted: true;
  text: string;
};

/** 业务调用方直接消费结构化结果；JSON 文本编码只由工具协议适配层负责。 */
export type WebService = {
  search: (query: string, count?: number, signal?: AbortSignal) => Promise<WebSearchResponse | WebFailure>;
  fetch: (
    url: string,
    extractMode?: "markdown" | "text",
    maxChars?: number,
    signal?: AbortSignal,
  ) => Promise<WebFetchResponse | WebFailure>;
};
