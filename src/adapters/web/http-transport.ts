import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
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

type ResolvedAddress = { address: string; family: number };

const duckDuckGoEndpoint = "https://html.duckduckgo.com/html/";
const bingRssEndpoint = "https://www.bing.com/search?format=rss";
const defaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36";

const blocked = new BlockList();
for (const [subnet, bits, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) blocked.addSubnet(subnet, bits, family);

const normalizeIp = (value: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)?.[1];
  return mapped ?? value;
};

const isPublicIp = (value: string) => {
  const ip = normalizeIp(value);
  const family = isIP(ip);
  return family !== 0 && !blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
};

/**
 * 解析并校验主机地址。allowPrivateTargets 显式放宽回环/私网限制——
 * 仅供本机联调与测试（config 默认关闭）；放宽时仍要求合法 IP/主机名，
 * 且不改变 pinned 连接（校验结果固定，防 rebinding）语义。
 */
export const resolvePublicHost = async (
  hostname: string,
  allowPrivateTargets = false,
): Promise<ResolvedAddress> => {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  if (!allowPrivateTargets) {
    if (normalized === "localhost" || normalized.endsWith(".localhost"))
      throw new Error("Blocked local hostname");
  }
  if (isIP(normalized)) {
    if (!allowPrivateTargets && !isPublicIp(normalized))
      throw new Error("Blocked private address");
    return { address: normalized, family: isIP(normalized) };
  }
  const addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("DNS unavailable");
  // 每个解析结果都必须是公网地址；本次连接固定使用第一个已验证结果，
  // 避免校验后 DNS 再次解析被 rebinding 到内网地址。
  if (!allowPrivateTargets)
    for (const address of addresses)
      if (!isPublicIp(address.address)) throw new Error("Blocked private address");
  return addresses[0]!;
};

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

const requestOnce = async (
  url: URL,
  config: WebHttpConfig,
  pinned: ResolvedAddress,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
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
          signal: controller.signal,
          lookup: (_host, options, callback) => {
            // DNS 已在上层校验并固定；这里不再让 Node 二次解析域名。
            // Node 的 Happy Eyeballs 路径会传 all=true 并要求数组；兼容两种 lookup 回调。
            if (options?.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          readBody(response, config.maxResponseBytes, controller.abort.bind(controller))
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
      request.setTimeout(config.timeoutMs, () => controller.abort());
      request.on("error", reject);
      request.end();
    },
  ).finally(() => clearTimeout(timer));
};

export const safePublicGet = async (
  rawUrl: string,
  config: WebHttpConfig,
) => {
  let url = new URL(rawUrl);
  let pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets);
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await requestOnce(url, config, pinned);
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
    pinned = await resolvePublicHost(url.hostname, config.allowPrivateTargets);
  }
  throw new Error("Too many redirects");
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
  search: async (query, count) => {
    // 保持 nanobot 的默认 DuckDuckGo 语义；空结果或 challenge 时使用 Bing RSS 兜底。
    try {
      const url = new URL(duckDuckGoEndpoint);
      url.searchParams.set("q", query);
      const page = await safePublicGet(url.toString(), config);
      if (page.contentType.toLowerCase().includes("html")) {
        const results = parseDuckDuckGoResults(page.body, count);
        if (results.length) return results;
      }
    } catch {
      // 具体供应商失败不透出；继续尝试兜底搜索。
    }
    const url = new URL(bingRssEndpoint);
    url.searchParams.set("q", query);
    const page = await safePublicGet(url.toString(), config);
    return parseBingRssResults(page.body, count);
  },
  fetch: async (url): Promise<FetchedWebPage> => safePublicGet(url, config),
});
