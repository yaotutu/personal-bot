import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type {
  Monitor,
  MonitorCheckOutcome,
  MonitorCondition,
  MonitorRepository,
} from "./types.js";

const MIN_INTERVAL_MINUTES = 5;

/** 业务入口：CRUD、控制与单次检查的状态落盘（检查的抓取由调用方注入）。 */
export const createMonitorService = (repository: MonitorRepository) => {
  const now = () => new Date().toISOString();
  return {
    list: (): Promise<Monitor[]> => repository.read(),
    get: async (id: string): Promise<Monitor | undefined> =>
      (await repository.read()).find((monitor) => monitor.id === id),
    create: (
      input: { title?: string; url: string; condition: MonitorCondition; value?: string; intervalMinutes?: number; originSpaceId?: string },
    ): Promise<Monitor> =>
      repository.update((items) => {
        if (input.condition === "contains" && !input.value?.trim())
          throw Object.assign(new Error("contains condition needs a keyword"), {
            code: "INVALID_MONITOR",
          });
        const monitor: Monitor = {
          id: randomUUID(),
          title: (input.title ?? "").trim().slice(0, 120) || input.url.slice(0, 120),
          url: input.url.trim(),
          condition: input.condition,
          value: input.value?.trim() || undefined,
          intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, input.intervalMinutes ?? 30),
          status: "active",
          createdAt: now(),
          originSpaceId: input.originSpaceId,
                    checks: 0,
        };
        items.push(monitor);
        return { items, result: monitor };
      }),
    control: (
      id: string,
      action: "pause" | "resume" | "stop",
    ): Promise<
      | { ok: true; monitor: Monitor }
      | { ok: false; code: "not_found" | "invalid_state"; message: string }
    > =>
      repository.update(
        (items): {
          items?: Monitor[];
          result:
            | { ok: true; monitor: Monitor }
            | { ok: false; code: "not_found" | "invalid_state"; message: string };
        } => {
          const monitor = items.find((x) => x.id === id);
          if (!monitor)
            return { result: { ok: false, code: "not_found", message: "Monitor not found" } };
          if (
            (action === "pause" && monitor.status !== "active") ||
            (action === "resume" && monitor.status !== "paused") ||
            (action === "stop" && monitor.status === "stopped")
          )
            return {
              result: {
                ok: false,
                code: "invalid_state",
                message: `Cannot ${action} a ${monitor.status} monitor`,
              },
            };
          monitor.status =
            action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
          return { items, result: { ok: true, monitor } };
        },
      ),
    update: (
      id: string,
      input: {
        title?: string;
        url?: string;
        condition?: MonitorCondition;
        value?: string;
        intervalMinutes?: number;
        originSpaceId?: string;
      },
    ): Promise<Monitor | undefined> =>
      repository.update((items) => {
        const monitor = items.find((x) => x.id === id);
        if (!monitor) return { result: undefined };

        const nextCondition = input.condition ?? monitor.condition;
        const nextValue = input.value !== undefined ? (input.value.trim() || undefined) : monitor.value;
        if (nextCondition === "contains" && !nextValue) {
          throw Object.assign(new Error("contains condition needs a keyword"), {
            code: "INVALID_MONITOR",
          });
        }

        if (input.title !== undefined) {
          monitor.title = input.title.trim().slice(0, 120) || monitor.title;
        }
        const urlChanged = input.url !== undefined && input.url.trim() !== monitor.url;
        const conditionChanged = input.condition !== undefined && input.condition !== monitor.condition;
        const valueChanged = input.value !== undefined && nextValue !== monitor.value;
        const currentOrigin = monitor.originSpaceId ?? "local-main";
        const nextOrigin = input.originSpaceId ?? currentOrigin;
        const originChanged = input.originSpaceId !== undefined && nextOrigin !== currentOrigin;

        if (input.url !== undefined) {
          monitor.url = input.url.trim();
        }
        monitor.condition = nextCondition;
        monitor.value = nextValue;

        if (input.intervalMinutes !== undefined) {
          monitor.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, input.intervalMinutes);
        }

        if (input.originSpaceId !== undefined) {
          monitor.originSpaceId = nextOrigin;
        }

        if (urlChanged || conditionChanged || valueChanged) {
          monitor.lastFingerprint = undefined;
          monitor.lastMatched = undefined;
          monitor.pendingNotification = undefined;
          monitor.error = undefined;
        } else if (originChanged) {
          monitor.pendingNotification = undefined;
        }
        return { items, result: monitor };
      }),
    markNotified: (id: string, notificationId: string) => repository.update((items) => {
      const monitor = items.find((item) => item.id === id);
      if (!monitor || monitor.pendingNotification?.id !== notificationId) return { result: false };
      monitor.lastNotifiedAt = now();
      monitor.pendingNotification = undefined;
      return { items, result: true };
    }),
    remove: (id: string): Promise<boolean> =>
      repository.update((items) => {
        const before = items.length;
        const next = items.filter((x) => x.id !== id);
        return before === next.length
          ? { result: false }
          : { items: next, result: true };
      }),
    removeByOriginSpaceId: (originSpaceId: string): Promise<number> =>
      repository.update((items) => {
        const next = items.filter((x) => (x.originSpaceId ?? "local-main") !== originSpaceId);
        const count = items.length - next.length;
        return { items: next, result: count };
      }),
    /** 重置空间会话但保留监控时，清空尚未投递的旧通知，避免污染新会话。 */
    clearPendingByOriginSpaceId: (originSpaceId: string): Promise<number> =>
      repository.update((items) => {
        let cleared = 0;
        for (const item of items) {
          const itemOrigin = item.originSpaceId ?? "local-main";
          if (itemOrigin === originSpaceId && item.pendingNotification) {
            item.pendingNotification = undefined;
            cleared++;
          }
        }
        return cleared ? { items, result: cleared } : { result: 0 };
      }),
    /**
     * 执行一次检查并落盘。body 是抓取到的正文（由 scheduler 注入，复用 web
     * 安全边界）；失败时调用方传 error。去重语义在域内：
     * change——首检不通知（建立基线），指纹变化才通知；
     * contains——从"未命中"进入"命中"才通知。
     */
    check: (
      id: string,
      result: { body?: string; error?: string },
    ): Promise<{ monitor?: Monitor; outcome: MonitorCheckOutcome }> =>
      repository.update(
        (items): {
          items?: Monitor[];
          result: { monitor?: Monitor; outcome: MonitorCheckOutcome };
        } => {
          const monitor = items.find((x) => x.id === id);
          if (!monitor || monitor.status !== "active")
            return { result: { outcome: { kind: "silent" } } };
          monitor.checks += 1;
          monitor.lastCheckedAt = now();
          if (result.error) {
            // 抓取失败只记错误不通知（网页偶发抖动常见）；连续失败可见于 error 字段。
            monitor.error = "Fetch failed";
            return { items, result: { monitor, outcome: { kind: "error", message: result.error } } };
          }
          monitor.error = undefined;
          const body = result.body ?? "";
          if (monitor.condition === "change") {
            const fingerprint = createHash("sha256").update(body).digest("hex").slice(0, 32);
            const previous = monitor.lastFingerprint;
            monitor.lastFingerprint = fingerprint;
            if (previous === undefined || previous === fingerprint)
              return { items, result: { monitor, outcome: { kind: "silent" } } };
            const summary = body.replace(/\s+/g, " ").trim().slice(0, 300);
            monitor.pendingNotification = { id: randomUUID(), summary };
            return {
              items,
              result: { monitor, outcome: { kind: "notified", summary } },
            };
          }
          const matched = monitor.value ? body.includes(monitor.value) : false;
          const wasMatched = monitor.lastMatched ?? false;
          monitor.lastMatched = matched;
          if (!matched || wasMatched)
            return { items, result: { monitor, outcome: { kind: "silent" } } };
          const at = body.indexOf(monitor.value!);
          const around = body.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, " ");
          monitor.pendingNotification = { id: randomUUID(), summary: around };
          return {
            items,
            result: { monitor, outcome: { kind: "notified", summary: around } },
          };
        },
      ),
  };
};

export type MonitorService = ReturnType<typeof createMonitorService>;
