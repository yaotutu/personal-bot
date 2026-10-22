import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { approvalView, pendingApprovalsResponse } from "../../src/http/contracts/approvals.js";

type ScenarioOutcome = {
  name: string;
  passed: boolean;
  defectReproduced: boolean;
  evidence: Record<string, unknown>;
  error?: string;
};

// 同一绝对截止时间覆盖观察和流收尾，不能让每次请求再获得完整的 450 秒。
const beforeDeadline = async <T>(promise: Promise<T>, deadline: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Approval live scenario exceeded its deadline")), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally { clearTimeout(timer); }
};

const execute = async (options: { configPath: string; keepArtifacts: boolean; expectFixed: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  // 1. 仅读取显式传入配置中的 model 段；不引用真实 dataDir 或其他业务配置
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Model configuration is required");

  const expectFixed = options.expectFixed;
  process.stdout.write(
    `真实模型审批超时边界复查已显式授权（模式: ${expectFixed ? "expect-fixed [修复后验证]" : "baseline [复现120s提前取消缺陷]"}）：` +
    `测试会产生模型费用，所有文件与任务均在隔离临时实例中运行。\n`,
  );

  const results: ScenarioOutcome[] = [];
  let root: string | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let baseUrl = "";
  let serviceVersion: unknown;
  let sessionToken: string | undefined;
  const createdSpaceIds: string[] = [];

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
    root = await mkdtemp(join(tmpdir(), "pi-muse-live-approval-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });

    // 真实 key 驻留在透明代理内存中，不写入临时配置或持久化日志
    proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });

    // 默认真实口径：runTimeoutMs=120_000, actionTimeoutMs=300_000
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-approval-timeout-key" },
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
      body: JSON.stringify({ accessKey: "live-approval-timeout-key" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(loginRes.status, 200);
    const { token } = (await loginRes.json()) as { token?: string };
    assert.ok(token, "Session token is required");
    sessionToken = token;
    // 客户端超时设置 450s，覆盖 300s TTL 及模型收尾耗时
    const client = createTestClient(() => baseUrl, token, 450_000);
    serviceVersion = (await client.json("/api/health")).serviceVersion;

    const spaceId = "live-space-approval-timeout";
    createdSpaceIds.push(spaceId);

    const outcome: ScenarioOutcome = {
      name: "approval-timeout-vs-run-timeout",
      passed: false,
      defectReproduced: false,
      evidence: {},
    };
    results.push(outcome);

    const targetFileRel = "shared/live-approval-timeout-test.txt";
    const targetFileAbs = join(dataDir, "workspace", targetFileRel);
    const fileContent = "LIVE-APPROVAL-TEST-CONTENT";

    // 请求前校验文件不存在 (必须 ENOENT，其他错误抛出)
    try {
      await stat(targetFileAbs);
      assert.fail(`测试开始前目标文件不应存在: ${targetFileAbs}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const prompt =
      `系统测试：请严格只调用一次 write 工具写入文件：path="${targetFileRel}", content="${fileContent}"。` +
      `不要调用其他工具，等待人工审批，不要重试。`;

    const baselineProxyTraces = proxy.traces.length;
    const startTime = Date.now();
    const deadline = startTime + 450_000;
    const runResult = await beforeDeadline(client.startRun(prompt, spaceId), deadline);

    // 1. 等待 pending 审批项出现，最多等待 90 秒
    let capturedActionId = "";
    let actionCreatedAtIso = "";
    let actionExpiresAtIso = "";
    const pendingDeadline = startTime + 90_000;
    while (Date.now() < pendingDeadline) {
      // 用真实 pending 端点且为每次读取设置界限，避免通知流 ready 挂起越过 90s。
      const pendingResponse: Response = await fetch(`${baseUrl}/api/approvals/pending`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, pendingDeadline - Date.now()))),
      });
      assert.equal(pendingResponse.status, 200);
      const pendingList = pendingApprovalsResponse.parse(await pendingResponse.json()).approvals;
      const match = pendingList.find((p) => p.runId === runResult.runId);
      if (match) {
        capturedActionId = match.id;
        actionCreatedAtIso = match.createdAt;
        actionExpiresAtIso = match.expiresAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(capturedActionId, "在 90 秒内未能观察到 pending 审批项");
    const approvalCreatedElapsedMs = Date.now() - startTime;
    const createdAtMs = Date.parse(actionCreatedAtIso);
    const expiresAtMs = Date.parse(actionExpiresAtIso);
    const configuredTtlMs = expiresAtMs - createdAtMs;

    assert.equal(configuredTtlMs, 300_000, "审批 expiresAt-createdAt 必须严格为 300000ms");

    // 读取完整审批项详情，验证初始状态为 pending，且 preview 中 path/content 与测试请求一致
    const actionPendingDetail = approvalView.parse(await beforeDeadline(client.approval(capturedActionId), deadline));
    assert.equal(actionPendingDetail.status, "pending", "审批项初始状态必须为 pending");
    assert.equal(actionPendingDetail.kind, "file_write");
    assert.equal(actionPendingDetail.runId, runResult.runId);
    assert.equal(actionPendingDetail.spaceId, spaceId);
    assert.equal(actionPendingDetail.preview.beforeExists, false);
    assert.equal(actionPendingDetail.preview.before, "");
    assert.equal(
      actionPendingDetail.preview?.path,
      targetFileRel,
      `审批项预览 path 期望为 ${targetFileRel}，实际为 ${actionPendingDetail.preview?.path}`,
    );
    assert.equal(
      actionPendingDetail.preview?.after,
      fileContent,
      `审批项预览 after 期望为 ${fileContent}，实际为 ${actionPendingDetail.preview?.after}`,
    );

    process.stdout.write(
      `观察到待审批项 actionId=${capturedActionId}, createdAt=${actionCreatedAtIso}, expiresAt=${actionExpiresAtIso} ` +
      `(TTL ~${configuredTtlMs}ms, path=${actionPendingDetail.preview?.path})\n`,
    );
    process.stdout.write("保持不审批、不调用 stop，等待运行流终态与审批状态演变...\n");

    let pendingAfterRunBudgetMs: number | undefined;
    if (expectFixed) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startTime + 125_000 - Date.now())));
      const stillWaiting = approvalView.parse(await beforeDeadline(client.approval(capturedActionId), deadline));
      pendingAfterRunBudgetMs = Date.now() - startTime;
      assert.equal(stillWaiting.status, "pending", "跨过 120s runTimeout 后审批必须仍为 pending");
      assert.equal(runResult.events.some((event) => event.type === "RUN_ERROR" || event.type === "RUN_FINISHED"), false,
        "审批仍在等待时，运行不得已被提前结束");
      process.stdout.write(`跨过运行预算仍待审批：${pendingAfterRunBudgetMs}ms\n`);
    }

    // 2. 等待流结束 (有界等待，client timeout 450s 保证总时长有界)
    const events = await beforeDeadline(runResult.done, deadline);
    const runFinishedAtMs = Date.now();
    const runFinishedElapsedMs = Date.now() - startTime;
    const terminalEvent = events.at(-1);

    const errCode = terminalEvent?.type === "RUN_ERROR" ? terminalEvent.code : undefined;
    const errMsg = terminalEvent?.type === "RUN_ERROR" ? terminalEvent.message : undefined;
    const isTimeoutError = events.some((event) => event.type === "RUN_ERROR" &&
      (event.code === "TIMEOUT" || /timed out|TIMEOUT/i.test(event.message)));

    process.stdout.write(
      `运行流结束：耗时 ~${runFinishedElapsedMs}ms，终态事件=${terminalEvent?.type} ` +
      `(${errCode ? "code=" + errCode + ", " : ""}${errMsg ? "message=" + errMsg : ""})\n`,
    );

    // 核对真实模型请求中 write 工具调用恰好一次且参数相符
    const postRunTraces = proxy.traces.slice(baselineProxyTraces);
    const writeCalls = postRunTraces
      .flatMap((t) => t.calls)
      .filter((c) => c.name === "write");
    assert.equal(writeCalls.length, 1, `模型必须且仅能调用一次 write 工具，实际调用了 ${writeCalls.length} 次`);
    const actualWrites = events.filter((event) => event.type === "TOOL_CALL_START").filter((event) => event.toolCallName === "write");
    assert.equal(actualWrites.length, 1, "真实运行必须开始一次 write 执行");
    assert.equal(actualWrites[0].toolCallId, actionPendingDetail.toolCallId, "审批必须属于这次 write");
    const writeArgs = JSON.parse(writeCalls[0].arguments) as { path?: string; content?: string };
    assert.equal(writeArgs.path, targetFileRel, `write 工具参数 path 期望 ${targetFileRel}，实际 ${writeArgs.path}`);
    assert.equal(
      writeArgs.content,
      fileContent,
      `write 工具参数 content 期望 ${fileContent}，实际 ${writeArgs.content}`,
    );

    // 3. 立即查询审批记录与文件落盘状态
    const actionAfterRun = approvalView.parse(await beforeDeadline(client.approval(capturedActionId), deadline));
    assert.equal(actionAfterRun.createdAt, actionCreatedAtIso);
    assert.equal(actionAfterRun.expiresAt, actionExpiresAtIso);
    assert.equal(actionAfterRun.execution, null, "未经批准不得有写入执行回执");

    // 检查文件绝对不得写入 (仅允许 ENOENT，其他错误抛出)
    let fileExisted = false;
    try {
      await stat(targetFileAbs);
      fileExisted = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        fileExisted = false;
      } else {
        throw e;
      }
    }
    assert.equal(fileExisted, false, "无论超时还是取消，目标文件绝对不得被写入");

    // 审批项必须已到达终态，严禁在 pending 状态提交 approve
    const isTerminalStatus =
      actionAfterRun.status === "cancelled" || actionAfterRun.status === "expired";
    assert.ok(isTerminalStatus, `审批项终态必须为 cancelled 或 expired，实际为 ${actionAfterRun.status}`);

    // 4. 尝试晚到审批决定（late decide: approve），记录响应状态码
    const lateDecideRes = await beforeDeadline(client.decideApproval(capturedActionId, "approve"), deadline);
    const lateDecideStatus = lateDecideRes.status;
    const lateDecideBody = await beforeDeadline(lateDecideRes.json(), deadline);

    process.stdout.write(
      `审批项状态=${actionAfterRun.status}, 文件落盘=${fileExisted}, ` +
      `late decide approve 响应 HTTP ${lateDecideStatus}\n`,
    );

    // 晚到审批后再次核验文件绝未被写入 (仅允许 ENOENT，其他错误抛出)
    try {
      await stat(targetFileAbs);
      assert.fail("晚到审批后文件绝不应被写入");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    // 5. 判定基线缺陷复现还是修复后正常过期
    // 基线缺陷特征：
    // runTimeoutMs (120s) 先触发，conversation-service 调用 cancel("TIMEOUT")，
    // session.abort() 导致 files-writable 中的 signal?.aborted 成立，
    // awaitApproval 捕获 abort 后调用 actions.cancel(action.id)，审批项被标记为 "cancelled" 而非 "expired"。
    // 耗时在 120s ~ 130s 之间，且此时 Date.now() 远小于 action.expiresAt（300s）。
    const isRunTimeoutPremature =
      runFinishedElapsedMs >= 118_000 && runFinishedElapsedMs <= 135_000 &&
      terminalEvent?.type === "RUN_ERROR" && terminalEvent.code === "TIMEOUT" &&
      isTimeoutError &&
      actionAfterRun.status === "cancelled" &&
      runFinishedAtMs < expiresAtMs &&
      actionAfterRun.resolvedAt !== null && Date.parse(actionAfterRun.resolvedAt) < expiresAtMs;

    // 修复后正常过期特征：
    // 审批等待不受 120s runTimeout 干扰，一直等待至 actionTimeoutMs (300s)，
    // 审批项变为 "expired"，run 正常结束（RUN_FINISHED），无 TIMEOUT 错误。
    const isNormalTtlExpired =
      actionAfterRun.status === "expired" &&
      runFinishedAtMs >= expiresAtMs &&
      actionAfterRun.resolvedAt !== null && Date.parse(actionAfterRun.resolvedAt) >= expiresAtMs &&
      terminalEvent?.type === "RUN_FINISHED" &&
      !isTimeoutError && !events.some((event) => event.type === "RUN_ERROR");

    outcome.defectReproduced = isRunTimeoutPremature;
    outcome.evidence = {
      expectFixed,
      actionId: capturedActionId,
      approvalCreatedElapsedMs,
      pendingAfterRunBudgetMs,
      runFinishedElapsedMs,
      configuredTtlMs,
      actionCreatedAtIso,
      actionExpiresAtIso,
      terminalEventType: terminalEvent?.type,
      terminalEventPayload: terminalEvent,
      actionStatusAfterRun: actionAfterRun.status,
      fileExisted,
      lateDecideStatus,
      lateDecideBody,
      isRunTimeoutPrematureDefect: isRunTimeoutPremature,
      isNormalTtlExpired,
    };

    // 通用安全断言：
    // 1. 文件没有被写入
    // 2. late decide 被拒绝（409 无论已 cancelled 还是已 expired）
    // 3. 终态为 cancelled 或 expired
    assert.equal(fileExisted, false);
    assert.equal(lateDecideStatus, 409, "已结束的审批项进行晚到提交必须返回 HTTP 409");
    assert.ok(
      actionAfterRun.status === "cancelled" || actionAfterRun.status === "expired",
      `审批项终态必须为 cancelled 或 expired，实际为 ${actionAfterRun.status}`,
    );

    if (expectFixed) {
      // --expect-fixed 模式：必须满足已修复标准
      assert.equal(
        isNormalTtlExpired,
        true,
        `在 --expect-fixed 模式下，审批项必须达到真正 expiresAt 并进入 expired 状态且 run 正常结束，` +
        `实际 status=${actionAfterRun.status}, runFinishedElapsedMs=${runFinishedElapsedMs}ms, isNormalTtlExpired=${isNormalTtlExpired}`,
      );
      process.stdout.write("[PASS] approval-timeout: 成功验证审批 300s 正常过期且无 120s runTimeout 提前截断\n");
    } else {
      // baseline 模式：严格验证复现了 120s runTimeout 早于 300s TTL 取消缺陷
      assert.equal(
        isRunTimeoutPremature,
        true,
        `在 baseline 模式下，必须严格复现约 120 秒 TIMEOUT 提前取消审批缺陷，` +
        `实际 runFinishedElapsedMs=${runFinishedElapsedMs}ms, configuredTtlMs=${configuredTtlMs}ms, ` +
        `isTimeoutError=${isTimeoutError}, status=${actionAfterRun.status}`,
      );
      process.stdout.write("[PASS] approval-timeout: 成功严格复现 120s runTimeout 导致审批提前 cancelled 缺陷\n");
    }

    outcome.passed = true;
  } catch (err) {
    const outcome = results.at(-1);
    if (outcome) outcome.error = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Approval timeout live test fatal exception: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    let cleanupFailed = false;

    const authToken = sessionToken;
    if (baseUrl && service && authToken) {
      for (const spaceId of createdSpaceIds) {
        try {
          const res = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok || res.status === 404) {
            // 确认空间已真正被删除
            const verifyRes: Response = await fetch(`${baseUrl}/api/spaces`, {
              headers: { Authorization: `Bearer ${authToken}` },
              signal: AbortSignal.timeout(5000),
            });
            assert.equal(verifyRes.status, 200, "Cleanup spaces verification must return HTTP 200");
            const spacesList = (await verifyRes.json()) as { spaces: { id: string }[] };
            if (spacesList.spaces.some((s) => s.id === spaceId)) {
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

    process.stdout.write(`\n--- 审批超时边界复查汇总 ---\n`);
    process.stdout.write(`modelId: ${model.modelId}\n`);
    process.stdout.write(`serviceVersion: ${JSON.stringify(serviceVersion ?? null)}\n`);
    for (const r of results) {
      process.stdout.write(
        `- [${r.passed ? "PASS" : "FAIL"}] ${r.name} (mode=${expectFixed ? "expect-fixed" : "baseline"}, defectReproduced=${r.defectReproduced})${r.error ? `: ${r.error}` : ""}\n`,
      );
    }

    if (results.some((r) => !r.passed) || results.length === 0) {
      process.exitCode = 1;
    }
  }
};

const rawArgs = process.argv.slice(2);
const expectFixed = rawArgs.includes("--expect-fixed");
const filteredArgs = rawArgs.filter((arg) => arg !== "--expect-fixed");

const parsed = rawArgs.filter((arg) => arg === "--expect-fixed").length > 1
  ? { kind: "error" as const, message: "Duplicate live test option: --expect-fixed" }
  : parseLiveOptions(filteredArgs);
if (parsed.kind === "help") {
  process.stdout.write(parsed.help.replace("pnpm test:live", "node --import tsx tests/live/approval-timeout.ts"));
  process.stdout.write("\n--expect-fixed：验证 300s 自然 expired、RUN_FINISHED 且无 TIMEOUT；默认 baseline 只验证复现约 120s 提前取消缺陷，不代表修复通过。\n");
} else if (parsed.kind === "error") {
  process.stderr.write(parsed.message + "\n");
  process.exitCode = 2;
} else {
  await execute({ ...parsed.options, expectFixed }).catch(() => {
    process.stderr.write("Live setup/report failed; configuration and provider details are not printed.\n");
    process.exitCode = 1;
  });
}
