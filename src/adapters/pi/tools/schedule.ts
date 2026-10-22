import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { JobService } from "../../../features/jobs/job-service.js";
import {
  assertValidSchedule,
  InvalidScheduleError,
} from "../../../features/jobs/schedule-calculator.js";

type ScheduleToolDetails = { id?: string; denied?: true } | undefined;

const deniedResult = (text: string): AgentToolResult<ScheduleToolDetails> => ({
  content: [{ type: "text", text }],
  details: { denied: true },
  isError: true,
});

// P4 对话式定时任务工具：模型把自然语言时间转成参数。一次性用 ISO 时间
// （含时区），每日用严格 HH:mm（00:00 至 23:59）。崩了重跑哲学：调度器只是扫表 + 诚实状态。
export const scheduleTool = (jobs: Pick<JobService, "add" | "list" | "cancel">, spaceId?: string) =>
  defineTool({
    name: "schedule",
    label: "Scheduled jobs",
    description:
      "Create, list, or cancel scheduled jobs that run later in this conversation. " +
      "Create: pass the user's request as prompt and the time as at — a one-time ISO 8601 timestamp with timezone (e.g. 2026-10-12T09:00:00+08:00) for reminders, or strict HH:mm (00:00 to 23:59) with daily=true for recurring daily jobs. " +
      "List shows current jobs; cancel removes one by jobId. Confirm the schedule to the user after creating.",
    // prompt/at 必填：实测部分模型会省略 prompt 期望从上下文推断，必填 +
    // 描述里显式说明可最大化遵循度；list/cancel 分支忽略这两个字段。
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("cancel"),
        ]),
        prompt: Type.String({
          description:
            "REQUIRED for every action (use a placeholder for list/cancel). For create: the full reminder/job text to run at the scheduled time, self-contained.",
        }),
        at: Type.String({
          description:
            "REQUIRED for every action (use a placeholder for list/cancel). For create: ISO 8601 with timezone, or strict HH:mm (00:00 to 23:59) when daily=true.",
        }),
        daily: Type.Optional(Type.Boolean()),
        jobId: Type.Optional(Type.String({ description: "Job to cancel." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params): Promise<AgentToolResult<ScheduleToolDetails>> => {
      if (params.action === "create") {
        if (!params.prompt?.trim() || !params.at?.trim())
          return deniedResult("Schedule needs prompt and at.");
        const daily = params.daily === true;
        // 单一 try-catch 块执行预校验与 jobs.add，捕获 InvalidScheduleError
        // 并通过 details.denied = true 标记为受控业务拒绝，穿过 projectExecutionEvent 错误脱敏
        try {
          assertValidSchedule(daily, params.at.trim());
          const job = await jobs.add(params.prompt, daily, params.at, spaceId || "local-main");
          return {
            content: [
              {
                type: "text",
                text: `Scheduled (id ${job.id.slice(0, 8)}): "${job.prompt}" next at ${job.nextRunAt}${daily ? " (daily)" : ""}.`,
              },
            ],
            details: { id: job.id },
          };
        } catch (err) {
          if (err instanceof InvalidScheduleError) {
            return deniedResult(
              daily
                ? "Invalid daily time: must be strict HH:mm between 00:00 and 23:59 (no auto-overflow)."
                : "Invalid time: ISO 8601 with timezone required (e.g. 2026-10-29T09:00:00+08:00).",
            );
          }
          throw err;
        }
      }
      if (params.action === "cancel") {
        if (!params.jobId?.trim())
          return deniedResult("Cancel needs jobId (see list).");
        const ok = await jobs.cancel(params.jobId);
        return {
          content: [{ type: "text", text: ok ? "Cancelled." : "No such job." }],
          details: undefined,
        };
      }
      const list = await jobs.list();
      const lines = list.map(
        (x) =>
          `- ${x.id.slice(0, 8)} ${x.daily ? `daily ${x.at}` : x.at} enabled=${x.enabled} next=${x.nextRunAt}: ${x.prompt}`,
      );
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "No scheduled jobs." },
        ],
        details: undefined,
      };
    },
  });
