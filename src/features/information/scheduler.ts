import type { InformationService } from "./service.js";

export type InformationScheduler = {
  start: () => void;
  close: () => Promise<void>;
};

/** 单进程全局扫描；同一时刻是否运行由 InformationService 自己收口。 */
export const createInformationScheduler = (information: Pick<InformationService, "nextDueSpace" | "runDue">) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let scan: Promise<void> = Promise.resolve();
  let scanning = false;

  const tick = async () => {
    const spaceId = await information.nextDueSpace();
    if (spaceId) await information.runDue(spaceId);
  };
  return {
    start: () => {
      if (closed || timer) return;
      timer = setInterval(() => {
        if (closed || scanning) return;
        scanning = true;
        scan = tick().catch(() => undefined).finally(() => {
          scanning = false;
        });
      }, 500);
      timer.unref();
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      closing = scan;
      return closing;
    },
  };
};
