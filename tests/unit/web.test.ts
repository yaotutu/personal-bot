import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebService, UNTRUSTED_CONTENT_BANNER } from "../../src/features/web/web-service.js";
import { parseBingRssResults, parseDuckDuckGoResults, safePublicGet } from "../../src/adapters/web/http-transport.js";
import { resolvePublicHost } from "../../src/shared/public-host.js";
import type { FetchedWebPage, WebSearchResult, WebTransport } from "../../src/features/web/types.js";

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

test("public HTTP transport handles WHATWG IPv6 bracketed hostnames and allowPrivateTargets", async () => {
  // 1. 默认拒绝 IPv6 回环与私网字面量（带方括号与不带方括号）
  await assert.rejects(() => resolvePublicHost("[::1]", false), /Blocked|DNS unavailable/);
  await assert.rejects(() => resolvePublicHost("::1", false), /Blocked|DNS unavailable/);
  await assert.rejects(() => resolvePublicHost("[fe80::1]", false), /Blocked|DNS unavailable/);

  // 2. allowPrivateTargets=true 时允许 ::1 与私网 IPv6
  const loopbackBracketed = await resolvePublicHost("[::1]", true);
  assert.deepEqual(loopbackBracketed, { address: "::1", family: 6 });
  const loopbackPlain = await resolvePublicHost("::1", true);
  assert.deepEqual(loopbackPlain, { address: "::1", family: 6 });

  // 3. 公网 IPv6 字面量直接解析并按 IP 校验通过（带方括号与不带方括号）
  const publicV6Bracketed = await resolvePublicHost("[2606:4700:4700::1111]", false);
  assert.deepEqual(publicV6Bracketed, { address: "2606:4700:4700::1111", family: 6 });
  const publicV6Plain = await resolvePublicHost("2606:4700:4700::1111", false);
  assert.deepEqual(publicV6Plain, { address: "2606:4700:4700::1111", family: 6 });
});

test("safePublicGet timeoutMs is the total budget for the whole fetch across redirects", async () => {
  const hopsTimeouts: number[] = [];
  const mockDoRequest = async (url: URL, _config: unknown, _pinned: unknown, timeoutMs: number, signal?: AbortSignal) => {
    hopsTimeouts.push(timeoutMs);
    signal?.throwIfAborted();
    if (url.pathname === "/first") {
      // 模拟第一跳耗时 60ms 后返回 302 重定向到 /second
      await new Promise((resolve) => setTimeout(resolve, 60));
      signal?.throwIfAborted();
      return {
        status: 302,
        headers: { location: "http://[2606:4700:4700::1111]/second" },
        body: "",
        url,
      };
    }
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "final-content",
      url,
    };
  };

  const res = await safePublicGet(
    "http://[2606:4700:4700::1111]/first",
    { timeoutMs: 500, maxResponseBytes: 1024, allowPrivateTargets: false },
    undefined,
    mockDoRequest,
  );
  assert.equal(res.body, "final-content");
  assert.equal(hopsTimeouts.length, 2);
  // 第一跳获得的预算接近 500ms
  assert.ok(hopsTimeouts[0]! >= 400 && hopsTimeouts[0]! <= 500);
  // 第二跳获得的预算必须扣除第一跳耗时
  assert.ok(hopsTimeouts[1]! < hopsTimeouts[0]!);
  assert.ok(hopsTimeouts[1]! <= 450);

  // 累积耗时超出总预算时触发整体超时拒绝
  const hangingDoRequest = async (url: URL, _config: unknown, _pinned: unknown, _timeoutMs: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (url.pathname === "/start") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal?.throwIfAborted();
      return {
        status: 302,
        headers: { location: "http://[2606:4700:4700::1111]/hang" },
        body: "",
        url,
      };
    }
    // 第二跳阻塞等待超过剩余预算
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    return { status: 200, headers: {}, body: "", url };
  };

  await assert.rejects(
    safePublicGet(
      "http://[2606:4700:4700::1111]/start",
      { timeoutMs: 80, maxResponseBytes: 1024, allowPrivateTargets: false },
      undefined,
    hangingDoRequest,
    ),
    /abort/i,
  );
});

// ---- AbortSignal 透传与取消语义 ----
// 取消与普通失败路径不同：取消直接 reject signal.reason，transport 不被调用或在途被监听；
// 仅 transport 自身异常（非取消）仍按受控失败脱敏。

