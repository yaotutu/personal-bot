import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { sseEventSchema, type SseEvent } from "../../src/http/contracts/sse-events.js";
import type { HistoryMessage } from "../../src/features/conversation/types.js";
import { scheduleTool } from "../../src/adapters/pi/tools/schedule.js";
import { projectExecutionEvent } from "../../src/adapters/pi/execution.js";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import type { Job } from "../../src/features/jobs/types.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

/**
 * 断言 nextRunAt 与参考时刻在服务端本地时区下的小时/分钟一致，
 * 且严格晚于参考时刻；只断言 "Z" 结尾无法证明重算结果正确。
 */
const assertLocalNextRun = (nextRunAt: string, after: Date, hour: number, minute: number) => {
  const next = new Date(nextRunAt);
  assert.ok(Number.isFinite(next.getTime()), `nextRunAt ${nextRunAt} must be a valid ISO instant`);
  assert.equal(next.getHours(), hour);
  assert.equal(next.getMinutes(), minute);
  assert.ok(next.getTime() > after.getTime(), `nextRunAt ${nextRunAt} must be strictly after ${after.toISOString()}`);
};

// ---------------------------------------------------------------------------
// 通用 fixture：真实 HTTP + 真实 pi（共享 fake provider），失败路径全部清理
// ---------------------------------------------------------------------------
const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-job-sched-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  // 测试内注册的放行函数（如并发 gate），失败路径也必须先释放再关闭服务。
  const releaseGates: (() => void)[] = [];

  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };

  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  });

  service = await createService(config);
  server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const listed = async (id: string) => {
    const response = await request("/api/spaces");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { spaces?: { id: string }[]; threads?: { id: string }[] };
    return (body.spaces || body.threads || []).some((thread) => thread.id === id);
  };

  return { dir, model, service: () => service!, request, listed, releaseGates };
};

// ---------------------------------------------------------------------------
// 1. 投影层：受控拒绝文案穿过 tool_execution_end 与 message_end 两个阶段
// ---------------------------------------------------------------------------
test("projectExecutionEvent preserves controlled rejection message across tool_execution_end and message_end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-sched-proj-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = createJobRepository(join(dir, "jobs.json"));
  const jobs = createJobService(repo);
  const tool = scheduleTool(jobs, "local-main");

  const rawResult = await tool.execute(
    "call-1",
    { action: "create", prompt: "invalid time", daily: true, at: "24:00" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(rawResult.isError, true);
  assert.equal((rawResult.details as { denied?: boolean } | undefined)?.denied, true);

  // 阶段 1：tool_execution_end 投影必须保留受控范围提示，而不是通用 "Tool execution failed"。
  const toolEndEvent: AgentSessionEvent = {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "schedule",
    result: rawResult,
    isError: true,
  };
  const projectedToolEnd = projectExecutionEvent(toolEndEvent);
  assert.equal(projectedToolEnd?.type, "tool_result");
  assert.match((projectedToolEnd as { content: string }).content, /strict HH:mm between 00:00 and 23:59/);

  // 阶段 2：message_end 原地脱敏，受控拒绝内容继续保留并随后持久化、送回模型。
  const toolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    isError: true,
    content: rawResult.content,
    details: rawResult.details,
  };
  const messageEndEvent: AgentSessionEvent = { type: "message_end", message: toolResultMessage as never };
  projectExecutionEvent(messageEndEvent);
  const contentText = (toolResultMessage.content[0] as { text: string }).text;
  assert.match(contentText, /strict HH:mm between 00:00 and 23:59/);
  assert.notEqual(contentText, "Tool execution failed");
});

