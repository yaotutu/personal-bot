import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createAuth } from "../adapters/auth/token-service.js";
import type { Config } from "../config/load-config.js";
import { createConversation } from "../features/conversation/conversation-service.js";
import { createConversationHub } from "../features/conversation/conversation-hub.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createGoalService } from "../features/goals/goal-service.js";
import { createActionService } from "../features/actions/action-service.js";
import { createMonitorService } from "../features/monitors/monitor-service.js";
import { createMonitorScheduler } from "../features/monitors/monitor-scheduler.js";
import { createSkillsService } from "../features/skills/service.js";
import { createMemoryService } from "../features/memory/memory-service.js";
import { createIdentityService } from "../features/identity/identity-service.js";
import { readProfileFile, writeProfileFile } from "../adapters/storage/profile-files.js";
import { createJobRepository } from "../adapters/storage/job-repository.js";
import { createGoalRepository } from "../adapters/storage/goal-repository.js";
import { createActionRepository } from "../adapters/storage/action-repository.js";
import { createMonitorRepository } from "../adapters/storage/monitor-repository.js";
import { createMemoryRepository } from "../adapters/storage/memory-repository.js";
import { createSkillRepository } from "../adapters/storage/skill-repository.js";
import { createHttpApp } from "../http/app.js";
import { createDataLayout, ensureThreadLayout, threadSessionsDir } from "../adapters/storage/data-layout.js";
import { createScheduler } from "../features/jobs/scheduler.js";
import { createWebService } from "../features/web/web-service.js";
import { createHttpWebTransport } from "../adapters/web/http-transport.js";
import { createOpenMeteoTransport } from "../adapters/weather/open-meteo.js";
import { createWeatherService } from "../features/weather/weather-service.js";
import { createSessionHistory } from "../adapters/pi/session-history.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openPi } from "../adapters/pi/session-factory.js";
import { createPiExecution } from "../adapters/pi/execution.js";
import type { ServiceContainer } from "./types.js";
import { createToolPresentation } from "../adapters/ag-ui/tool-presentation.js";
import { createWorkspaceEvents } from "../features/workspace/workspace-events.js";
import { createWorkspaceFileService } from "../features/workspace/files-service.js";
import { createWorkspaceCommitQueue } from "../adapters/workspace/file-commit-queue.js";
import { createWorkspaceFileStore } from "../adapters/workspace/files-store.js";
import { createActivityService } from "../features/activities/service.js";
import { createDreamRepository } from "../adapters/storage/dream-repository.js";
import { readThreadInstructions, writeThreadInstructions } from "../adapters/storage/thread-instructions.js";
import { threadInstructionsFile } from "../adapters/storage/data-layout.js";
import { createDreamService } from "../features/dream/service.js";
import { createDreamScheduler } from "../features/dream/scheduler.js";
import { createDreamProposer } from "../adapters/pi/dream-runner.js";
import { readDreamTranscript } from "../adapters/pi/session-history.js";

/**
 * 应用唯一的运行时组装入口。
 *
 * HTTP、调度器和 pi 都共享这里创建的 memory/jobs/conversation 实例，
 * 避免未来因重复创建 store 而出现两把写锁或两份会话状态。
 */
