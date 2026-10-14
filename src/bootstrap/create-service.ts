import { mkdir } from "node:fs/promises";
import { createAuth } from "../adapters/auth/token-service.js";
import type { Config } from "../config/load-config.js";
import { createConversation } from "../features/conversation/conversation-service.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createMemoryService } from "../features/memory/memory-service.js";
import { createIdentityService } from "../features/identity/identity-service.js";
import { createJobRepository } from "../adapters/storage/job-repository.js";
import { createMemoryRepository } from "../adapters/storage/memory-repository.js";
import { createHttpApp } from "../http/app.js";
import { createDataLayout } from "../adapters/storage/data-layout.js";
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
  const identity = createIdentityService(memoryRepository);
  const jobs = createJobService(createJobRepository(layout.jobsFile));
  await jobs.reconcileOnStart();
  const presentation = createToolPresentation(config.presentation);
  const { manager, history } = await createSessionHistory(layout, presentation);
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
  const conversation = createConversation(config, {
    history,
    openSession: async () => createPiExecution(
      await openPi(config, manager, memory, jobs, layout, web, weather), manager,
    ),
  });
  const scheduler = createScheduler(config, jobs, conversation);
  const dependencies = { config, layout, auth, memory, identity, jobs, conversation, scheduler, presentation };
  let app: Awaited<ReturnType<typeof createHttpApp>>;
  try {
    app = await createHttpApp(dependencies);
  } catch (error) {
    await conversation.close();
    throw error;
  }
  scheduler.start();

  let closing: Promise<void> | undefined;
  return {
    ...dependencies,
    app,
    close: () => {
      if (closing) return closing;
      // close 立即停掉 interval，但不先等待正在执行的定时轮：先取消会话，
      // 再等调度器把本轮失败/完成状态落盘。并发 close 共用同一个完成信号。
      const stopped = scheduler.close();
      closing = (async () => {
        try {
          await conversation.close();
        } finally {
          await stopped;
        }
      })();
      return closing;
    },
  };
};
