import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { MonitorService } from "../../../features/monitors/monitor-service.js";
import type { MonitorCondition } from "../../../features/monitors/types.js";

/** 对话式监控工具：创建/列表/暂停/恢复/停止。检查由调度器周期执行。 */
export const monitorTool = (
  monitors: Pick<MonitorService, "create" | "list" | "control">,
  originSpaceId?: string,
) =>
  defineTool({
    name: "monitor",
    label: "Web monitors",
    description:
      "Watch a web page periodically and notify this conversation when it changes or starts containing a keyword. " +
      "create: url + condition (change | contains; contains needs value keyword) + optional intervalMinutes (min 5, default 30) + short title. " +
      "list shows monitors with last-check status; pause/resume/stop control one by monitorId. " +
      "The first change-check establishes a baseline and does not notify; use contains for keyword alerts.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("stop"),
        ]),
        url: Type.Optional(
          Type.String({
            description: "The public http(s) page to watch (required for create).",
          }),
        ),
        condition: Type.Optional(
          Type.Union([Type.Literal("change"), Type.Literal("contains")]),
        ),
        value: Type.Optional(Type.String({ description: "Keyword for contains." })),
        title: Type.Optional(Type.String({ description: "Short label (create)." })),
        intervalMinutes: Type.Optional(Type.Number({ description: "Check interval, min 5." })),
        monitorId: Type.Optional(Type.String({ description: "Monitor id for control." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "create") {
        if (!params.url || !/^https?:\/\//.test(params.url))
          return {
            content: [{ type: "text", text: "url must be a public http(s) URL." }],
            details: undefined,
            isError: true,
          };
        try {
          const monitor = await monitors.create({
            originSpaceId,
            title: params.title ?? params.url,
            url: params.url,
            condition: (params.condition ?? "change") as MonitorCondition,
            value: params.value,
            intervalMinutes: params.intervalMinutes,
          });
          return {
            content: [
              {
                type: "text",
                text: `Monitor created (id ${monitor.id}): watching ${monitor.url} every ${monitor.intervalMinutes}min (${monitor.condition}). First check sets the baseline.`,
              },
            ],
            details: undefined,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: (error as Error).message }],
            details: undefined,
            isError: true,
          };
        }
      }
      if (params.action === "list") {
        const list = await monitors.list();
        const lines = list.map(
          (m) =>
            `- ${m.id} [${m.status}] ${m.title} · ${m.condition}${m.value ? ` "${m.value}"` : ""} · every ${m.intervalMinutes}min · checks=${m.checks}${m.error ? ` · ${m.error}` : ""}`,
        );
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "No monitors." }],
          details: undefined,
        };
      }
      if (!params.monitorId)
        return {
          content: [{ type: "text", text: "control needs monitorId (see list)." }],
          details: undefined,
          isError: true,
        };
      const action = params.action as "pause" | "resume" | "stop";
      const result = await monitors.control(params.monitorId, action);
      return {
        content: [
          { type: "text", text: result.ok ? `Monitor ${action}d.` : result.message },
        ],
        details: undefined,
        isError: !result.ok,
      };
    },
  });
