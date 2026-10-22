import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";

type ScenarioOutcome = {
  name: string;
  passed: boolean;
  modelCalls: number;
  toolCalls: { name: string; arguments: string }[];
  toolResults: string[];
  evidence?: Record<string, unknown>;
  error?: string;
};

/**
 * 断言 nextRunAt 与参考时刻在服务端本地时区下的小时/分钟一致，
 * 且严格晚于参考时刻。
 */
const assertLocalNextRun = (nextRunAt: string, after: Date, hour: number, minute: number) => {
  const next = new Date(nextRunAt);
  assert.ok(Number.isFinite(next.getTime()), `nextRunAt ${nextRunAt} must be a valid ISO instant`);
  assert.equal(next.getHours(), hour, `expected local hour ${hour}, got ${next.getHours()}`);
  assert.equal(next.getMinutes(), minute, `expected local minute ${minute}, got ${next.getMinutes()}`);
  assert.ok(next.getTime() > after.getTime(), `nextRunAt ${nextRunAt} must be strictly after ${after.toISOString()}`);
};

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  // 1. 仅读取显式传入配置中的 model 配置段；不引用真实 DATA_DIR 或其他业务设置
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Model configuration is required");

  process.stdout.write("真实模型 A03 排期验收已显式授权：测试会产生模型费用，所有文件与任务均在隔离临时实例中运行。\n");

  const results: ScenarioOutcome[] = [];
  let root: string | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let baseUrl = "";
  let serviceVersion: unknown;
  let sessionToken: string | undefined;
  const createdSpaceIds: string[] = [];
  const createdJobIds = new Set<string>();

  const stopService = async () => {
    const current = service;
    const server = http;
    service = undefined;
    http = undefined;
    try {
      await current?.close();
    } finally {
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }
  };

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-live-job-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });

    // 真实 key 驻留在透明代理内存中，不写入临时配置或持久化日志
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });

    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-job-sched-key" },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 120_000,
        schedulerIntervalMs: 60_000,
        monitorScanIntervalMs: 60_000,
      },
      tools: {
        presentation: { default: "summary" },
      },
    });

    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const loginRes = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "live-job-sched-key" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(loginRes.status, 200);
    const { token } = (await loginRes.json()) as { token?: string };
    assert.ok(token, "Session token is required");
    sessionToken = token;
    const client = createTestClient(() => baseUrl, token, 120_000);
    serviceVersion = (await client.json("/api/health")).serviceVersion;

    const jobsFile = join(dataDir, "jobs.json");

    // -------------------------------------------------------------------------
    // 阶段 A：真实对话 + 真实模型调用 schedule 工具创建任务（5 个独立测试空间）
    // -------------------------------------------------------------------------
    type PromptSpec = {
      scenario: string;
      spaceId: string;
      at: string;
      promptText: string;
      expectValid: boolean;
      expectedHour?: number;
      expectedMinute?: number;
    };

    const makePrompt = (at: string) =>
      `这是系统测试。请严格调用 schedule 工具一次创建定时提醒：action="create"，prompt="测试排期"，daily=true，at="${at}"。` +
      `这是参数异常/边界测试用例，请务必把 at 原样传给工具验证，绝对不要自行纠正或改写时刻，不要重试，不要使用其它工具。调用完毕后请简短回复结果。`;

    const specs: PromptSpec[] = [
      { scenario: "invalid-09-99", spaceId: "live-space-bad-0999", at: "09:99", promptText: makePrompt("09:99"), expectValid: false },
      { scenario: "invalid-24-00", spaceId: "live-space-bad-2400", at: "24:00", promptText: makePrompt("24:00"), expectValid: false },
      { scenario: "invalid-9-00", spaceId: "live-space-bad-900", at: "9:00", promptText: makePrompt("9:00"), expectValid: false },
      { scenario: "valid-boundary-00-00", spaceId: "live-space-good-0000", at: "00:00", promptText: makePrompt("00:00"), expectValid: true, expectedHour: 0, expectedMinute: 0 },
      { scenario: "valid-boundary-23-59", spaceId: "live-space-good-2359", at: "23:59", promptText: makePrompt("23:59"), expectValid: true, expectedHour: 23, expectedMinute: 59 },
    ];

    const capturedValidJobIds: Record<string, string> = {};

    for (const spec of specs) {
      if (!createdSpaceIds.includes(spec.spaceId)) createdSpaceIds.push(spec.spaceId);
      const baseline = proxy.traces.length;
      let outcome: ScenarioOutcome = {
        name: spec.scenario,
        passed: false,
        modelCalls: 0,
        toolCalls: [],
        toolResults: [],
      };

      try {
        const referenceTime = new Date();
        const runResult = await client.startRun(spec.promptText, spec.spaceId);
        const events = await runResult.done;
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");

        const traces = proxy.traces.slice(baseline);
        outcome.modelCalls = traces.length;
        const allScheduleCalls = traces
          .flatMap((t) => t.calls)
          .filter((c) => c.name === "schedule");
        outcome.toolCalls = allScheduleCalls;

        const allToolResults = traces.flatMap((t) => t.toolResults);
        outcome.toolResults = allToolResults;

        // 模型遵循度校验：必须不多不少调用一次 schedule
        if (allScheduleCalls.length === 0) {
          throw new Error("模型未调用 schedule 工具（拒绝执行或自行回答）");
        }
        if (allScheduleCalls.length > 1) {
          throw new Error(`模型调用了 ${allScheduleCalls.length} 次 schedule 工具，违反了一次性要求`);
        }

        const callArgs = JSON.parse(allScheduleCalls[0].arguments) as {
          action?: string;
          prompt?: string;
          daily?: boolean;
          at?: string;
        };

        if (callArgs.action !== "create" || callArgs.daily !== true || callArgs.at !== spec.at) {
          throw new Error(
            `模型未按测试要求传递参数：期望 action=create, daily=true, at=${spec.at}，实际=${JSON.stringify(callArgs)}`,
          );
        }

        if (!spec.expectValid) {
          // 非法时刻场景：
          // 1. 工具拒绝受控提示必须回到模型上下文中
          const returnedTip = allToolResults.some((tr) =>
            tr.includes("strict HH:mm between 00:00 and 23:59"),
          );
          assert.ok(returnedTip, "受控拒绝提示必须回到模型上下文（tool result 包含 strict HH:mm between 00:00 and 23:59）");

          // 2. 检查 jobs 列表：不能产生属于此 spaceId 的任务
          const currentJobs = (await client.json("/api/jobs")).jobs as { id: string; originSpaceId: string }[];
          assert.equal(
            currentJobs.some((j) => j.originSpaceId === spec.spaceId),
            false,
            `非法排期 ${spec.at} 不得在 jobs 中创建任务`,
          );

          outcome.passed = true;
          outcome.evidence = { rejectedWithTip: true, callArgs, jobsNotCreated: true };
          process.stdout.write(`[PASS] ${spec.scenario}\n`);
        } else {
          // 合法边界场景（00:00 与 23:59）：
          // 1. 工具成功，返回已创建
          const toolSuccess = allToolResults.some((tr) => tr.includes("Scheduled (id "));
          assert.ok(toolSuccess, "工具调用结果必须包含 Scheduled (id ");

          // 2. REST 接口中查到该任务
          const currentJobs = (await client.json("/api/jobs")).jobs as {
            id: string;
            at: string;
            daily: boolean;
            originSpaceId: string;
            nextRunAt: string;
            status: string;
          }[];
          const found = currentJobs.find((j) => j.originSpaceId === spec.spaceId && j.at === spec.at);
          assert.ok(found, `合法排期 ${spec.at} 必须在 jobs 中创建成功`);
          createdJobIds.add(found.id);
          capturedValidJobIds[spec.at] = found.id;

          // 3. 校验服务端本地 nextRunAt
          assertLocalNextRun(found.nextRunAt, referenceTime, spec.expectedHour!, spec.expectedMinute!);

          // 4. 立即暂停任务，避免执行器在测试期间触发执行
          const pauseRes = await client.request(`/api/jobs/${found.id}/control`, { action: "pause" });
          assert.equal(pauseRes.status, 200);

          outcome.passed = true;
          outcome.evidence = {
            jobId: found.id,
            at: found.at,
            originSpaceId: found.originSpaceId,
            nextRunAt: found.nextRunAt,
            pausedImmediately: true,
          };
          process.stdout.write(`[PASS] ${spec.scenario}\n`);
        }
      } catch (err) {
        outcome.passed = false;
        outcome.error = err instanceof Error ? err.message : String(err);
        process.stdout.write(`[FAIL] ${spec.scenario}: ${outcome.error}\n`);
      }
      results.push(outcome);
    }

    // -------------------------------------------------------------------------
    // 阶段 B：使用合法创建的任务进行真实 HTTP PATCH 校验
    // -------------------------------------------------------------------------
    const targetJobId = capturedValidJobIds["00:00"] ?? capturedValidJobIds["23:59"];
    if (!targetJobId) {
      results.push({
        name: "patch-schedule-validation",
        passed: false,
        modelCalls: 0,
        toolCalls: [],
        toolResults: [],
        error: "阶段 A 合法边界任务未成功创建，无法进行真实 PATCH 校验",
      });
      process.stdout.write("[FAIL] patch-schedule-validation: 缺少前置合法任务\n");
    } else {
      const patchOutcome: ScenarioOutcome = {
        name: "patch-schedule-validation",
        passed: false,
        modelCalls: 0,
        toolCalls: [],
        toolResults: [],
      };

      try {
        // 1. 非法 PATCH（空串、09:99、24:00、9:00、invalid）：返回 400 INVALID_SCHEDULE_FORMAT 且 jobs.json 字节不变
        for (const badAt of ["", "09:99", "24:00", "9:00", "invalid"]) {
          const bytesBefore = await readFile(jobsFile, "utf8");
          const patchRes = await client.request(`/api/jobs/${targetJobId}`, { at: badAt }, "PATCH");
          assert.equal(patchRes.status, 400, `PATCH at='${badAt}' 必须返回 400`);
          const body = (await patchRes.json()) as { code?: string; error?: string };
          assert.equal(body.code, "INVALID_SCHEDULE_FORMAT");
          assert.match(body.error ?? "", /strict HH:mm/);
          const bytesAfter = await readFile(jobsFile, "utf8");
          assert.equal(bytesAfter, bytesBefore, `PATCH at='${badAt}' 失败时 jobs.json 字节不得变化`);
        }

        // 2. 非法带新 originSpaceId：不建立空间、文件不落盘
        const nonExistentSpace = "never-created-live-patch-space";
        const bytesBeforeSpace = await readFile(jobsFile, "utf8");
        const badSpacePatch = await client.request(
          `/api/jobs/${targetJobId}`,
          { at: "24:00", originSpaceId: nonExistentSpace },
          "PATCH",
        );
        assert.equal(badSpacePatch.status, 400);
        assert.equal(await readFile(jobsFile, "utf8"), bytesBeforeSpace);
        const spacesList = (await client.json("/api/spaces")).spaces as { id: string }[];
        assert.equal(spacesList.some((s) => s.id === nonExistentSpace), false, "非法 PATCH 不得创建新空间");

        // 3. 暂停状态修改为合法边界 23:59，再恢复后重算时间
        const pausePatch = await client.request(`/api/jobs/${targetJobId}`, { at: "23:59" }, "PATCH");
        assert.equal(pausePatch.status, 200);
        const resumeRefTime = new Date();
        const resumeRes = await client.request(`/api/jobs/${targetJobId}/control`, { action: "resume" });
        assert.equal(resumeRes.status, 200);
        const resumedJob = (await resumeRes.json()) as { nextRunAt: string; at: string };
        assert.equal(resumedJob.at, "23:59");
        assertLocalNextRun(resumedJob.nextRunAt, resumeRefTime, 23, 59);

        // 再次暂停避免测试后续执行
        await client.request(`/api/jobs/${targetJobId}/control`, { action: "pause" });

        patchOutcome.passed = true;
        patchOutcome.evidence = {
          badAtRejected: true,
          bytesPreserved: true,
          noSpaceCreated: true,
          pauseResumeRecalculated: true,
        };
        process.stdout.write("[PASS] patch-schedule-validation\n");
      } catch (err) {
        patchOutcome.passed = false;
        patchOutcome.error = err instanceof Error ? err.message : String(err);
        process.stdout.write(`[FAIL] patch-schedule-validation: ${patchOutcome.error}\n`);
      }
      results.push(patchOutcome);
    }
  } catch (err) {
    process.stderr.write(`Live test fatal exception: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    let cleanupFailed = false;

    // 清理本次测试创建的所有任务与空间，并确认删除
    const authToken = sessionToken;
    if (baseUrl && service && authToken) {
      for (const jobId of createdJobIds) {
        try {
          const res = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (res.ok || res.status === 404) {
            // 确认任务已被删除
            const verifyRes = await fetch(`${baseUrl}/api/jobs`, {
              headers: { Authorization: `Bearer ${authToken}` },
            });
            if (verifyRes.ok) {
              const currentJobs = (await verifyRes.json()) as { jobs: { id: string }[] };
              if (currentJobs.jobs.some((j) => j.id === jobId)) {
                cleanupFailed = true;
                process.stderr.write(`Cleanup verification failed: job ${jobId} still exists\n`);
              }
            }
          } else {
            cleanupFailed = true;
            process.stderr.write(`Cleanup job ${jobId} failed with HTTP ${res.status}\n`);
          }
        } catch {
          cleanupFailed = true;
        }
      }
      // 清理本次测试创建的独立测试空间
      for (const spaceId of createdSpaceIds) {
        try {
          const res = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
          });
          if (res.ok || res.status === 404) {
            // 确认空间已被删除
            const verifyRes = await fetch(`${baseUrl}/api/spaces`, {
              headers: { Authorization: `Bearer ${authToken}` },
            });
            if (verifyRes.ok) {
              const currentSpaces = (await verifyRes.json()) as { spaces: { id: string }[] };
              if (currentSpaces.spaces.some((s) => s.id === spaceId)) {
                cleanupFailed = true;
                process.stderr.write(`Cleanup verification failed: space ${spaceId} still exists\n`);
              }
            }
          } else {
            cleanupFailed = true;
            process.stderr.write(`Cleanup space ${spaceId} failed with HTTP ${res.status}\n`);
          }
        } catch {
          cleanupFailed = true;
        }
      }
    }

    try {
      await stopService();
    } catch {
      cleanupFailed = true;
    }
    try {
      await proxy?.close();
    } catch {
      cleanupFailed = true;
    }

    if (cleanupFailed) {
      process.stderr.write("Live test resource cleanup failed\n");
      process.exitCode = 1;
    }

    if (root) {
      if (options.keepArtifacts) {
        // 脱敏汇总：不保存真实 key 或原配置
        const summary = redactApiKey(
          JSON.stringify(
            {
              modelId: model.modelId,
              serviceVersion,
              results,
              totalModelRequests: proxy?.traces.length ?? 0,
              traces: proxy?.traces.map((t) => ({
                index: t.index,
                startedAt: t.startedAt,
                endedAt: t.endedAt,
                toolNames: t.toolNames,
                calls: t.calls,
                toolResults: t.toolResults,
                disconnected: t.disconnected,
              })),
            },
            null,
            2,
          ),
          model.apiKey,
        );
        await writeFile(join(root, "summary.json"), summary, { mode: 0o600 });
        process.stdout.write(`合成测试数据与脱敏证据保留于 ${root}\n`);
      } else {
        await rm(root, { recursive: true, force: true });
      }
    }

    // 报告汇总
    process.stdout.write(`\n--- 真实模型 A03 排期验收汇总 ---\n`);
    process.stdout.write(`modelId: ${model.modelId}\n`);
    process.stdout.write(`serviceVersion: ${JSON.stringify(serviceVersion ?? null)}\n`);
    process.stdout.write(`总模型请求数: ${proxy?.traces.length ?? 0}\n`);
    for (const r of results) {
      process.stdout.write(`- [${r.passed ? "PASS" : "FAIL"}] ${r.name}${r.error ? `: ${r.error}` : ""}\n`);
    }

    if (results.some((r) => !r.passed) || results.length === 0) {
      process.exitCode = 1;
    }
  }
};

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") {
  process.stdout.write(parsed.help);
} else if (parsed.kind === "error") {
  process.stderr.write(parsed.message + "\n");
  process.exitCode = 2;
} else {
  await execute(parsed.options).catch((err) => {
    process.stderr.write("Live setup/report failed; configuration and provider details are not printed.\n");
    process.exitCode = 1;
  });
}
