import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import type { WebService } from "../../src/features/web/types.js";
import type { WeatherService } from "../../src/features/weather/types.js";
import { buildSystemPrompt } from "../../src/adapters/pi/system-prompt.js";
import { createResourceLoader } from "../../src/adapters/pi/resource-loader.js";
import { createTools } from "../../src/adapters/pi/tools/index.js";
import { guardPath, guardTool } from "../../src/adapters/pi/tools/path-guard.js";

const setup = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-pi-adapters-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = createDataLayout(dir);
  const repository = createMemoryRepository(layout.memoryFile);
  const memory = createMemoryService(repository);
  const identity = createIdentityService(repository);
  const jobs = createJobService(createJobRepository(layout.jobsFile));
  const web: WebService = {
    search: async (query, count) =>
      query ? `search:${query}:${count ?? 5}` : JSON.stringify({ error: "empty query" }),
    fetch: async (url, mode, maxChars) =>
      JSON.stringify({ url, mode, maxChars, text: "web body" }),
  };
  const weather: WeatherService = {
    getWeather: async (city) => ({
      text: city ? `weather:${city}` : "weather:default",
      isError: false,
    }),
  };
  const tools = createTools(layout.workspaceDir, memory, jobs, web, weather);
  // SDK ToolDefinition 的 context 与本测试无关；工具不访问 session 环境。
  const execute = (name: string, params: unknown) => tools.find((tool) => tool.name === name)!
    .execute("test-call", params as never, undefined, undefined, {} as never);
  return { layout, memory, identity, jobs, tools, execute };
};

test("tool registration defines one explicit ordered allowlist and unchanged schemas", async (t) => {
  const { tools } = await setup(t);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "currentTime", "memory", "schedule", "read", "grep", "find", "ls",
    "search_web", "web_fetch", "get_weather",
  ]);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 10);
  assert.ok(tools.every((tool) => !["bash", "edit", "write"].includes(tool.name)));
  assert.equal(tools[0].parameters.additionalProperties, false);
  assert.deepEqual(tools[0].parameters.properties, {});
  assert.deepEqual(tools[1].parameters.required, ["action"]);
  assert.deepEqual(tools[2].parameters.required, ["action", "prompt", "at"]);
});

test("path guard accepts workspace paths but rejects traversal and prefix siblings", () => {
  const root = resolve("/tmp/personal-bot-workspace");
  for (const raw of [undefined, null, "", "  ", ".", 123]) {
    assert.equal(guardPath(root, raw), root);
  }
  assert.equal(guardPath(root, "docs/file.txt"), join(root, "docs/file.txt"));
  assert.equal(guardPath(root, "docs/../file.txt"), join(root, "file.txt"));
  assert.equal(guardPath(root, join(root, "file.txt")), join(root, "file.txt"));
  for (const raw of ["../secret", "/etc/passwd", root + "-other/file.txt", "docs/../../secret"]) {
    assert.equal(guardPath(root, raw), null);
  }
});

