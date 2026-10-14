import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { TaskService } from "../../../features/tasks/task-service.js";
import type { TaskWorker } from "../../../features/tasks/task-worker.js";

/**
 * 对话式异步任务工具：把“帮我在后台做 X”交给 worker 在独立会话执行。
 * 与 schedule（定时）互补：delegate 是“现在就做，但别占着聊天”。
 * kick 让 worker 立即检查队列，不等下一个扫描周期（当前实现为事件驱动）。
 */
export const delegateTaskTool = (
  tasks: Pick<TaskService, "create" | "list" | "control">,
  worker: Pick<TaskWorker, "kick">,
) =>
  defineTool({
    name: "delegate_task",
    label: "Background tasks",
    description:
      "Delegate a self-contained job to run in the background now (separate session, tools available). " +
      "Use it when the user asks you to do work that should not block the chat (e.g. summarizing documents, research with several searches). " +
      "The result is posted back to this conversation and kept in the tasks page. " +
      "list shows tasks; cancel stops a queued or running one by taskId. Confirm briefly after creating.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("cancel"),
        ]),
        prompt: Type.String({
          description:
            "REQUIRED for every action (placeholder for list/cancel). For create: the complete, self-contained job instruction the background assistant should execute.",
        }),
        taskId: Type.Optional(
          Type.String({ description: "Task id for cancel (see list)." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "create") {
        const task = await tasks.create(params.prompt, "chat");
        worker.kick();
        return {
          content: [
            {
              type: "text",
              text: `Task created (id ${task.id.slice(0, 8)}): "${task.title}". It runs in the background; the result will be posted here and on the tasks page.`,
            },
          ],
          details: undefined,
        };
      }
      if (params.action === "cancel") {
        if (!params.taskId?.trim())
          return {
            content: [{ type: "text", text: "Cancel needs taskId (see list)." }],
            details: undefined,
            isError: true,
          };
        const result = await tasks.control(params.taskId, "cancel");
        return {
          content: [
            {
              type: "text",
              text: result.ok ? "Task cancelled." : result.message,
            },
          ],
          details: undefined,
          isError: !result.ok,
        };
      }
      const list = await tasks.list();
      const lines = list.map(
        (task) => `- ${task.id.slice(0, 8)} [${task.status}] ${task.title}`,
      );
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "No background tasks." },
        ],
        details: undefined,
      };
    },
  });
