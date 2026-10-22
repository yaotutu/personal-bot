import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { conversationResponse, jobItem, jobsResponse, type JobDto } from "../../src/http/contracts/responses.js";

type ScenarioOutcome = {
  name: string;
  passed: boolean;
  modelCalls: number;
  toolCalls: { name: string; arguments: string }[];
  toolResults: string[];
  evidence?: Record<string, unknown>;
  error?: string;
};

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  // 1. 仅读取显式传入配置中的 model 段；不引用真实 dataDir 或其他业务配置
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Model configuration is required");

  process.stdout.write("真实模型 A02 空间绑定与调度验收已显式授权：测试会产生模型费用，所有文件与任务均在隔离临时实例中运行。\n");

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
    root = await mkdtemp(join(tmpdir(), "pi-muse-live-binding-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });

    // 真实 key 驻留在透明代理内存中，不写入临时配置或持久化日志
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });

    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-job-bind-key" },
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
        schedulerIntervalMs: 2_000, // 2s 扫描间隔便于近未来真实触发
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
      body: JSON.stringify({ accessKey: "live-job-bind-key" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(loginRes.status, 200);
    const { token } = (await loginRes.json()) as { token?: string };
    assert.ok(token, "Session token is required");
    sessionToken = token;
    const client = createTestClient(() => baseUrl, token, 120_000);
    serviceVersion = (await client.json("/api/health")).serviceVersion;

    const initialSpaceId = "live-binding-origin-space";
    const targetSpaceId = "live-binding-target-space";
    createdSpaceIds.push(initialSpaceId, targetSpaceId);

    // -------------------------------------------------------------------------
    // 阶段 1：在 initialSpaceId 中通过真实对话让模型调用 schedule 创建远期一次性任务
    // -------------------------------------------------------------------------
    const phase1Outcome: ScenarioOutcome = {
      name: "create-job-via-chat",
      passed: false,
      modelCalls: 0,
      toolCalls: [],
      toolResults: [],
    };

    let targetJobId = "";
    const futureIso = "2032-01-01T12:00:00+08:00";
    const uniqueMarker = "MARKER_A02_DISPATCH_" + Date.now().toString(36);
    const jobPrompt = `系统测试。到点执行时，严禁调用任何工具，请直接且仅回复：${uniqueMarker}`;

    try {
      const baseline = proxy.traces.length;
      const prompt =
        `系统测试：请严格调用 schedule 工具一次创建一次性定时提醒：action="create", prompt="${jobPrompt}", at="${futureIso}"。` +
        `不要改写时刻或提示词，不要重试。调用后简短回复。`;

      const runResult = await client.startRun(prompt, initialSpaceId);
      const events = await runResult.done;
      assert.equal(events.at(-1)?.type, "RUN_FINISHED");

      const traces = proxy.traces.slice(baseline);
      phase1Outcome.modelCalls = traces.length;
      const scheduleCalls = traces.flatMap((t) => t.calls).filter((c) => c.name === "schedule");
      phase1Outcome.toolCalls = scheduleCalls;
      phase1Outcome.toolResults = traces.flatMap((t) => t.toolResults);

      // 严格断言恰好调用一次 schedule 工具
      assert.equal(scheduleCalls.length, 1, `模型必须恰好调用一次 schedule 工具，实际调用了 ${scheduleCalls.length} 次`);

      // 验证工具调用参数
      const callArgs = JSON.parse(scheduleCalls[0].arguments) as {
        action?: string;
        prompt?: string;
        at?: string;
        daily?: boolean;
      };
      assert.equal(callArgs.action, "create", `schedule 工具参数 action 期望 create，实际 ${callArgs.action}`);
      assert.equal(callArgs.prompt, jobPrompt, `schedule 工具参数 prompt 期望 ${jobPrompt}，实际 ${callArgs.prompt}`);
      assert.equal(callArgs.at, futureIso, `schedule 工具参数 at 期望 ${futureIso}，实际 ${callArgs.at}`);
      assert.ok(callArgs.daily === undefined || callArgs.daily === false, "一次性任务不得传 daily=true");

      // 验证真实工具执行结果，而不是模型的创建声明。
      const toolSuccess = phase1Outcome.toolResults.some((tr) => tr.includes("Scheduled (id "));
      assert.ok(toolSuccess, "schedule 工具调用结果必须包含 Scheduled (id ");

      // 从 REST API 查出新创建的任务，验证参数与归属空间
      const jobsList = jobsResponse.parse(await client.json("/api/jobs")).jobs;
      const found = jobsList.find((j) => j.originSpaceId === initialSpaceId && j.prompt === jobPrompt);
      assert.ok(found, `在 initialSpaceId=${initialSpaceId} 中必须存在新创建的定时任务`);
      assert.equal(found.at, futureIso);
      assert.equal(found.daily, false);
      assert.equal(found.status, "scheduled", `新创建的任务 status 期望 scheduled，实际 ${found.status}`);
      targetJobId = found.id;
      createdJobIds.add(targetJobId);

      phase1Outcome.passed = true;
      phase1Outcome.evidence = { jobId: found.id, originSpaceId: found.originSpaceId, at: found.at, status: found.status };
      process.stdout.write(`[PASS] create-job-via-chat: jobId=${targetJobId}\n`);
    } catch (err) {
      phase1Outcome.passed = false;
      phase1Outcome.error = err instanceof Error ? err.message : String(err);
      process.stdout.write(`[FAIL] create-job-via-chat: ${phase1Outcome.error}\n`);
    }
    results.push(phase1Outcome);

    // -------------------------------------------------------------------------
    // 阶段 2：PATCH 改绑到原本不存在的 targetSpaceId；省略归属修改验证绑定保持
    // -------------------------------------------------------------------------
    const phase2Outcome: ScenarioOutcome = {
      name: "patch-rebind-and-preserve",
      passed: false,
      modelCalls: 0,
      toolCalls: [],
      toolResults: [],
    };

    if (!targetJobId) {
      phase2Outcome.error = "缺少前置任务 ID，跳过阶段 2";
      results.push(phase2Outcome);
      process.stdout.write("[FAIL] patch-rebind-and-preserve: 缺少前置任务\n");
    } else {
      try {
        // 1. 确认 targetSpaceId 目前不存在
        const spacesBefore = (await client.json("/api/spaces")).spaces as { id: string }[];
        assert.equal(spacesBefore.some((s) => s.id === targetSpaceId), false, "targetSpaceId 初始状态不得存在");

        // 2. PATCH 将 originSpaceId 改绑到 targetSpaceId
        const patchRes = await client.request(`/api/jobs/${targetJobId}`, { originSpaceId: targetSpaceId }, "PATCH");
        assert.equal(patchRes.status, 200, "PATCH 改绑空间必须返回 200");
        const patchedJob = (await patchRes.json()) as { id: string; originSpaceId: string };
        assert.equal(patchedJob.originSpaceId, targetSpaceId, "patchedJob.originSpaceId 必须为 targetSpaceId");

        // 验证 targetSpaceId 被自动创建
        const spacesAfter = (await client.json("/api/spaces")).spaces as { id: string }[];
        assert.ok(spacesAfter.some((s) => s.id === targetSpaceId), "改绑后 targetSpaceId 必须出现在 spaces 列表中");

        // 3. 省略 originSpaceId 的 PATCH 修改（如只改 prompt），验证 originSpaceId 保持不变且不新建额外空间
        const spacesCountBefore = spacesAfter.length;
        const updatedPrompt = `${jobPrompt}。只返回标记，不补充说明。`;
        const patchPromptRes = await client.request(
          `/api/jobs/${targetJobId}`,
          { prompt: updatedPrompt },
          "PATCH",
        );
        assert.equal(patchPromptRes.status, 200);
        const preservedJob = (await patchPromptRes.json()) as { id: string; prompt: string; originSpaceId: string };
        assert.equal(preservedJob.prompt, updatedPrompt);
        assert.equal(preservedJob.originSpaceId, targetSpaceId, "省略 originSpaceId 时必须保留既有绑定");

        const spacesCountAfter = ((await client.json("/api/spaces")).spaces as { id: string }[]).length;
        assert.equal(spacesCountAfter, spacesCountBefore, "省略 originSpaceId 的更新不得新建额外空间");

        phase2Outcome.passed = true;
        phase2Outcome.evidence = { reboundSpace: targetSpaceId, targetSpaceCreated: true, bindingPreserved: true };
        process.stdout.write("[PASS] patch-rebind-and-preserve\n");
      } catch (err) {
        phase2Outcome.passed = false;
        phase2Outcome.error = err instanceof Error ? err.message : String(err);
        process.stdout.write(`[FAIL] patch-rebind-and-preserve: ${phase2Outcome.error}\n`);
      }
      results.push(phase2Outcome);
    }

    // -------------------------------------------------------------------------
    // 阶段 3：将一次性任务排到近未来，等待真实 scheduler 到点派发调用真实模型，
    //        验证 job 终态 status=succeeded、结果落在 targetSpaceId 历史、initial 与 local-main 无误投
    // -------------------------------------------------------------------------
    const phase3Outcome: ScenarioOutcome = {
      name: "scheduler-dispatch-and-isolation",
      passed: false,
      modelCalls: 0,
      toolCalls: [],
      toolResults: [],
    };

    if (!targetJobId || !phase2Outcome.passed) {
      phase3Outcome.error = "阶段 2 改绑未通过，跳过调度派发测试";
      results.push(phase3Outcome);
      process.stdout.write("[FAIL] scheduler-dispatch-and-isolation: 缺少前置合法改绑任务\n");
    } else {
      try {
        // 创建任务的原始 user 提示词本来含 marker；比较派发前后历史，不能删历史或误判旧文本。
        const initialBefore = conversationResponse.parse(await client.history(initialSpaceId));
        const mainBefore = conversationResponse.parse(await client.history("local-main"));
        const targetBefore = conversationResponse.parse(await client.history(targetSpaceId));
        const previousTargetIds = new Set(targetBefore.messages.map((message) => message.id));
        const baseline = proxy.traces.length;
        // 将排期设定在 1 秒后（近未来）
        const nearFuture = new Date(Date.now() + 1000).toISOString();
        const patchScheduleRes = await client.request(`/api/jobs/${targetJobId}`, { at: nearFuture }, "PATCH");
        assert.equal(patchScheduleRes.status, 200);
        const scheduled = jobItem.parse(await patchScheduleRes.json());
        assert.equal(scheduled.originSpaceId, targetSpaceId, "省略 originSpaceId 的排期修改仍须保持归属");
        assert.equal(scheduled.at, nearFuture);

        // 留出扫描时间以及完整的 120s 模型运行窗口。
        const deadline = Date.now() + 150_000;
        let finalJobState: JobDto | undefined;

        while (Date.now() < deadline) {
          const currentList = jobsResponse.parse(await client.json("/api/jobs")).jobs;
          const item = currentList.find((j) => j.id === targetJobId);
          if (item && (item.status === "succeeded" || item.status === "failed")) {
            finalJobState = item;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        assert.ok(finalJobState, "超时 150s 内调度器未能执行该到期任务或未进入终态");
        assert.equal(finalJobState.status, "succeeded", `任务执行终态期望为 succeeded，实际为 ${finalJobState.status}`);
        assert.equal(finalJobState.enabled, false, "一次性任务执行完毕后 enabled 必须置为 false");

        // 真实模型被调用
        const newTraces = proxy.traces.slice(baseline);
        phase3Outcome.modelCalls = newTraces.length;
        assert.ok(newTraces.length >= 1, "调度器触发必须产生真实模型请求");

        // 检查 targetSpaceId 的历史记录：assistant 回复中必须包含 uniqueMarker
        const targetHistory = conversationResponse.parse(await client.history(targetSpaceId));
        const assistantReply = targetHistory.messages.find(
          (m) => !previousTargetIds.has(m.id) && m.role === "assistant" && m.content?.includes(uniqueMarker),
        );
        assert.ok(assistantReply, `目标空间 targetSpaceId 历史必须包含任务触发助手回复 (${uniqueMarker})`);

        const initialHistory = conversationResponse.parse(await client.history(initialSpaceId));
        assert.deepEqual(initialHistory.messages, initialBefore.messages, "派发不得改变原空间 messages");
        const mainHistory = conversationResponse.parse(await client.history("local-main"));
        assert.deepEqual(mainHistory.messages, mainBefore.messages, "派发不得改变主空间 messages");

        phase3Outcome.passed = true;
        phase3Outcome.evidence = {
          status: finalJobState.status,
          lastRunAt: finalJobState.lastRunAt,
          targetHistoryVerified: true,
          assistantMessageId: assistantReply.id,
          noLeakInitial: true,
          noLeakMain: true,
        };
        process.stdout.write("[PASS] scheduler-dispatch-and-isolation\n");
      } catch (err) {
        phase3Outcome.passed = false;
        phase3Outcome.error = err instanceof Error ? err.message : String(err);
        process.stdout.write(`[FAIL] scheduler-dispatch-and-isolation: ${phase3Outcome.error}\n`);
      }
      results.push(phase3Outcome);
    }
  } catch (err) {
    process.stderr.write(`Live binding test fatal exception: ${err instanceof Error ? err.message : String(err)}\n`);
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
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok || res.status === 404) {
            // 确认任务已被删除
            const verifyRes: Response = await fetch(`${baseUrl}/api/jobs`, {
              headers: { Authorization: `Bearer ${authToken}` },
              signal: AbortSignal.timeout(5000),
            });
            assert.equal(verifyRes.status, 200, "Cleanup jobs verification must return HTTP 200");
            const currentJobs = jobsResponse.parse(await verifyRes.json());
            if (currentJobs.jobs.some((j) => j.id === jobId)) {
              cleanupFailed = true;
              process.stderr.write(`Cleanup verification failed: job ${jobId} still exists\n`);
            }
          } else {
            cleanupFailed = true;
            process.stderr.write(`Cleanup job ${jobId} failed with HTTP ${res.status}\n`);
          }
        } catch (error) {
          cleanupFailed = true;
          process.stderr.write(`Cleanup job ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      for (const spaceId of createdSpaceIds) {
        try {
          const res = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok || res.status === 404) {
            // 确认空间已被删除
            const verifyRes: Response = await fetch(`${baseUrl}/api/spaces`, {
              headers: { Authorization: `Bearer ${authToken}` },
              signal: AbortSignal.timeout(5000),
            });
            assert.equal(verifyRes.status, 200, "Cleanup spaces verification must return HTTP 200");
            const currentSpaces = (await verifyRes.json()) as { spaces: { id: string }[] };
            if (currentSpaces.spaces.some((s) => s.id === spaceId)) {
              cleanupFailed = true;
              process.stderr.write(`Cleanup verification failed: space ${spaceId} still exists\n`);
            }
          } else {
            cleanupFailed = true;
            process.stderr.write(`Cleanup space ${spaceId} failed with HTTP ${res.status}\n`);
          }
        } catch (error) {
          cleanupFailed = true;
          process.stderr.write(`Cleanup space ${spaceId}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      // 前置断言失败时可能尚未捕获 jobId；空间级联清理后也必须确认无漏删任务。
      try {
        const verifyRes: Response = await fetch(`${baseUrl}/api/jobs`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(verifyRes.status, 200, "Final cleanup jobs verification must return HTTP 200");
        assert.equal(jobsResponse.parse(await verifyRes.json()).jobs.length, 0, "隔离实例不应残留本轮任务");
      } catch (error) {
        cleanupFailed = true;
        process.stderr.write(`Final cleanup jobs: ${error instanceof Error ? error.message : String(error)}\n`);
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

    process.stdout.write(`\n--- 真实模型 A02 空间绑定与调度验收汇总 ---\n`);
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
  await execute(parsed.options).catch(() => {
    process.stderr.write("Live setup/report failed; configuration and provider details are not printed.\n");
    process.exitCode = 1;
  });
}
