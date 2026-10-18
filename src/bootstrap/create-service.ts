import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createAuth } from "../adapters/auth/token-service.js";
import type { Config } from "../config/load-config.js";
import { createConversation } from "../features/conversation/conversation-service.js";
import { createConversationHub } from "../features/conversation/conversation-hub.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createTaskService } from "../features/tasks/task-service.js";
import { createGoalService } from "../features/goals/goal-service.js";
import { createActionService } from "../features/actions/action-service.js";
import { createMonitorService } from "../features/monitors/monitor-service.js";
import { createMonitorScheduler } from "../features/monitors/monitor-scheduler.js";
import { createSkillsService } from "../features/skills/service.js";
import { createTaskWorker, type TaskWorker } from "../features/tasks/task-worker.js";
import { createMemoryService } from "../features/memory/memory-service.js";
import { createIdentityService } from "../features/identity/identity-service.js";
import { readProfileFile, writeProfileFile } from "../adapters/storage/profile-files.js";
import { createJobRepository } from "../adapters/storage/job-repository.js";
import { createTaskRepository } from "../adapters/storage/task-repository.js";
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
  const workspaceChanged = () => workspaceEvents.invalidate("workspace_updated");
  // identity 与 memory 共享同一文档和读改写队列；业务入口分开不等于写入者分开。
  // 提交回调位于共享 repository，覆盖对话工具、HTTP 和后台执行，不依赖哪个入口调用。
  const memoryRepository = createMemoryRepository(layout.memoryFile, workspaceChanged);
  const memory = createMemoryService(memoryRepository);
  const identity = createIdentityService(memoryRepository, {
    // SOUL/USER 文件实现放 storage adapter；空内容写空文件（等于清空人设）。
    read: (which) => readProfileFile(which === "soul" ? layout.soulFile : layout.userFile),
    write: (which, content) =>
      writeProfileFile(which === "soul" ? layout.soulFile : layout.userFile, content),
  });
  const jobs = createJobService(createJobRepository(layout.jobsFile, workspaceChanged));
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
  // 异步任务域先建 service；worker 依赖 hub，hub 的工具装配又需要 worker，
  // 用可变引用解开循环（worker 在 hub 就绪后立即补上，首个请求前必然完成）。
  const tasks = createTaskService(createTaskRepository(layout.tasksFile, workspaceChanged));
  const goals = createGoalService(createGoalRepository(layout.goalsFile, workspaceChanged));
  const actions = createActionService(createActionRepository(layout.actionsFile, () => workspaceEvents.invalidate("actions_updated")));
  const monitors = createMonitorService(createMonitorRepository(layout.monitorsFile, workspaceChanged));
  const skills = createSkillsService(createSkillRepository(layout));
  const workerRef: { current?: TaskWorker } = {};

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
          input: ["text"],
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
    async (threadId) => {
      const { manager, history } = await createSessionHistory(layout, threadId, presentation);
      return createConversation(config, {
        history,
        openSession: async ({ runId }) => createPiExecution(
          await openPi({
            config,
            threadId,
            runId,
            modelRuntime,
            layout,
            sessionManager: manager,
            memory,
            jobs,
            tasks,
            worker: workerRef.current,
            goals,
            actions: config.writable.enabled ? actions : undefined,
            actionTimeoutMs: config.writable.actionTimeoutMs,
            monitors,
            web,
            weather,
            skills,
          }),
          manager,
        ),
      });
    },
    async () => {
      const entries = await readdir(layout.sessionsDir, { withFileTypes: true });
      const snapshots = await Promise.all(
        entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("task-")).map(async (entry) => {
          const directory = threadSessionsDir(layout, entry.name);
          const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
          // JSONL 的追加不会更新目录 mtime，必须读取会话文件的实际活动时间。
          const times = await Promise.all(files.map(async (name) => (await stat(join(directory, name))).mtimeMs));
          return { id: entry.name, updatedAt: new Date(Math.max(0, ...times)).toISOString() };
        }),
      );
      if (!snapshots.some((entry) => entry.id === "local-main")) {
        snapshots.push({ id: "local-main", updatedAt: new Date(0).toISOString() });
      }
      return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  );
  // 先完整读取/校验并恢复各域，再启动任何执行源。初始化失败不会遗留 interval。
  try {
    await Promise.all([memory.list(), identity.get(), goals.list(), actions.list(), monitors.list()]);
    await actions.cancelPending();
    const leftovers = (await tasks.list()).filter((task) => task.status === "running");
    for (const task of leftovers) await tasks.markFinished(task.id, "failed");
  } catch (error) {
    await conversationHub.closeAll();
    throw error;
  }
  const mainConversation = await conversationHub.forThread("local-main");
  const scheduler = createScheduler(config, jobs, mainConversation, (threadId) => conversationHub.forThread(threadId));
  const monitorScheduler = createMonitorScheduler(
    { monitorScanIntervalMs: config.monitorScanIntervalMs, web }, monitors,
    mainConversation, async (threadId) => (await conversationHub.hasThread(threadId)) ? conversationHub.forThread(threadId) : mainConversation,
  );
  const taskWorker = createTaskWorker(tasks, conversationHub, mainConversation, config.runTimeoutMs, workspaceChanged);
  workerRef.current = taskWorker;
  let closed = false;
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
  const dependencies = { config, layout, auth, memory, identity, jobs, goals, tasks, taskWorker, actions, monitors, monitorScheduler, conversationHub, scheduler, presentation, lifecycle, skills, workspaceEvents };
  const close = () => {
    if (closing) return closing;
    // 同步关门，所有执行源停止派发；并发取消会话，最后等待结果/HTTP 写入收尾。
    closed = true;
    // 全局通知没有执行取消语义；先结束长连接，避免 HTTP server 等待它们而无法退出。
    workspaceEvents.close();
    const stopped = [scheduler.close(), monitorScheduler.close(), taskWorker.close(), conversationHub.closeAll()];
    closing = (async () => {
      const results = await Promise.allSettled(stopped);
      await Promise.all([...requests]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closing;
  };
  try {
    const app = await createHttpApp(dependencies);
    scheduler.start();
    monitorScheduler.start();
    taskWorker.kick();
    return { ...dependencies, app, close };
  } catch (error) {
    await close();
    throw error;
  }
};
