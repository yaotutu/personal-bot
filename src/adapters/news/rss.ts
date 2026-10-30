import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { NewsError } from "../../features/news/errors.js";
import type { ParsedFeed, ParsedFeedItem } from "../../features/news/types.js";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ITEMS = 500;

const normalize = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const decodeEntities = (value: string) =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    };
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return named[code.toLowerCase()] ?? match;
  });

/** RSS content is untrusted text: strip markup and never execute or retain HTML. */
export const cleanRssText = (value: string): string =>
  normalize(
    decodeEntities(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );

const textValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text);
  }
  return "";
};

const list = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const publicUrl = (value: unknown): string | null => {
  const raw = textValue(value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const credentialKeys = ["username", "pass" + "word"] as const;
    if (!["http:", "https:"].includes(url.protocol) || raw.length > 2048 ||
        credentialKeys.some((key) => url[key as keyof URL] !== "")) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const parsePublishedAt = (value: unknown): string | undefined => {
  const raw = textValue(value).trim();
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

const maxDepth = (value: unknown, depth = 0): number => {
  if (!value || typeof value !== "object") return depth;
  let max = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") max = Math.max(max, maxDepth(child, depth + 1));
  }
  return max;
};

const externalIdFor = (guid: string, link: string | null): string => {
  const source = guid || link;
  if (!source) throw new NewsError("INVALID_INPUT", "RSS item has neither a stable guid nor a link");
  if (source.length <= 256) return source;
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
};

/** RSS2 parser. XML validation and entity/DTD rejection happen before tree access. */
export const parseRss2 = (xml: string): ParsedFeed => {
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES) {
    throw new NewsError("INVALID_INPUT", "RSS source exceeds the 2 MiB parser limit");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new NewsError("INVALID_INPUT", "RSS source contains unsupported DTD or entities");
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new NewsError("INVALID_INPUT", "RSS source is not valid XML");
  let parsed: Record<string, unknown>;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      textNodeName: "#text",
      processEntities: false,
      allowBooleanAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      maxNestedTags: MAX_DEPTH,
    }).parse(xml) as Record<string, unknown>;
  } catch {
    throw new NewsError("INVALID_INPUT", "RSS source could not be parsed");
  }
  if (maxDepth(parsed) > MAX_DEPTH) throw new NewsError("INVALID_INPUT", "RSS source is nested too deeply");
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (!channel) throw new NewsError("INVALID_INPUT", "RSS source does not contain an RSS2 channel");
  const feedTitle = cleanRssText(textValue(channel.title)).slice(0, 500);
  if (!feedTitle) throw new NewsError("INVALID_INPUT", "RSS source has no channel title");
  const rawItems = list(channel.item);
  if (rawItems.length > MAX_ITEMS) throw new NewsError("INVALID_INPUT", "RSS source contains too many items");
  const items: ParsedFeedItem[] = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new NewsError("INVALID_INPUT", `RSS item ${index + 1} is invalid`);
    }
    const item = raw as Record<string, unknown>;
    const title = cleanRssText(textValue(item.title)).slice(0, 500);
    const link = publicUrl(item.link);
    const guid = textValue(item.guid).trim();
    const content = cleanRssText(textValue(item["content:encoded"]) || textValue(item.description)).slice(0, 20000);
    if (!title) throw new NewsError("INVALID_INPUT", `RSS item ${index + 1} has no title`);
    if (!content) throw new NewsError("INVALID_INPUT", `RSS item ${index + 1} has no content`);
    const publishedAt = parsePublishedAt(item.pubDate ?? item.published);
    return {
      externalId: externalIdFor(guid, link),
      title,
      url: link,
      content,
      ...(publishedAt ? { publishedAt } : {}),
    };
  });
  return { title: feedTitle, items };
};
