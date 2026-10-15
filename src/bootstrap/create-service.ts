import { mkdir } from "node:fs/promises";
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
import { createHttpApp } from "../http/app.js";
import { createDataLayout, ensureThreadLayout, threadSessionsDir } from "../adapters/storage/data-layout.js";
import { createScheduler } from "../features/jobs/scheduler.js";
import { createWebService } from "../features/web/web-service.js";
import { createHttpWebTransport } from "../adapters/web/http-transport.js";
import { createOpenMeteoTransport } from "../adapters/weather/open-meteo.js";
import { createWeatherService } from "../features/weather/weather-service.js";
import { createSessionHistory } from "../adapters/pi/session-history.js";
import { openPi } from "../adapters/pi/session-factory.js";
import { createPiExecution } from "../adapters/pi/execution.js";
import type { ServiceContainer } from "./types.js";
import { createToolPresentation } from "../adapters/ag-ui/tool-presentation.js";

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
  // identity 与 memory 共享同一文档和读改写队列；业务入口分开不等于写入者分开。
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
  // 异步任务域先建 service；worker 依赖 hub，hub 的工具装配又需要 worker，
  // 用可变引用解开循环（worker 在 hub 就绪后立即补上，首个请求前必然完成）。
  const tasks = createTaskService(createTaskRepository(layout.tasksFile));
  const goals = createGoalService(createGoalRepository(layout.goalsFile));
  const actions = createActionService(createActionRepository(layout.actionsFile));
  const monitors = createMonitorService(createMonitorRepository(layout.monitorsFile));
  const workerRef: { current?: TaskWorker } = {};

  // 多会话：每个 thread 惰性创建独立的 pi 会话树；用户级能力（memory/jobs/工具）共享。
  const conversationHub = createConversationHub(
    async (threadId) => {
      const { manager, history } = await createSessionHistory(layout, threadId, presentation);
      return createConversation(config, {
        history,
        openSession: async () => createPiExecution(
          await openPi(config, manager, memory, jobs, layout, web, weather, tasks, workerRef.current, goals, config.writable.enabled ? actions : undefined, config.writable.actionTimeoutMs, monitors), manager,
        ),
      });
    },
    async () => {
      const { readdir, stat } = await import("node:fs/promises");
      const entries = await readdir(layout.sessionsDir, { withFileTypes: true });
      const snapshots = await Promise.all(
        entries
          .filter((x) => x.isDirectory())
          .map(async (x) => ({
            id: x.name,
            updatedAt: (await stat(threadSessionsDir(layout, x.name))).mtime.toISOString(),
          })),
      );
      return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  );
  // 定时任务结果固定进入主会话（与现有语义一致）；启动时确保 main thread 就绪。
  const mainConversation = await conversationHub.forThread("local-main");
  const scheduler = createScheduler(config, jobs, mainConversation);
  const monitorScheduler = createMonitorScheduler(
    { monitorScanIntervalMs: config.monitorScanIntervalMs, web: web ? { fetch: (url, mode, max) => web.fetch(url, mode, max) } : undefined },
    monitors,
    mainConversation,
  );
  // 异步任务 worker：串行执行 + 完成通知主会话；遗留 running 标记 failed 可重试。
  const taskWorker = createTaskWorker(tasks, conversationHub, mainConversation);
  workerRef.current = taskWorker;
  const dependencies = { config, layout, auth, memory, identity, jobs, goals, tasks, taskWorker, actions, monitors, monitorScheduler, conversationHub, scheduler, presentation };
  let app: Awaited<ReturnType<typeof createHttpApp>>;
  try {
    app = await createHttpApp(dependencies);
  } catch (error) {
    await conversationHub.closeAll();
    throw error;
  }
  scheduler.start();
  monitorScheduler.start();
  {
    // 启动恢复：把上次进程中断遗留的 running 任务标记为 failed，再跑排队任务。
    const leftovers = (await tasks.list()).filter((task) => task.status === "running");
    for (const task of leftovers) await tasks.markFinished(task.id, "failed");
    taskWorker.kick();
  }

  let closing: Promise<void> | undefined;
  return {
    ...dependencies,
    app,
    close: () => {
      if (closing) return closing;
      // close 立即停掉 interval，但不先等待正在执行的定时轮：先取消会话，
      // 再等调度器把本轮失败/完成状态落盘。并发 close 共用同一个完成信号。
      const stopped = Promise.all([scheduler.close(), monitorScheduler.close()]).then(() => undefined);
      closing = (async () => {
        try {
          await Promise.all([conversationHub.closeAll(), taskWorker.close()]);
        } finally {
          await stopped;
        }
      })();
      return closing;
    },
  };
};
