import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { JobService } from "../../../features/jobs/job-service.js";

// P4 对话式定时任务工具：模型把自然语言时间转成参数。一次性用 ISO 时间
// （含时区），每日用 HH:mm。崩了重跑哲学：调度器只是扫表 + 诚实状态。
export const scheduleTool = (jobs: Pick<JobService, "add" | "list" | "cancel">, threadId?: string) =>
  defineTool({
    name: "schedule",
    label: "Scheduled jobs",
    description:
      "Create, list, or cancel scheduled jobs that run later in this conversation. " +
      "Create: pass the user's request as prompt and the time as at — a one-time ISO 8601 timestamp with timezone (e.g. 2026-10-12T09:00:00+08:00) for reminders, or HH:mm with daily=true for recurring daily jobs. " +
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
            "REQUIRED for every action (use a placeholder for list/cancel). For create: ISO 8601 with timezone, or HH:mm when daily=true.",
        }),
        daily: Type.Optional(Type.Boolean()),
        jobId: Type.Optional(Type.String({ description: "Job to cancel." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "create") {
        if (!params.prompt?.trim() || !params.at?.trim())
          return {
            content: [{ type: "text", text: "Schedule needs prompt and at." }],
            details: undefined,
            isError: true,
          };
        const daily = params.daily === true;
        // 校验时间形状，坏输入给模型可纠正的提示而不是崩。
        const iso = daily ? null : new Date(params.at);
        if (daily ? !/^\d{1,2}:\d{2}$/.test(params.at) : isNaN(iso!.getTime()))
          return {
            content: [
              {
                type: "text",
                text: "Invalid time: use ISO 8601 with timezone, or HH:mm with daily=true.",
              },
            ],
            details: undefined,
            isError: true,
          };
        const job = await jobs.add(params.prompt, daily, params.at, threadId || "local-main");
        return {
          content: [
            {
              type: "text",
              text: `Scheduled (id ${job.id.slice(0, 8)}): "${job.prompt}" next at ${job.nextRunAt}${daily ? " (daily)" : ""}.`,
            },
          ],
          details: { id: job.id },
        };
      }
      if (params.action === "cancel") {
        if (!params.jobId?.trim())
          return {
            content: [{ type: "text", text: "Cancel needs jobId (see list)." }],
            details: undefined,
            isError: true,
          };
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
