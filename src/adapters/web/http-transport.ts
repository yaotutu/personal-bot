import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolvePublicHost, type ResolvedAddress } from "../../shared/public-host.js";
import type {
  FetchedWebPage,
  WebSearchResult,
  WebTransport,
} from "../../features/web/types.js";

type WebHttpConfig = {
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent?: string;
  /** 本机联调/测试用：允许回环与私网目标（默认拒绝，见 config tools.web）。 */
  allowPrivateTargets?: boolean;
};

const duckDuckGoEndpoint = "https://html.duckduckgo.com/html/";
const bingRssEndpoint = "https://www.bing.com/search?format=rss";
const defaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const readBody = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  abort: () => void,
) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      abort();
      throw new Error("Response too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export type HttpRequestFn = (
  url: URL,
  config: WebHttpConfig,
  pinned: ResolvedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; url: URL }>;

const requestOnce = async (
  url: URL,
  config: WebHttpConfig,
  pinned: ResolvedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 父取消与本请求超时共用底层 request 的销毁语义，等待 headers/body 时都能中断。
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const headers = {
    "user-agent": config.userAgent || defaultUserAgent,
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    "accept-encoding": "identity",
  };
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; url: URL }>(
    (resolve, reject) => {
      const request = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          signal: requestSignal,
          lookup: (_host, options, callback) => {
            // DNS 已在上层校验并固定；这里不再让 Node 二次解析域名。
            // Node 的 Happy Eyeballs 路径会传 all=true 并要求数组；兼容两种 lookup 回调。
            if (options?.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          // 超限/取消可能在异步迭代退出后才使 response 发出 error，仍需接住并拒绝本次请求。
          response.on("error", reject);
          const statusCode = response.statusCode ?? 0;
          // 超限直接销毁响应，不向已完成并可能归还连接池的 socket 再广播 AbortSignal。
          readBody(response, config.maxResponseBytes, () => response.destroy())
            .then((body) =>
              resolve({
                status: statusCode,
                headers: response.headers,
                body,
                url,
              }),
            )
            .catch(reject);
        },
      );
      request.setTimeout(timeoutMs, () => controller.abort());
      request.on("error", reject);
      request.end();
    },
  ).finally(() => clearTimeout(timer));
};

export const safePublicGet = async (
  rawUrl: string,
  config: WebHttpConfig,
  signal?: AbortSignal,
  doRequest: HttpRequestFn = requestOnce,
) => {
  signal?.throwIfAborted();
  const deadline = Date.now() + config.timeoutMs;
  const timeoutController = new AbortController();
  const overallTimer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    combinedSignal.throwIfAborted();
    let url = new URL(rawUrl);
    let pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets, combinedSignal);
    for (let redirects = 0; redirects < 6; redirects++) {
      combinedSignal.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timeoutController.abort();
        combinedSignal.throwIfAborted();
      }
      const response = await doRequest(url, config, pinned, remainingMs, combinedSignal);
      combinedSignal.throwIfAborted();
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status < 200 || response.status >= 400)
          throw new Error(`HTTP ${response.status}`);
        const contentType = Array.isArray(response.headers["content-type"])
          ? response.headers["content-type"][0]!
          : response.headers["content-type"] ?? "";
        return {
          status: response.status,
          contentType,
          body: response.body,
          finalUrl: url.toString(),
        };
      }
      if (!location) throw new Error("Redirect without location");
      url = new URL(Array.isArray(location) ? location[0]! : location, url);
      pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets, combinedSignal);
  }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(overallTimer);
  }
};

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)));

const textOf = (html: string) =>
  normalizeSpace(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
const normalizeSpace = (value: string) =>
  value.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

const resultUrl = (href: string) => {
  const decoded = decodeEntities(href);
  const absolute = new URL(decoded, "https://duckduckgo.com");
  const target = absolute.searchParams.get("uddg");
  if (target) return target;
  return absolute.toString();
};

/** 解析 DuckDuckGo HTML 的轻量函数；不引入 DOM 依赖，也避免执行页面脚本。 */
export const parseDuckDuckGoResults = (html: string, count: number): WebSearchResult[] => {
  const anchors = [
    ...html.matchAll(/<a\s[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  ];
  return anchors.slice(0, count).map((anchor, index) => {
    const next = anchors[index + 1];
    const block = html.slice(anchor.index ?? 0, next?.index ?? html.length);
    const snippet =
      /<a\s[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ??
      "";
    const url = resultUrl(anchor[1]!);
    if (!/^https?:/i.test(url)) return undefined;
    return {
      title: textOf(anchor[2]!),
      url,
      snippet: textOf(snippet),
    };
  }).filter((item): item is WebSearchResult => item !== undefined);
};

/** Bing RSS 是无密钥兜底；DuckDuckGo 在部分网络会被 anomaly challenge 拦截。 */
export const parseBingRssResults = (xml: string, count: number): WebSearchResult[] =>
  [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, count)
    .map((item) => {
      const value = (tag: string) =>
        textOf(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(item[1]!)?.[1] ?? "");
      return { title: value("title"), url: value("link"), snippet: value("description") };
    })
    .filter((item) => item.url.startsWith("http://") || item.url.startsWith("https://"));

/** 生产 transport：所有目标必须是公网 HTTP(S)，并把 DNS 固定到已校验地址。 */
export const createHttpWebTransport = (config: WebHttpConfig): WebTransport => ({
  search: async (query, count, signal) => {
    signal?.throwIfAborted();
    // 保持 nanobot 的默认 DuckDuckGo 语义；空结果或 challenge 时使用 Bing RSS 兜底。
    try {
      const url = new URL(duckDuckGoEndpoint);
      url.searchParams.set("q", query);
      const page = await safePublicGet(url.toString(), config, signal);
      if (page.contentType.toLowerCase().includes("html")) {
        const results = parseDuckDuckGoResults(page.body, count);
        if (results.length) return results;
      }
    } catch {
      // 取消必须直接收尾，不能把它当供应商失败继续请求另一个搜索站点。
      signal?.throwIfAborted();
      // 具体供应商失败不透出；继续尝试兜底搜索。
    }
    signal?.throwIfAborted();
    const url = new URL(bingRssEndpoint);
    url.searchParams.set("q", query);
    const page = await safePublicGet(url.toString(), config, signal);
    return parseBingRssResults(page.body, count);
  },
  fetch: async (url, signal): Promise<FetchedWebPage> => safePublicGet(url, config, signal),
});