// ---------------------------------------------------------------------------
// 2. 真实 HTTP PATCH：严格排期校验、字节不变、暂停语义、边界重算、不建空间
// ---------------------------------------------------------------------------
test("HTTP PATCH enforces strict schedule validation, boundary recalculation, and does not create space on failure", async (t) => {
  const h = await fixture(t);
  const jobsFile = join(h.dir, "jobs.json");

  // 记录本轮操作前的参考时刻，不用未注入服务时钟的固定未来日期。
  const reference = new Date();
  const initialJob = await h.service().jobs.add("initial prompt", true, "10:00", "local-main");

  // 1. 非法 HH:mm（含空串）逐次 400 INVALID_SCHEDULE_FORMAT，且每次原始文件字节不变
  for (const badAt of ["09:99", "24:00", "9:00", "invalid", ""]) {
    const bytesBefore = await readFile(jobsFile, "utf8");
    const res = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { at: badAt });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.code, "INVALID_SCHEDULE_FORMAT");
    assert.match(body.error ?? "", /strict HH:mm/);
    assert.equal(await readFile(jobsFile, "utf8"), bytesBefore);
  }
  assert.equal((await h.service().jobs.get(initialJob.id))?.at, "10:00");

  // 2. 暂停任务对非法时刻同样严格拒绝
  await h.service().jobs.control(initialJob.id, "pause");
  const pauseBadRes = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { at: "24:00" });
  assert.equal(pauseBadRes.status, 400);
  assert.equal(((await pauseBadRes.json()) as { code?: string }).code, "INVALID_SCHEDULE_FORMAT");

  // 3. 暂停任务合法 PATCH 不重算 nextRunAt（既有语义），恢复后才重算
  const pausedBefore = (await h.service().jobs.get(initialJob.id))!;
  const pausePatch = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { at: "23:59" });
  assert.equal(pausePatch.status, 200);
  const pausedJob = (await pausePatch.json()) as { at: string; nextRunAt?: string };
  assert.equal(pausedJob.at, "23:59");
  // 暂停 DTO 按契约不展示下次执行时间；底层保留值应从真实存储核对。
  assert.equal(pausedJob.nextRunAt, undefined);
  assert.equal((await h.service().jobs.get(initialJob.id))?.nextRunAt, pausedBefore.nextRunAt);
  const resumeReference = new Date();
  const resume = await h.request(`/api/jobs/${initialJob.id}/control`, "POST", { action: "resume" });
  assert.equal(resume.status, 200);
  const resumedJob = (await resume.json()) as Job;
  assertLocalNextRun(resumedJob.nextRunAt, resumeReference, 23, 59);

  // 4. daily / once 部分 PATCH 按最终合并值校验
  // 4a. 当前 daily=true 且 at="23:59"，仅 PATCH daily:false -> 合并后 ISO 非法，必须 400
  const partialOnceRes = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { daily: false });
  assert.equal(partialOnceRes.status, 400);
  assert.equal(((await partialOnceRes.json()) as { code?: string }).code, "INVALID_SCHEDULE_FORMAT");

  // 4b. 成功转为合法一次性任务
  const toOnceRes = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { daily: false, at: "2030-01-01T12:00:00+08:00" });
  assert.equal(toOnceRes.status, 200);

  // 4c. 当前 daily=false，仅 PATCH daily:true -> 合并后 HH:mm 非法，必须 400
  const partialDailyRes = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { daily: true });
  assert.equal(partialDailyRes.status, 400);
  assert.equal(((await partialDailyRes.json()) as { code?: string }).code, "INVALID_SCHEDULE_FORMAT");

  // 5. 合法边界 00:00 与 23:59：保存成功且 nextRunAt 为对应本地时刻、严格晚于参考
  const res00 = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { daily: true, at: "00:00" });
  assert.equal(res00.status, 200);
  const job00 = (await res00.json()) as Job;
  assert.equal(job00.at, "00:00");
  assertLocalNextRun(job00.nextRunAt, reference, 0, 0);

  const res2359 = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { daily: true, at: "23:59" });
  assert.equal(res2359.status, 200);
  const job2359 = (await res2359.json()) as Job;
  assert.equal(job2359.at, "23:59");
  assertLocalNextRun(job2359.nextRunAt, reference, 23, 59);

  // 6. 非法时刻带新 originSpaceId：绝不建立目标空间、sessions/workspace 目录与空间列表均不出现
  const nonExistentSpace = "never-created-bad-sched-space";
  const bytesBefore = await readFile(jobsFile, "utf8");
  const badSpacePatch = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", {
    at: "24:00",
    originSpaceId: nonExistentSpace,
  });
  assert.equal(badSpacePatch.status, 400);
  assert.equal(await readFile(jobsFile, "utf8"), bytesBefore);
  assert.equal(await h.listed(nonExistentSpace), false);
  await assertMissing(join(h.dir, "sessions", nonExistentSpace));
  await assertMissing(join(h.dir, "workspace", "threads", nonExistentSpace));
});

