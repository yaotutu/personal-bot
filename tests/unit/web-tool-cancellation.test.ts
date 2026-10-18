import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebTools } from "../../src/adapters/pi/tools/web.js";
import type { WebService } from "../../src/features/web/types.js";

/**
 * 工具层 AbortSignal 透传：每个工具的 execute 都必须把上层传入的 signal 原样
 * 转发给 WebService，并把 query/count/url/extractMode/maxChars 一并透传；
 * 服务在 abort 路径下的受控失败仍是 WebFailure，取消路径才 reject signal.reason。
 */
type RecordedSearch = { query: string; count: number | undefined; signal: AbortSignal | undefined };
type RecordedFetch = { url: string; extractMode: string | undefined; maxChars: number | undefined; signal: AbortSignal | undefined };

const recordingService = (): {
  service: WebService;
  records: { search: RecordedSearch[]; fetch: RecordedFetch[] };
} => {
  const records = { search: [] as RecordedSearch[], fetch: [] as RecordedFetch[] };
  const service: WebService = {
    search: async (query, count, signal) => {
      records.search.push({ query, count, signal });
      return { results: [{ title: "ok", url: "https://example.test", snippet: "ok" }], warnings: [], truncated: false };
    },
    fetch: async (url, extractMode, maxChars, signal) => {
      records.fetch.push({ url, extractMode, maxChars, signal });
      return {
        url,
        finalUrl: url,
        status: 200,
        extractor: extractMode ?? "markdown",
        truncated: false,
        length: maxChars ?? 0,
        untrusted: true,
        text: "ok",
      };
    },
  };
  return { service, records };
};

/** tool.execute 的实际签名是 5 元组（id, params, signal, onUpdate, ctx）；其余两层测试用 undefined 即可。 */
const invoke = (
  tools: ReturnType<typeof createWebTools>,
  name: string,
  callId: string,
  params: unknown,
  signal: AbortSignal | undefined,
) => {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return (tool.execute as (id: string, params: unknown, signal: AbortSignal | undefined) => Promise<unknown>)(
    callId,
    params,
    signal,
  );
};

test("search_web tool forwards params and signal to WebService.search verbatim", async () => {
  const { service, records } = recordingService();
  const tools = createWebTools(service);
  const controller = new AbortController();
  const result = await invoke(tools, "search_web", "call-1", { query: "  pi-muse  ", count: 4 }, controller.signal);
  assert.equal(records.search.length, 1);
  assert.equal(records.search[0]!.query, "  pi-muse  ");
  assert.equal(records.search[0]!.count, 4);
  assert.equal(records.search[0]!.signal, controller.signal);
  const projected = result as { isError: boolean; content: { text: string }[] };
  assert.equal(projected.isError, false);
  const parsed = JSON.parse(projected.content[0]!.text);
  assert.deepEqual(parsed, {
    results: [{ title: "ok", url: "https://example.test", snippet: "ok" }],
    warnings: [],
    truncated: false,
  });
});

test("search_web tool omits count when not provided and still forwards signal", async () => {
  const { service, records } = recordingService();
  const tools = createWebTools(service);
  const controller = new AbortController();
  await invoke(tools, "search_web", "call-2", { query: "no count" }, controller.signal);
  assert.equal(records.search.length, 1);
  assert.equal(records.search[0]!.count, undefined);
  assert.equal(records.search[0]!.signal, controller.signal);
});

test("search_web tool tolerates an undefined signal argument", async () => {
  const { service, records } = recordingService();
  const tools = createWebTools(service);
  // 上游可能在没有 signal 的上下文中调用工具；服务侧仍应按无 signal 路径运行。
  await invoke(tools, "search_web", "call-3", { query: "no signal" }, undefined);
  assert.equal(records.search.length, 1);
  assert.equal(records.search[0]!.signal, undefined);
});

test("web_fetch tool forwards url/extractMode/maxChars/signal to WebService.fetch verbatim", async () => {
  const { service, records } = recordingService();
  const tools = createWebTools(service);
  const controller = new AbortController();
  const result = await invoke(
    tools,
    "web_fetch",
    "call-4",
    { url: "https://example.test", extractMode: "text", maxChars: 500 },
    controller.signal,
  );
  assert.equal(records.fetch.length, 1);
  assert.equal(records.fetch[0]!.url, "https://example.test");
  assert.equal(records.fetch[0]!.extractMode, "text");
  assert.equal(records.fetch[0]!.maxChars, 500);
  assert.equal(records.fetch[0]!.signal, controller.signal);
  const projected = result as { isError: boolean; content: { text: string }[] };
  assert.equal(projected.isError, false);
  const parsed = JSON.parse(projected.content[0]!.text);
  assert.equal(parsed.extractor, "text");
});

test("web_fetch tool tolerates undefined optional params and undefined signal", async () => {
  const { service, records } = recordingService();
  const tools = createWebTools(service);
  await invoke(tools, "web_fetch", "call-5", { url: "https://example.test" }, undefined);
  assert.equal(records.fetch.length, 1);
  assert.equal(records.fetch[0]!.extractMode, undefined);
  assert.equal(records.fetch[0]!.maxChars, undefined);
  assert.equal(records.fetch[0]!.signal, undefined);
});

test("tool layer surfaces generic WebFailure unchanged and propagates abort rejection", async () => {
  // 工具层只在两种路径上发生分歧：
  //   - 服务返回 WebFailure 对象 → 工具层保持 { isError: true, error: ... }，不抛；
  //   - 服务因取消 reject signal.reason → 工具层把异常原样上抛，调用方据此判断取消。
  // 模拟真实 service：非取消错误一律返回受控 failure 对象，不外抛。
  const tools = createWebTools({
    search: async () => ({ error: "Web search failed" }),
    fetch: async () => ({ error: "Web fetch failed", url: "https://example.test/" }),
  });
  const failedSearch = await invoke(tools, "search_web", "call-6", { query: "x" }, undefined);
  const failedFetch = await invoke(tools, "web_fetch", "call-7", { url: "https://example.test" }, undefined);
  assert.equal((failedSearch as { isError: boolean }).isError, true);
  assert.match(((failedSearch as { content: { text: string }[] }).content[0]!.text), /Web search failed/);
  assert.equal((failedFetch as { isError: boolean }).isError, true);
  assert.match(((failedFetch as { content: { text: string }[] }).content[0]!.text), /Web fetch failed/);

  // 取消场景：服务拒绝 signal.reason 时，工具层不能吞掉异常或包装为 WebFailure。
  const reason = new Error("abort-reason-tools");
  const cancelTools = createWebTools({
    search: async (_q, _c, signal) => {
      signal?.throwIfAborted();
      throw signal!.reason;
    },
    fetch: async (_u, _s, _m, signal) => {
      signal?.throwIfAborted();
      throw signal!.reason;
    },
  });
  const cancelController = new AbortController();
  cancelController.abort(reason);
  await assert.rejects(
    () => invoke(cancelTools, "search_web", "call-8", { query: "x" }, cancelController.signal),
    (error: unknown) => error === reason,
  );
  await assert.rejects(
    () => invoke(cancelTools, "web_fetch", "call-9", { url: "https://example.test" }, cancelController.signal),
    (error: unknown) => error === reason,
  );
});