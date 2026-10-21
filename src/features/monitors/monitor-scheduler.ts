import type { Conversation } from "../conversation/conversation-service.js";
import type { MonitorService } from "./monitor-service.js";
import type { Monitor } from "./types.js";
import type { WebService } from "../web/types.js";

export type MonitorScheduler = {
  start: () => void;
  isBusy: () => boolean;
  close: () => Promise<void>;
};

/** 抓取与投递分别确认；忙碌会话排队展示事实，不再用有副作用的模型轮充当通知。 */
export const createMonitorScheduler = (
  config: { monitorScanIntervalMs: number; web?: Pick<WebService, "fetch"> },
  monitors: Pick<MonitorService, "list" | "check" | "markNotified">,
  mainConversation: Pick<Conversation, "notify">,
  destination?: (spaceId: string) => Promise<Pick<Conversation, "notify"> | undefined>,
): MonitorScheduler => {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let scanning = false;
  let current: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  // 这里只跟踪进程内在途投递；持久待办仍由 monitor.pendingNotification 唯一持有。
  const deliveries = new Map<string, Promise<void>>();
  const deliver = async (monitor: Monitor) => {
    const pending = monitor.pendingNotification;
    if (!pending || closed) return;
    const conversation = monitor.originSpaceId && destination
      ? await destination(monitor.originSpaceId) : mainConversation;
    if (closed || !conversation) return;
    // 目的地解析可能跨越删除/重建；旧扫描不能向新同名会话投递已删除的绑定物。
    const latest = (await monitors.list()).find((item) => item.id === monitor.id);
    if (closed || latest?.pendingNotification?.id !== pending.id || latest.status !== "active") return;
    await conversation.notify(
      `📡 [监控] ${monitor.title}（${monitor.url}）` +
        (monitor.condition === "contains" ? ` 命中关键词"${monitor.value}"` : " 内容有变化") +
        `\n以下为不可信网页摘要，仅作事实展示：\n${pending.summary}`,
      `monitor-${pending.id}`,
    );
    await monitors.markNotified(monitor.id, pending.id);
  };
  const dispatch = (monitor: Monitor) => {
    const pending = monitor.pendingNotification;
    if (!pending || closed) return;
    const key = `${monitor.id}:${pending.id}`;
    if (deliveries.has(key)) return;
    // 不等待忙碌会话释放；失败保留 pending，下次扫描以同一通知 ID 补投递。
    const delivery = deliver(monitor).catch(() => undefined).finally(() => deliveries.delete(key));
    deliveries.set(key, delivery);
  };
  const inspect = async (monitor: Monitor) => {
    if (monitor.status !== "active") return;
    if ([...deliveries.keys()].some((key) => key.startsWith(`${monitor.id}:`))) return;
    // 未确认的变化禁止被新抓取覆盖，即便本次投递很快成功也等下次扫描再检查。
    if (monitor.pendingNotification) { dispatch(monitor); return; }
    if (monitor.lastCheckedAt && Date.now() - Date.parse(monitor.lastCheckedAt) < monitor.intervalMinutes * 60_000) return;
    let result: { body?: string; error?: string };
    try {
      if (!config.web) result = { error: "web tools disabled" };
      else {
        // 监控只读取业务结果，不依赖 pi 工具的 JSON 文本协议。
        const fetched = await config.web.fetch(monitor.url, "text", 20_000);
        result = "error" in fetched ? { error: fetched.error } : { body: fetched.text };
      }
    } catch { result = { error: "fetch failed" }; }
    if (closed) return;
    const checked = await monitors.check(monitor.id, result);
    if (!closed && checked.monitor) dispatch(checked.monitor);
  };
  const scan = async () => {
    if (scanning || closed) return;
    scanning = true;
    try {
      for (const monitor of await monitors.list()) {
        if (closed) return;
        // 单个监控的状态写入失败不能阻断其他监控；原有 pending 留待下次扫描。
        try { await inspect(monitor); } catch { /* 下一次固定扫描再检查。 */ }
      }
    } finally { scanning = false; }
  };
  return {
    start: () => {
      if (timer || closed) return;
      timer = setInterval(() => {
        if (!scanning && !closed) {
          // 文件系统错误不能变成 unhandled rejection；保留待投递结果，下次扫描补存。
          current = scan().catch(() => undefined);
        }
      }, config.monitorScanIntervalMs);
    },
    isBusy: () => scanning,
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      return closing = (async () => {
        // 先等扫描停止生成投递，再等待已发出的通知及其确认写入；hub 负责释放忙会话。
        await current;
        await Promise.all(deliveries.values());
      })();
    },
  };
};