/** 可控 promise：resolve/reject 由测试驱动，不依赖 sleep。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** 用真实 AbortController 监听 signal，在 abort 时把 transport 的 promise reject 为 signal.reason。 */
const signalAwareTransport = (
  transport: Partial<WebTransport>,
): { transport: WebTransport; pending: { search: { signal: AbortSignal; reason?: unknown } | null; fetch: { signal: AbortSignal; reason?: unknown } | null } } => {
  const pending = {
    search: null as { signal: AbortSignal; reason?: unknown } | null,
    fetch: null as { signal: AbortSignal; reason?: unknown } | null,
  };
  const searchImpl = async (query: string, count: number, signal?: AbortSignal) => {
    if (!signal) {
      // 没有 signal 时直接走兜底 transport，不模拟取消监听
      return transport.search ? transport.search(query, count) : [];
    }
    if (signal.aborted) throw signal.reason;
    const d = deferred<WebSearchResult[]>();
    pending.search = { signal };
    const onAbort = () => {
      const current = pending.search;
      if (current && current.signal === signal) {
        current.reason = signal.reason;
        d.reject(signal.reason);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (transport.search) {
      transport.search(query, count).then(d.resolve, d.reject);
    }
    return d.promise;
  };
  const fetchImpl = async (url: string, signal?: AbortSignal) => {
    if (!signal) {
      return transport.fetch
        ? transport.fetch(url)
        : ({ finalUrl: url, status: 200, contentType: "text/html", body: "" });
    }
    if (signal.aborted) throw signal.reason;
    const d = deferred<FetchedWebPage>();
    pending.fetch = { signal };
    const onAbort = () => {
      const current = pending.fetch;
      if (current && current.signal === signal) {
        current.reason = signal.reason;
        d.reject(signal.reason);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (transport.fetch) {
      transport.fetch(url).then(d.resolve, d.reject);
    }
    return d.promise;
  };
  return {
    pending,
    transport: {
      search: searchImpl,
      fetch: fetchImpl,
    },
  };
};

test("search rejects pre-aborted signal without invoking transport", async () => {
  const transport = {
    search: async () => assert.fail("transport.search must not run"),
    fetch: async () => ({}) as FetchedWebPage,
  };
  const web = createWebService(
    transport as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );
  const reason = new Error("pre-cancel-search");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    () => web.search("query", 2, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("fetch rejects pre-aborted signal without invoking transport", async () => {
  const transport = {
    search: async () => [],
    fetch: async () => assert.fail("transport.fetch must not run"),
  };
  const web = createWebService(
    transport as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );
  const reason = new Error("pre-cancel-fetch");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    () => web.fetch("https://example.test", "markdown", 200, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("in-flight abort on search rejects with signal.reason, not generic WebFailure", async () => {
  const { transport, pending } = signalAwareTransport({});
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const controller = new AbortController();
  const reason = new Error("aborted-mid-search");
  const promise = web.search("query", 3, controller.signal);
  // 确保 transport.search 已被调用且挂起
  await Promise.resolve();
  assert.ok(pending.search, "transport.search should have started");
  controller.abort(reason);
  await assert.rejects(promise, (error: unknown) => error === reason);
});

test("in-flight abort on fetch rejects with signal.reason, not generic WebFailure", async () => {
  const { transport, pending } = signalAwareTransport({});
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const controller = new AbortController();
  const reason = new Error("aborted-mid-fetch");
  const promise = web.fetch("https://example.test", "markdown", 1000, controller.signal);
  await Promise.resolve();
  assert.ok(pending.fetch, "transport.fetch should have started");
  controller.abort(reason);
  await assert.rejects(promise, (error: unknown) => error === reason);
});

test("abort immediately before returning a successful transport does not turn the result into success", async () => {
  // transport 模拟"在 await 期间 abort 已经发生并完成"的窗口：transport 收到 abort 后
  // 仍然按成功路径返回（resolve with [] / 页面对象），service 必须在 await 之后再次
  // throwIfAborted，确保取消仍 wins 而不会返回伪成功对象。
  const searchController = new AbortController();
  const searchReason = new Error("aborted-before-return-search");
  let searchAbortSeen = false;
  const searchTransport: WebTransport = {
    search: async (_q, _c, signal) =>
      new Promise<WebSearchResult[]>((resolve) => {
        signal?.addEventListener("abort", () => {
          searchAbortSeen = true;
          // 模拟 transport 自身完成了 fetch 但 signal 已被 abort；
          // resolve 一个会令 service 误判成功的数据。
          resolve([]);
        }, { once: true });
      }),
    fetch: async () => ({ finalUrl: "", status: 0, contentType: "", body: "" }),
  };
  const searchWeb = createWebService(searchTransport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const searchPromise = searchWeb.search("query", 2, searchController.signal);
  searchController.abort(searchReason);
  const searchOutcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown } =
    await searchPromise.then(
      (value) => ({ kind: "resolved", value }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
  assert.equal(searchAbortSeen, true, "abort listener should have fired");
  assert.equal(searchOutcome.kind, "rejected", "search must reject, not resolve");
  assert.equal((searchOutcome as { kind: "rejected"; error: unknown }).error, searchReason,
    "search must reject with abort reason");

  const fetchController = new AbortController();
  const fetchReason = new Error("aborted-before-return-fetch");
  let fetchAbortSeen = false;
  const fetchTransport: WebTransport = {
    search: async () => [],
    fetch: async (url, signal) =>
      new Promise<FetchedWebPage>((resolve) => {
        signal?.addEventListener("abort", () => {
          fetchAbortSeen = true;
          resolve({
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: "<title>x</title><p>body</p>",
          });
        }, { once: true });
      }),
  };
  const fetchWeb = createWebService(fetchTransport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const fetchPromise = fetchWeb.fetch("https://example.test", "markdown", 1000, fetchController.signal);
  fetchController.abort(fetchReason);
  const fetchOutcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown } =
    await fetchPromise.then(
      (value) => ({ kind: "resolved", value }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
  assert.equal(fetchAbortSeen, true, "fetch abort listener should have fired");
  assert.equal(fetchOutcome.kind, "rejected", "fetch must reject, not resolve");
  assert.equal((fetchOutcome as { kind: "rejected"; error: unknown }).error, fetchReason,
    "fetch must reject with abort reason");
});

test("non-cancellation transport failures still surface as generic WebFailure", async () => {
  // 现有脱敏语义：transport 抛非 abort 错误时，service 返回受控 failure 对象，
  // 不向上抛出原始错误，也不暴露 transport 内部细节。
  const transport = {
    search: async () => { throw new Error("secret search reason"); },
    fetch: async () => { throw new Error("secret fetch reason"); },
  } as WebTransport;
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  // 没有 signal / 未 abort 时仍走原通用失败路径
  assert.deepEqual(await web.search("query"), { error: "Web search failed" });
  assert.deepEqual(await web.fetch("https://example.test"), {
    error: "Web fetch failed",
    url: "https://example.test/",
  });
});
