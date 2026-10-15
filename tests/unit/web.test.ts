import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebService, UNTRUSTED_CONTENT_BANNER } from "../../src/features/web/web-service.js";
import { parseBingRssResults, parseDuckDuckGoResults, resolvePublicHost } from "../../src/adapters/web/http-transport.js";
import type { FetchedWebPage, WebTransport } from "../../src/features/web/types.js";

const service = (transport: Partial<WebTransport>) =>
  createWebService(
    {
      search: async () => [],
      fetch: async () => ({}) as FetchedWebPage,
      ...transport,
    } as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );

test("web service projects structured search results", async () => {
  const web = service({
    search: async (query, count) => {
      assert.equal(query, "personal bot");
      assert.equal(count, 2);
      return [
        { title: "Example", url: "https://example.test/a", snippet: "<b>Snippet</b>" },
      ];
    },
  });
  const value = await web.search("  personal bot  ", 2);
  assert.deepEqual(value, {
    results: [
      { title: "Example", url: "https://example.test/a", snippet: "Snippet" },
    ],
    warnings: [],
    truncated: false,
  });
});

test("web service sanitizes transport failures and validates input", async () => {
  const failing = service({
    search: async () => { throw new Error("secret search endpoint"); },
    fetch: async () => { throw new Error("secret fetch endpoint"); },
  });
  assert.deepEqual(await failing.search("query"), {
    error: "Web search failed",
  });
  assert.deepEqual(await failing.fetch("https://example.test"), {
    error: "Web fetch failed",
    url: "https://example.test/",
  });
  assert.deepEqual(await failing.fetch("file:///etc/passwd"), {
    error: "URL validation failed: only public HTTP(S) URLs are allowed",
    url: "file:///etc/passwd",
  });
});

test("web fetch extracts, truncates and marks untrusted HTML", async () => {
  const web = service({
    fetch: async () => ({
      finalUrl: "https://example.test/final",
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<title>Title</title><script>ignore()</script><h1>Head</h1><p>Body &amp; more</p>",
    }),
  });
  const result = await web.fetch("https://example.test");
  assert.ok(!("error" in result));
  assert.equal(result.finalUrl, "https://example.test/final");
  assert.equal(result.extractor, "markdown");
  assert.equal(result.truncated, false);
  assert.match(result.text, new RegExp(UNTRUSTED_CONTENT_BANNER));
  assert.match(result.text, /# Title/);
  assert.match(result.text, /# Head/);
  assert.match(result.text, /Body & more/);
});

test("DuckDuckGo parser decodes redirect targets, titles and snippets", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa&amp;rut=abc">Example &amp; Company</a>
    <a class="result__snippet" href="#">Snippet &lt;b&gt;text&lt;/b&gt;</a>
    <a class="result__a" href="https://example.test/b">Second</a>
    <a class="result__snippet" href="#">Second snippet</a>`;
  assert.deepEqual(parseDuckDuckGoResults(html, 2), [
    {
      title: "Example & Company",
      url: "https://example.test/a",
      snippet: "Snippet <b>text</b>",
    },
    { title: "Second", url: "https://example.test/b", snippet: "Second snippet" },
  ]);
});

test("Bing RSS parser extracts fallback search results", () => {
  const xml = `<rss><channel><item><title>A &amp; B</title><link>https://example.test/a</link><description>Snippet</description></item><item><title>Drop</title><link>ftp://example.test</link></item></channel></rss>`;
  assert.deepEqual(parseBingRssResults(xml, 2), [
    { title: "A & B", url: "https://example.test/a", snippet: "Snippet" },
  ]);
});

test("public HTTP transport blocks local and private DNS targets before connecting", async () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.2"]) {
    await assert.rejects(() => resolvePublicHost(host), /Blocked|DNS unavailable/);
  }
});
