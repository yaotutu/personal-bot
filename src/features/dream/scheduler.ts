import { DREAM_INTERVAL_MS, type DreamService } from "./service.js";

export type DreamScheduler = {
  start: () => void;
  close: () => Promise<void>;
};

/**
 * Dream 周期调度器：默认每 2 小时扫描一次，由 bootstrap 唯一启动与关闭。
 * 关闭时立即中断在途整理轮并等待状态写入收尾，不遗留后台定时器。
 */
export const createDreamScheduler = (
  dream: Pick<DreamService, "runScheduledTick" | "close">,
  intervalMs = DREAM_INTERVAL_MS,
): DreamScheduler => {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let runningTick: Promise<void> | undefined;
  const controller = new AbortController();

  const tick = () => {
    if (closed || runningTick) return;
    runningTick = dream
      .runScheduledTick(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        runningTick = undefined;
      });
  };

  return {
    start: () => {
      if (closed || timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller.abort();
      closing = (async () => {
        await runningTick;
        await dream.close();
      })();
      return closing;
    },
  };
};