// ---------------------------------------------------------------------------
// 3. 确定性并发反例：路由预检通过后底层 daily 被并发翻转，
//    repository 原子读改写内的领域校验必须拦截并映射为 400，而不是 500
// ---------------------------------------------------------------------------
test("deterministic concurrency gate: PATCH at '12:00' meets concurrent daily flip and returns 400 INVALID_SCHEDULE_FORMAT", async (t) => {
  const h = await fixture(t);
  // 初始 daily 任务：PATCH { at: "12:00" } 在路由预检时合法
  const job = await h.service().jobs.add("race daily to once", true, "10:00", "local-main");
  const jobsFile = join(h.dir, "jobs.json");

  const updateEntered = deferred();
  const updateProceed = deferred();
  h.releaseGates.push(updateProceed.resolve);

  const originalUpdate = h.service().jobs.update;
  let gateActive = true;
  h.service().jobs.update = async (id, updates) => {
    if (gateActive) {
      updateEntered.resolve();
      await updateProceed.promise;
    }
    return originalUpdate(id, updates);
  };

  let patchReq: Promise<Response> | undefined;
  try {
    // 慢请求挂起在 repository 读改写事务前；HTTP promise 始终接住并最终 await
    patchReq = h.request(`/api/jobs/${job.id}`, "PATCH", { at: "12:00" });
    patchReq.catch(() => undefined);
    await updateEntered.promise;

    // 并发合法更新：daily 翻转为 false（at 同步改为合法 ISO），绕过 gate 直接落盘
    gateActive = false;
    await originalUpdate(job.id, { daily: false, at: "2030-01-01T10:00:00+08:00" });
    // 并发更新后的文件字节：慢请求被领域拒绝后必须保持这份字节不变
    const bytesAfterConcurrent = await readFile(jobsFile, "utf8");

    // 放行慢请求：合并结果 daily=false + at="12:00" 非法，repository 内 assertValidSchedule 拒绝
    updateProceed.resolve();
    const response = await patchReq;
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string; error?: string };
    assert.equal(body.code, "INVALID_SCHEDULE_FORMAT");
    assert.match(body.error ?? "", /ISO 8601 timestamp with timezone is required/);
    assert.equal(await readFile(jobsFile, "utf8"), bytesAfterConcurrent);
  } finally {
    gateActive = false;
    updateProceed.resolve();
    h.service().jobs.update = originalUpdate;
    await patchReq?.catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// 4. 真实 pi schedule 工具链路：测试内受控 OpenAI SSE provider 驱动
//    /api/conversation/run，验证拒绝提示进入模型上下文与持久历史、文件不创建/不变
// ---------------------------------------------------------------------------

/** 受控 provider 记录的请求形状；工具调用 id 唯一，供第二轮识别工具结果。 */
type ScheduleProviderRequest = {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: unknown[];
};

/** 把任意 content 形状拍平成文本，用于断言工具结果进入了模型上下文。 */
const flattenContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
      return "";
    }).join("");
  return "";
};

/**
 * 测试局部 OpenAI SSE provider：首个含 A03SCHED-<marker> 的用户消息按计划返回
 * 一次 schedule 工具调用；后续请求（pi 执行工具后回灌上下文）只回固定文本。
 * 每个 marker 只安排一次工具调用，不重复触发。
 */
