import type { Conversation } from "../conversation/conversation-service.js";
import type { MonitorService } from "./monitor-service.js";
import type { WebService } from "../web/types.js";

export type MonitorScheduler = {
  start: () => void;
  isBusy: () => boolean;
  close: () => Promise<void>;
};

/**
 * 监控调度器：每分钟扫一次表，到期的 active monitor 抓取一次并按域内
 * 去重语义决定是否通知主会话。抓取复用 web 服务（DNS 校验/私网拒绝/
 * 大小超时限制全部生效）；页面内容是不可信数据，通知摘要已截断。
 * 单次检查失败只记 error 不通知（网页抖动常见）；进程崩溃后重启，
 * 到期时间由 lastCheckedAt 重算，无断点续跑（崩了重跑哲学）。
 */
export const createMonitorScheduler = (
  config: { monitorScanIntervalMs: number; web?: Pick<WebService, "fetch"> },
  monitors: Pick<MonitorService, "list" | "check">,
  mainConversation: Pick<Conversation, "isRunning" | "trigger">,
): MonitorScheduler => {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let scanning = false;
  let closing: Promise<void> | undefined;

  const dueMonitors = async () => {
    const now = Date.now();
    return (await monitors.list()).filter(
      (monitor) =>
        monitor.status === "active" &&
        (!monitor.lastCheckedAt ||
          now - Date.parse(monitor.lastCheckedAt) >= monitor.intervalMinutes * 60_000),
    );
  };

  const scan = async () => {
    if (scanning || closed) return;
    scanning = true;
    try {
      for (const monitor of await dueMonitors()) {
        if (closed) return;
        if (!config.web) {
          await monitors.check(monitor.id, { error: "web tools disabled" });
          continue;
        }
        // web.fetch 从不抛错：失败也返回 {"error": ...} JSON，成功返回
        // {"text": ...}（含不可信 banner）。解析成 body/error 再交给域逻辑。
        let result: { body?: string; error?: string };
        try {
          const raw = await config.web.fetch(monitor.url, "text", 20_000);
          const parsed = JSON.parse(raw) as { text?: string; error?: string };
          result =
            typeof parsed.text === "string"
              ? { body: parsed.text }
              : { error: "fetch rejected" };
        } catch {
          result = { error: "fetch failed" };
        }
        const { outcome } = await monitors.check(monitor.id, result);
        if (outcome.kind === "notified" && !mainConversation.isRunning()) {
          await mainConversation
            .trigger(
              `📡 [监控] ${monitor.title}（${monitor.url}）` +
                (monitor.condition === "contains"
                  ? ` 命中关键词"${monitor.value}"`
                  : " 内容有变化") +
                `\n摘要：${outcome.summary}`,
              `monitor-${monitor.id}-${Date.now()}`,
            )
            .catch(() => undefined);
        }
      }
    } finally {
      scanning = false;
    }
  };

  return {
    start: () => {
      if (timer || closed) return;
      timer = setInterval(() => void scan(), config.monitorScanIntervalMs);
    },
    isBusy: () => scanning,
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      closing = (async () => {
        while (scanning) await new Promise((resolve) => setTimeout(resolve, 100));
      })();
      return closing;
    },
  };
};