test("guarded tools deny before execution and forward every execution argument on success", async () => {
  const root = resolve("/tmp/personal-bot-workspace");
  const calls: unknown[][] = [];
  const definition: ToolDefinition<any, any> = {
    name: "read", label: "Read", description: "test", parameters: Type.Object({}),
    execute: async (...args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
  const guarded = guardTool(definition, root);
  const signal = new AbortController().signal;
  const update = () => {};
  const context = {} as never;
  const denied = await guarded.execute("denied", { path: "../secret" }, signal, update, context);
  assert.deepEqual(denied, {
    content: [{ type: "text", text: "Access denied: path is outside the documents directory." }],
    details: { denied: true }, isError: true,
  });
  assert.equal(calls.length, 0);
  const params = { path: "docs/file.txt" };
  assert.deepEqual(await guarded.execute("allowed", params, signal, update, context), {
    content: [{ type: "text", text: "ok" }], details: undefined,
  });
  assert.deepEqual(calls, [["allowed", params, signal, update, context]]);
});

test("currentTime tool keeps readable output and structured time metadata", async (t) => {
  const { execute } = await setup(t);
  const result = await execute("currentTime", {});
  const details = result.details as { iso: string; timeZone: string; locale: string };
  assert.ok(Number.isFinite(Date.parse(details.iso)));
  assert.ok(details.timeZone);
  assert.ok(details.locale);
  assert.match((result.content[0] as { text: string }).text, /ISO 8601:/);
});

test("memory tool keeps explicit remember/keyword forget behavior and shares service data", async (t) => {
  const { execute, memory } = await setup(t);
  assert.equal((await execute("memory", { action: "remember", text: " " })).isError, true);
  assert.equal((await execute("memory", { action: "forget" })).isError, true);
  await execute("memory", { action: "remember", text: "likes tea" });
  await memory.add("tea with milk", "Apps UI");
  await memory.add("likes coffee", "Apps UI");
  const forgotten = await execute("memory", { action: "forget", keyword: "tea" });
  assert.equal((forgotten.content[0] as { text: string }).text, 'Forgot 2 memory item(s) matching "tea".');
  assert.deepEqual((await memory.list()).map((item) => item.text), ["likes coffee"]);
  const noMatch = await execute("memory", { action: "forget", keyword: "tea" });
  assert.equal((noMatch.content[0] as { text: string }).text, 'No memory matches "tea".');
});

test("schedule tool preserves input denials and creates/cancels through the job service", async (t) => {
  const { execute, jobs } = await setup(t);
  for (const params of [
    { action: "create", prompt: "", at: "2030-01-01" },
    { action: "create", prompt: "test", at: "bad date" },
    { action: "create", prompt: "test", at: "nope", daily: true },
    { action: "cancel", prompt: "-", at: "-" },
  ]) assert.equal((await execute("schedule", params)).isError, true);
  assert.deepEqual(await jobs.list(), []);
  await execute("schedule", { action: "create", prompt: "drink tea", at: "2030-01-01T09:00:00+08:00" });
  const [job] = await jobs.list();
  assert.equal(job.prompt, "drink tea");
  const listed = await execute("schedule", { action: "list", prompt: "-", at: "-" });
  assert.match((listed.content[0] as { text: string }).text, /drink tea/);
  await execute("schedule", { action: "cancel", prompt: "-", at: "-", jobId: job.id });
  assert.equal((await jobs.list())[0].enabled, false);
});


test("weather tool uses the weather service without exposing network details", async (t) => {
  const { execute } = await setup(t);
  const explicit = await execute("get_weather", { city: "上海" });
  assert.equal(explicit.isError, false);
  assert.equal((explicit.content[0] as { text: string }).text, "weather:上海");
  assert.deepEqual(explicit.details, { source: "open-meteo" });
});

test("system prompt conditionally describes untrusted web content", async (t) => {
  const { layout, memory } = await setup(t);
  assert.doesNotMatch(await buildSystemPrompt(layout, memory), /search_web/);
  assert.match(await buildSystemPrompt(layout, memory, true), /search_web/);
  assert.match(await buildSystemPrompt(layout, memory, true), /untrusted data/);
  assert.doesNotMatch(await buildSystemPrompt(layout, memory), /get_weather/);
  assert.match(await buildSystemPrompt(layout, memory, false, true), /get_weather/);
});

test("web tools expose controlled search and fetch projections", async (t) => {
  const { execute } = await setup(t);
  const search = await execute("search_web", { query: "personal bot", count: 2 });
  assert.equal((search.content[0] as { text: string }).text, "search:personal bot:2");
  const failed = await execute("search_web", { query: "" });
  assert.equal(failed.isError, true);
  const fetched = await execute("web_fetch", {
    url: "https://example.test",
    extractMode: "text",
    maxChars: 123,
  });
  assert.equal(fetched.isError, false);
  const value = JSON.parse((fetched.content[0] as { text: string }).text);
  assert.deepEqual(value, {
    url: "https://example.test",
    mode: "text",
    maxChars: 123,
    text: "web body",
  });
});

test("system prompt describes explicit memory and schedules without expanding permissions", async (t) => {
  const { layout, memory, execute } = await setup(t);
  // 使用隔离存储和真实 memory 工具添加条目，验证“列出”确实依靠注入内容，
  // 不虚构 memory 的 list 动作；能力和安全边界都做正向断言，而非只排除旧文案。
  await execute("memory", { action: "remember", text: "likes tea" });
  const prompt = await buildSystemPrompt(layout, memory);
  const text = prompt.replace(/\s+/g, " ");
  assert.match(text, /memory to add \(remember\) or delete \(forget, by keyword\) long-term facts only on explicit user requests/);
  assert.match(text, /List saved memories from the injected Long-term memory section/);
  assert.match(prompt, /## Long-term memory \(explicit, user-curated\)\n- likes tea/);
  assert.match(text, /Never automatically extract or store memories/);
  assert.match(text, /or store credentials, API keys, or secrets/);
  assert.match(text, /schedule to create, list, or cancel one-time or daily tasks on explicit user requests/);
  assert.match(text, /they run later in this conversation/);
  assert.match(text, /Reminders appear only here and may require a refresh or later sync/);
  assert.match(text, /do not promise email notifications or real-time push/);
  assert.match(text, /read\/grep\/find\/ls tools access only the workspace documents directory, read-only/);
  assert.match(text, /you have no file write access/);
  assert.match(text, /currentTime reads the local clock/);
  assert.match(text, /No shell, browser, email, or calendar tools are available/);
  assert.match(text, /Never claim to have performed an action you cannot do/);
});

test("system prompt reads profile files in order, omits blanks and refreshes memory/identity", async (t) => {
  const { layout, memory, identity } = await setup(t);
  const base = await buildSystemPrompt(layout, memory);
  assert.ok(base.startsWith("You are Personal Bot"));
  assert.ok(!base.includes("## Your identity"));
  await writeFile(layout.soulFile, "  gentle assistant  \n");
  await writeFile(layout.userFile, "  tea lover\n");
  await memory.add("likes tea", "chat");
  await identity.save({ name: "Tea Bot" });
  const prompt = await buildSystemPrompt(layout, memory);
  assert.equal(prompt, base +
    "\n\n## Your identity (SOUL)\ngentle assistant" +
    "\n\n## The user (USER)\ntea lover" +
    "\n\n## Long-term memory (explicit, user-curated)\n- likes tea\n" +
    "\n## Identity settings\n- Assistant name: Tea Bot\n- Tone: warm\n");
  await writeFile(layout.soulFile, "new soul");
  await writeFile(layout.userFile, "  \n");
  const refreshed = await buildSystemPrompt(layout, memory);
  assert.match(refreshed, /## Your identity \(SOUL\)\nnew soul/);
  assert.ok(!refreshed.includes("The user (USER)"));
  assert.ok(!refreshed.includes("gentle assistant"));
});

test("resource loader isolates CLI resources and supplies only the explicit system prompt", async () => {
  const resources = createResourceLoader("custom prompt");
  assert.deepEqual(resources.getExtensions().extensions, []);
  assert.deepEqual(resources.getExtensions().errors, []);
  assert.deepEqual(resources.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(resources.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(resources.getThemes(), { themes: [], diagnostics: [] });
  assert.deepEqual(resources.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(resources.getSystemPrompt(), "custom prompt");
  assert.equal(resources.getSystemPromptSource(), undefined);
  assert.deepEqual(resources.getAppendSystemPrompt(), []);
  assert.deepEqual(resources.getAppendSystemPromptSources(), []);
  await resources.reload();
  assert.equal(resources.getSystemPrompt(), "custom prompt");
});
