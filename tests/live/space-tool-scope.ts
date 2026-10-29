import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { jobsResponse, monitorsResponse } from "../../src/http/contracts/responses.js";
import { scheduleTool } from "../../src/adapters/pi/tools/schedule.js";
import { monitorTool } from "../../src/adapters/pi/tools/monitor.js";

const execute = async (options: { configPath: string }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error("Model configuration is required");

  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let root: string | undefined;
  let failure: unknown;
  type ToolArguments = {
    action?: string;
    prompt?: string;
    url?: string;
    jobId?: string;
    monitorId?: string;
  };

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-space-tool-scope-"));
    const dataDir = join(root, "data");
    const accessKey = randomUUID();
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });

    const config = createConfig({
      server: { host: "127.0.0.1", accessKey },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 180_000,
        schedulerIntervalMs: 3_600_000,
        monitorScanIntervalMs: 3_600_000,
      },
      tools: { presentation: { default: "summary" } },
    });

    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey }),
    });
    assert.equal(login.status, 200);
    const token = ((await login.json()) as { token: string }).token;
    const client = createTestClient(() => baseUrl, token, 240_000);

    const spaceA = "live-space-tool-a";
    const spaceB = "live-space-tool-b";
    for (const spaceId of [spaceA, spaceB]) {
      await client.json(`/api/spaces/${spaceId}/instructions`, {
        instructions: "Space tool scope live test.",
      }, "PUT");
    }

    // B 的敏感标题与任务内容只在服务端状态和 REST 聚合中存在，不进入任何模型提示。
    const bJobPrompt = "LIVE_SCOPE_B_JOB_SECRET_CONTENT";
    const bMonitorTitle = "LIVE_SCOPE_B_MONITOR_SECRET_TITLE";
    const bJob = await service.jobs.add(bJobPrompt, true, "12:34", spaceB);
    const bMonitor = await service.monitors.create({
      originSpaceId: spaceB,
      title: bMonitorTitle,
      url: "https://example.com/live-space-tool-b",
      condition: "contains",
      value: "live-space-tool-b",
      intervalMinutes: 5,
    });

    const runOneTool = async (label: string, prompt: string, expected: { name: string; action: string }) => {
      const baseline = proxy!.traces.length;
      const run = await client.startRun(prompt, spaceA);
      const events = await run.done;
      assert.equal(events.at(-1)?.type, "RUN_FINISHED", `${label} run must finish`);

      const rows = proxy!.traces.slice(baseline);
      assert.ok(rows.length > 0, `${label} must call the real model`);
      const calls = rows.flatMap((row) => row.calls);
      assert.equal(calls.length, 1, `${label} must make exactly one tool call`);
      assert.equal(calls[0]?.name, expected.name, `${label} used the wrong tool`);
      const args = JSON.parse(calls[0]!.arguments) as ToolArguments;
      assert.equal(args.action, expected.action, `${label} used the wrong action`);
      return {
        args,
        rawToolResults: rows.flatMap((row) => row.toolResults).join("\n"),
      };
    };

    // 创建仍闭包到当前 A 空间，并返回可直接控制的完整 ID。
    const aJobPrompt = "LIVE_SCOPE_A_JOB_CONTENT";
    const createdJob = await runOneTool(
      "schedule-create-a",
      `系统测试。请只调用一次 schedule 工具：action="create"，prompt="${aJobPrompt}"，daily=true，at="11:11"。不要调用其它工具，不要重试。`,
      { name: "schedule", action: "create" },
    );
    assert.equal(createdJob.args.prompt, aJobPrompt);
    const aJob = (await service.jobs.list()).find((job) => job.originSpaceId === spaceA && job.prompt === aJobPrompt);
    assert.ok(aJob);
    assert.match(createdJob.rawToolResults, new RegExp(`Scheduled \\(id ${aJob.id}\\)`));

    const aMonitorTitle = "LIVE_SCOPE_A_MONITOR_TITLE";
    const createdMonitor = await runOneTool(
      "monitor-create-a",
      `系统测试。请只调用一次 monitor 工具：action="create"，url="https://example.com/live-space-tool-a"，condition="contains"，value="live-space-tool-a"，title="${aMonitorTitle}"，intervalMinutes=5。不要调用其它工具，不要重试。`,
      { name: "monitor", action: "create" },
    );
    assert.equal(createdMonitor.args.url, "https://example.com/live-space-tool-a");
    const aMonitor = (await service.monitors.list()).find(
      (monitor) => monitor.originSpaceId === spaceA && monitor.title === aMonitorTitle,
    );
    assert.ok(aMonitor);
    assert.match(createdMonitor.rawToolResults, new RegExp(`Monitor created \\(id ${aMonitor.id}\\)`));

    // 列表必须先于任何 B ID 出现在聊天上下文中，证明 B 内容不是靠提示隐藏。
    const scheduleList = await runOneTool(
      "schedule-list-a",
      `系统测试。请只调用一次 schedule 工具：action="list"，prompt="list"，at="list"。不要调用其它工具，不要重试。`,
      { name: "schedule", action: "list" },
    );
    assert.match(scheduleList.rawToolResults, new RegExp(`- ${aJob.id} daily 11:11.*${aJobPrompt}`));
    assert.ok(!scheduleList.rawToolResults.includes(bJob.id));
    assert.ok(!scheduleList.rawToolResults.includes(bJobPrompt));

    const monitorList = await runOneTool(
      "monitor-list-a",
      `系统测试。请只调用一次 monitor 工具：action="list"。不要调用其它工具，不要重试。`,
      { name: "monitor", action: "list" },
    );
    assert.match(monitorList.rawToolResults, new RegExp(`- ${aMonitor.id} \\[active\\] ${aMonitorTitle}`));
    assert.ok(!monitorList.rawToolResults.includes(bMonitor.id));
    assert.ok(!monitorList.rawToolResults.includes(bMonitorTitle));

    // 持有完整外空间 ID 也不能通过列表隐藏以外的第二套入口控制。
    const beforeCrossCancel = await service.jobs.get(bJob.id);
    const crossCancel = await runOneTool(
      "schedule-cancel-b",
      `系统测试。请只调用一次 schedule 工具：action="cancel"，prompt="cancel"，at="cancel"，jobId="${bJob.id}"。不要调用其它工具，不要重试。`,
      { name: "schedule", action: "cancel" },
    );
    assert.equal(crossCancel.args.jobId, bJob.id);
    assert.ok(crossCancel.rawToolResults.includes("No such job."));
    const afterCrossCancel = await service.jobs.get(bJob.id);
    assert.equal(afterCrossCancel?.enabled, beforeCrossCancel?.enabled);
    assert.equal(afterCrossCancel?.controlState, beforeCrossCancel?.controlState);

    for (const action of ["pause", "resume", "stop"] as const) {
      const crossControl = await runOneTool(
        `monitor-${action}-b`,
        `系统测试。请只调用一次 monitor 工具：action="${action}"，monitorId="${bMonitor.id}"。不要调用其它工具，不要重试。`,
        { name: "monitor", action },
      );
      assert.equal(crossControl.args.monitorId, bMonitor.id);
      assert.ok(crossControl.rawToolResults.includes("Monitor not found"));
      assert.equal((await service.monitors.get(bMonitor.id))?.status, "active");
    }

    const ownCancel = await runOneTool(
      "schedule-cancel-a",
      `系统测试。请只调用一次 schedule 工具：action="cancel"，prompt="cancel"，at="cancel"，jobId="${aJob.id}"。不要调用其它工具，不要重试。`,
      { name: "schedule", action: "cancel" },
    );
    assert.equal(ownCancel.args.jobId, aJob.id);
    assert.ok(ownCancel.rawToolResults.includes("Cancelled."));
    assert.equal((await service.jobs.get(aJob.id))?.controlState, "cancelled");

    const ownPause = await runOneTool(
      "monitor-pause-a",
      `系统测试。请只调用一次 monitor 工具：action="pause"，monitorId="${aMonitor.id}"。不要调用其它工具，不要重试。`,
      { name: "monitor", action: "pause" },
    );
    assert.equal(ownPause.args.monitorId, aMonitor.id);
    assert.ok(ownPause.rawToolResults.includes("Monitor paused."));
    assert.equal((await service.monitors.get(aMonitor.id))?.status, "paused");

    const scheduleMissing = await scheduleTool(service.jobs, spaceA).execute(
      "direct-missing-job",
      { action: "cancel", prompt: "cancel", at: "cancel", jobId: "missing-job-id" },
      undefined,
      undefined,
      {} as never,
    );
    const scheduleMissingText = scheduleMissing.content[0]?.type === "text" ? scheduleMissing.content[0].text : "";
    assert.equal(scheduleMissingText, "No such job.");

    const monitorMissing = await monitorTool(service.monitors, spaceA).execute(
      "direct-missing-monitor",
      { action: "pause", monitorId: "missing-monitor-id" },
      undefined,
      undefined,
      {} as never,
    );
    const monitorMissingText = monitorMissing.content[0]?.type === "text" ? monitorMissing.content[0].text : "";
    assert.equal(monitorMissingText, "Monitor not found");

    const globalJobs = jobsResponse.parse(await client.json("/api/jobs")).jobs;
    assert.ok(globalJobs.some((job) => job.id === aJob.id && job.originSpaceId === spaceA));
    assert.ok(globalJobs.some((job) => job.id === bJob.id && job.originSpaceId === spaceB));
    const globalMonitors = monitorsResponse.parse(await client.json("/api/monitors")).monitors;
    assert.ok(globalMonitors.some((monitor) => monitor.id === aMonitor.id && monitor.originSpaceId === spaceA));
    assert.ok(globalMonitors.some((monitor) => monitor.id === bMonitor.id && monitor.originSpaceId === spaceB));

    process.stdout.write(`[PASS] space-tool-scope: modelRequests=${proxy.traces.length}, spaces=2, jobs=2, monitors=2\n`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup: Array<{ label: string; promise: Promise<unknown> }> = [];
    if (service) cleanup.push({ label: "service", promise: service.close() });
    if (http) {
      if ("closeAllConnections" in http) http.closeAllConnections();
      cleanup.push({
        label: "http",
        promise: new Promise<void>((resolve, reject) => http!.close((error) => error ? reject(error) : resolve())),
      });
    }
    if (proxy) cleanup.push({ label: "model proxy", promise: proxy.close() });
    const results = await Promise.allSettled(cleanup.map((item) => item.promise));
    if (root) await rm(root, { recursive: true, force: true });
    const failures = results
      .map((result, index) => result.status === "rejected"
        ? `${cleanup[index]!.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        : undefined)
      .filter((message): message is string => Boolean(message));
    if (failures.length) {
      const message = `Cleanup failed (${failures.join("; ")})`;
      if (failure === undefined) throw new Error(message);
      throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; ${message}`);
    }
  }
};

const outcome = parseLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help);
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else if (outcome.options.keepArtifacts) {
  console.error("--keep-artifacts is not supported by this focused live check");
  process.exitCode = 1;
} else {
  try {
    await execute(outcome.options);
  } catch (error) {
    console.error(`[FAIL] space-tool-scope: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