export const createService = async (config: Config): Promise<ServiceContainer & {
  app: Awaited<ReturnType<typeof createHttpApp>>;
  close: () => Promise<void>;
}> => {
  const layout = createDataLayout(config.dataDir);
  await mkdir(layout.root, { recursive: true, mode: 0o700 });

  const auth = await createAuth(config, layout);
  const workspaceEvents = createWorkspaceEvents();
  const workspaceCommits = createWorkspaceCommitQueue();
  const memoryRepository = createMemoryRepository(layout.memoryFile);
  const memory = createMemoryService(memoryRepository);
  const identity = createIdentityService(memoryRepository, {
    // SOUL/USER 文件实现放 storage adapter；空内容写空文件（等于清空人设）。
    read: (which) => readProfileFile(which === "soul" ? layout.soulFile : layout.userFile),
    write: (which, content) =>
      writeProfileFile(which === "soul" ? layout.soulFile : layout.userFile, content),
  });
  const jobs = createJobService(createJobRepository(layout.jobsFile));
  await jobs.reconcileOnStart();
  const presentation = createToolPresentation(config.presentation);
  await ensureThreadLayout(layout);
  // Web 工具是只读能力；未启用时不创建 transport，也不向 pi 声明工具。
  const weather = config.weather.enabled
    ? createWeatherService(createOpenMeteoTransport(config.web), {
        defaultCity: config.weather.defaultCity,
      })
    : undefined;
  const web = config.web.enabled
    ? createWebService(createHttpWebTransport(config.web), {
        searchResults: config.web.searchResults,
        maxSearchResults: 10,
        maxContentChars: config.web.maxContentChars,
      })
    : undefined;
  const goals = createGoalService(createGoalRepository(layout.goalsFile));
  const actions = createActionService(createActionRepository(layout.actionsFile), { onChange: (action) => workspaceEvents.approvalChanged(action) });
  const monitors = createMonitorService(createMonitorRepository(layout.monitorsFile));
  const skills = createSkillsService(createSkillRepository(layout));
  const dreamRepository = createDreamRepository(layout);

  // 多会话：每个 thread 惰性创建独立的 pi 会话树；用户级能力（memory/jobs/工具）共享。
  // pi runtime 全进程一份：provider 与 runtime key 注册一次，所有线程共用；
  // 每轮会话重建只会重复读 auth 文件与注册表，无收益。
  const modelRuntime = await ModelRuntime.create({
    authPath: layout.piAuthFile,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (config.configured) {
    modelRuntime.registerProvider("personal", {
      baseUrl: config.baseUrl,
      api: "openai-completions",
      models: [
        {
          id: config.modelId!,
          name: config.modelId!,
          reasoning: false,
          input: ["text", "image"],
          contextWindow: config.contextWindow,
          maxTokens: config.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
          },
        },
      ],
    });
    await modelRuntime.setRuntimeApiKey("personal", config.apiKey || "local-no-key");
  }

  const conversationHub = createConversationHub(
    async (spaceId, initialSessionId) => {
      const { manager, history, activities } = await createSessionHistory(layout, spaceId, presentation, initialSessionId);
      return createConversation(config, {
        spaceId,
        history,
        activities,
        beginStatus: (input) => workspaceEvents.beginRun(input),
        publishActivity: (overview) => workspaceEvents.activityChanged(overview),
        cancelApprovals: async (ownerSpaceId, runId) => {
          for (const action of await actions.list()) if (action.spaceId === ownerSpaceId && action.runId === runId && action.status === "pending") await actions.cancel(action.id);
        },
        subscribeApprovals: (ownerSpaceId, runId, listener) => actions.subscribe(({ approval }) => {
          if (approval.spaceId === ownerSpaceId && approval.runId === runId) {
            listener({ id: approval.id, pending: approval.status === "pending" });
          }
        }),
        openSession: async ({ runId, activity, status }) => createPiExecution(
          await openPi({
            config,
            spaceId,
            runId,
            activity,
            status,
            presentation,
            modelRuntime,
            layout,
            sessionManager: manager,
            memory,
            jobs,
            goals,
            actions: config.writable.enabled ? actions : undefined,
            actionTimeoutMs: config.writable.actionTimeoutMs,
            monitors,
            web,
            weather,
            skills,
            workspaceCommits,
          }),
          manager,
        ),
      });
    },
    async () => {
      const entries = await readdir(layout.sessionsDir, { withFileTypes: true });
      const snapshots = (await Promise.all(
        entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("task-")).map(async (entry) => {
          try {
            const directory = threadSessionsDir(layout, entry.name);
            const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
            // JSONL 的追加不会更新目录 mtime，必须读取会话文件的实际活动时间。
            const stats = await Promise.all(
              files.map(async (name) => ({ name, mtimeMs: (await stat(join(directory, name))).mtimeMs })),
            );
            stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
            const latest = stats[0];
            const sessionId = latest
              ? latest.name.replace(/\.jsonl$/, "").split("_").slice(1).join("_") || undefined
              : undefined;
            return [{
              id: entry.name,
              ...(sessionId ? { sessionId } : {}),
              updatedAt: new Date(latest ? latest.mtimeMs : 0).toISOString(),
            }];
          } catch (error) {
            // 列表扫描与另一会话删除可以交错；只忽略已消失目录，其余 I/O 错误仍需暴露为失败。
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        }),
      )).flat();
      if (!snapshots.some((entry) => entry.id === "local-main")) {
        snapshots.push({ id: "local-main", updatedAt: new Date(0).toISOString() });
      }
      return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  );
  // 先完整读取/校验并恢复各域，再启动任何执行源。初始化失败不会遗留 interval。
  try {
    await Promise.all([memory.list(), identity.get(), goals.list(), actions.list(), monitors.list(), dreamRepository.reconcileOnStart()]);
    await actions.cancelPending();
    workspaceEvents.seedApprovals(await actions.list());
  } catch (error) {
    await conversationHub.closeAll();
    throw error;
  }
  const mainConversation = await conversationHub.forSpace("local-main");
  const scheduler = createScheduler(config, jobs, mainConversation, (spaceId) => conversationHub.findSpace(spaceId));
  const monitorScheduler = createMonitorScheduler(
    { monitorScanIntervalMs: config.monitorScanIntervalMs, web }, monitors,
    mainConversation, (spaceId) => conversationHub.findSpace(spaceId),
  );
  let closed = false;
  let approvalExpiry: Promise<unknown> | undefined;
  const approvalTimer = setInterval(() => {
    if (!closed && !approvalExpiry) {
      approvalExpiry = actions.expirePending().catch(() => undefined).finally(() => { approvalExpiry = undefined; });
    }
  }, 1_000);
  approvalTimer.unref();
  let closing: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const lifecycle = {
    isClosing: () => closed,
    enter: () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      requests.add(pending);
      return () => { requests.delete(pending); release(); };
    },
  };
  const activities = createActivityService(conversationHub);
  const dream = createDreamService({
    repository: dreamRepository,
    notes: {
      readUser: () => readProfileFile(layout.userFile),
      writeUser: async (content) => { await identity.saveProfile({ user: content }); },
      writeUserIfUnchanged: (content, expected) => identity.writeIfUnchanged("user", content, expected),
      readSoul: () => readProfileFile(layout.soulFile),
      writeSoul: async (content) => { await identity.saveProfile({ soul: content }); },
      writeSoulIfUnchanged: (content, expected) => identity.writeIfUnchanged("soul", content, expected),
      readInstructions: (spaceId) => readThreadInstructions(threadInstructionsFile(layout, spaceId)),
      writeInstructions: async (spaceId, content) => {
        await writeThreadInstructions(threadInstructionsFile(layout, spaceId), content);
      },
      writeInstructionsIfUnchanged: (spaceId, content, expected) =>
        writeThreadInstructions(threadInstructionsFile(layout, spaceId), content, expected),
    },
    memory,
    conversations: {
      listSpaceIds: async () => (await conversationHub.spaces()).map((item) => item.id),
      spaceExists: async (spaceId) =>
        spaceId === "local-main" || (await conversationHub.findSpace(spaceId)) !== undefined,
      isSpaceBusy: async (spaceId) =>
        (await conversationHub.findSpace(spaceId))?.isRunning() ?? false,
      readTranscript: (spaceId) => readDreamTranscript(layout, spaceId),
    },
    propose: createDreamProposer({ config, layout, modelRuntime }),
  });
  const dreamScheduler = createDreamScheduler(dream);
  const workspaceFiles = createWorkspaceFileService(createWorkspaceFileStore(layout, workspaceCommits), {
    spaceExists: async (spaceId) => (await conversationHub.spaces()).some((space) => space.id === spaceId),
  });
  const dependencies = { config, layout, auth, memory, identity, jobs, goals, actions, monitors, monitorScheduler, conversationHub, scheduler, presentation, lifecycle, skills, workspaceEvents, workspaceFiles, workspaceCommits, activities, dream, dreamScheduler };
  const close = () => {
    if (closing) return closing;
    // 同步关门，所有执行源停止派发；并发取消会话，最后等待结果/HTTP 写入收尾。
    closed = true;
    clearInterval(approvalTimer);
    // 全局通知没有执行取消语义；先结束长连接，避免 HTTP server 等待它们而无法退出。
    workspaceEvents.close();
    const stopped = [scheduler.close(), monitorScheduler.close(), dreamScheduler.close(), conversationHub.closeAll()];
    closing = (async () => {
      const results = await Promise.allSettled(stopped);
      await Promise.all([...requests]);
      await approvalExpiry;
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closing;
  };
  try {
    const app = await createHttpApp(dependencies);
    scheduler.start();
    monitorScheduler.start();
    dreamScheduler.start();
    return { ...dependencies, app, close };
  } catch (error) {
    await close();
    throw error;
  }
};