const createScheduleProvider = async (
  t: TestContext,
  plans: Record<string, { action: "create"; prompt: string; daily: boolean; at: string }>,
) => {
  const requests: ScheduleProviderRequest[] = [];
  let toolCallSeq = 0;
  const scheduledMarkers = new Set<string>();
  const server = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw) as ScheduleProviderRequest;
      requests.push(input);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (delta: object, reason: string | null = null) =>
        res.write(
          "data: " + JSON.stringify({
            id: "chatcmpl-a03",
            object: "chat.completion.chunk",
            created: 1,
            model: input.model,
            choices: [{ index: 0, delta, finish_reason: reason }],
          }) + "\n\n",
        );
      const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
      const lastText = flattenContent(lastUser?.content);
      const marker = /A03SCHED-(\w+)/.exec(lastText)?.[1];
      const plan = marker ? plans[marker] : undefined;
      event({ role: "assistant" });
      if (plan && marker && !scheduledMarkers.has(marker)) {
        scheduledMarkers.add(marker);
        const id = `call_a03_${++toolCallSeq}`;
        event({ tool_calls: [{ index: 0, id, type: "function", function: { name: "schedule", arguments: JSON.stringify(plan) } }] });
        event({}, "tool_calls");
      } else {
        event({ content: "a03 reply" });
        event({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
};

test("pi schedule tool over real HTTP rejects invalid daily time with preserved tip and creates valid boundary jobs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-a03-pi-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  t.after(async () => {
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  const provider = await createScheduleProvider(t, {
    bad1: { action: "create", prompt: "A03SCHED bad one", daily: true, at: "09:99" },
    bad2: { action: "create", prompt: "A03SCHED bad two", daily: true, at: "24:00" },
    bad3: { action: "create", prompt: "A03SCHED bad three", daily: true, at: "9:00" },
    good1: { action: "create", prompt: "A03SCHED good midnight", daily: true, at: "00:00" },
    good2: { action: "create", prompt: "A03SCHED good night", daily: true, at: "23:59" },
  });

  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: provider.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 10000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    // 展示策略仅有 hidden/summary；验证摘要出口，不能为测试放开原始工具内容。
    tools: { presentation: { default: "summary" } },
  });
  service = await createService(config);
  server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const snapshot = async () => {
    const response = await request("/api/conversation?spaceId=local-main");
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: HistoryMessage[]; revision: string }>;
  };
  const run = async (content: string) => {
    const before = await snapshot();
    const response = await request("/api/conversation/run", "POST", {
      spaceId: "local-main",
      runId: randomUUID(),
      expectedRevision: before.revision,
      message: { id: randomUUID(), content },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    try {
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("data:")) events.push(sseEventSchema.parse(JSON.parse(line.slice(5).trim())));
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return events;
  };

  const jobsFile = join(dir, "jobs.json");

  // 1. 非法输入不创建任务；模型与 pi 原始历史保留原因，公开出口仍遵守摘要策略。
  for (const marker of ["bad1", "bad2", "bad3"]) {
    await assertMissing(jobsFile);
    const events = await run(`A03SCHED-${marker}`);
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"), `${marker} run must finish`);

    const scheduleResults = events.filter(
      (event): event is Extract<SseEvent, { type: "TOOL_CALL_RESULT" }> =>
        event.type === "TOOL_CALL_RESULT" && event.toolCallId.startsWith("call_a03_"),
    );
    assert.equal(scheduleResults.length, 1, `${marker} should produce exactly one schedule tool result`);
    const toolCallId = scheduleResults[0].toolCallId;
    assert.notEqual(scheduleResults[0].content, "已创建提醒");
    assert.doesNotMatch(scheduleResults[0].content, /strict HH:mm/);

    // 第二轮模型请求中，pi 已把拒绝原因作为工具结果回灌进模型上下文
    const secondRequest = provider.requests.at(-1)!;
    const modelToolResult = secondRequest.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === toolCallId,
    );
    assert.match(flattenContent(modelToolResult?.content), /strict HH:mm between 00:00 and 23:59/);

    // REST 历史是客户端摘要，不冒充 pi 的权威 JSONL 原文。
    const history = (await snapshot()).messages;
    const toolHistory = history.filter(
      (message): message is Extract<HistoryMessage, { role: "tool" }> => message.role === "tool",
    );
    assert.equal(toolHistory.find((message) => message.toolCallId === toolCallId)?.content, "工具执行失败");
    const sessionDir = join(dir, "sessions", "local-main");
    const sources = await Promise.all((await readdir(sessionDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(join(sessionDir, name), "utf8")));
    const entries = sources.flatMap((source) => source.trim().split("\n").map((line) => JSON.parse(line) as {
      message?: { role?: string; toolCallId?: string; content?: unknown; isError?: boolean };
    }));
    const persisted = entries.find((entry) =>
      entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
    )?.message;
    assert.equal(persisted?.isError, true);
    assert.match(flattenContent(persisted?.content), /strict HH:mm between 00:00 and 23:59/);

    // 拒绝路径绝不创建 jobs 文件
    await assertMissing(jobsFile);
  }

  // 2. 合法边界 00:00 / 23:59：真实 pi 链路创建任务并按本地时区计算 nextRunAt
  const reference = new Date();
  for (const [marker, at, hour, minute] of [
    ["good1", "00:00", 0, 0],
    ["good2", "23:59", 23, 59],
  ] as const) {
    const events = await run(`A03SCHED-${marker}`);
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"), `${marker} run must finish`);
    const scheduleResults = events.filter(
      (event): event is Extract<SseEvent, { type: "TOOL_CALL_RESULT" }> =>
        event.type === "TOOL_CALL_RESULT" && event.toolCallId.startsWith("call_a03_"),
    );
    assert.equal(scheduleResults.length, 1);
    assert.equal(scheduleResults[0].content, "已创建提醒");
  }
  const jobs = (await (await request("/api/jobs")).json()) as { jobs: Job[] };
  assert.equal(jobs.jobs.length, 2);
  assertLocalNextRun(jobs.jobs.find((job) => job.at === "00:00")!.nextRunAt, reference, 0, 0);
  assertLocalNextRun(jobs.jobs.find((job) => job.at === "23:59")!.nextRunAt, reference, 23, 59);
});
