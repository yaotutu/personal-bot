import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GoalService } from "../../../features/goals/goal-service.js";
import type { GoalStatus } from "../../../features/goals/types.js";

/**
 * 对话式目标工具：创建/列表/勾选里程碑/改状态。
 * 目标是用户的长期意图记录，不执行任何东西；模型据此回答规划类问题，
 * 执行靠定时/后台任务。里程碑标题由模型按用户意图拟定。
 */
export const goalTool = (goals: Pick<GoalService, "create" | "list" | "toggleMilestone" | "setStatus" | "get">) =>
  defineTool({
    name: "goal",
    label: "Goals & milestones",
    description:
      "Manage the user's long-term goals with milestones. " +
      "create: title, optional description/category, milestones as an array of short titles. " +
      "list: show all goals with progress. " +
      "check: toggle one milestone by goalId+milestoneId (from list). " +
      "status: set a goal to active/paused/completed/archived. " +
      "Use only on explicit user requests about their goals.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("check"),
          Type.Literal("status"),
        ]),
        title: Type.String({
          description:
            "REQUIRED for every action (placeholder for list/check/status). For create: the goal title.",
        }),
        description: Type.Optional(Type.String({ description: "Goal detail (create)." })),
        category: Type.Optional(Type.String({ description: "Short category like fitness/study." })),
        milestones: Type.Optional(
          Type.Array(Type.String(), { description: "Milestone titles (create)." }),
        ),
        goalId: Type.Optional(Type.String({ description: "Goal id for check/status." })),
        milestoneId: Type.Optional(Type.String({ description: "Milestone id for check." })),
        status: Type.Optional(
          Type.Union([
            Type.Literal("active"),
            Type.Literal("paused"),
            Type.Literal("completed"),
            Type.Literal("archived"),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      if (params.action === "create") {
        const goal = await goals.create({
          title: params.title,
          description: params.description,
          category: params.category,
          milestones: params.milestones,
        });
        return {
          content: [
            {
              type: "text",
              text: `Goal created (id ${goal.id.slice(0, 8)}): "${goal.title}" with ${goal.milestones.length} milestone(s).`,
            },
          ],
          details: undefined,
        };
      }
      if (params.action === "list") {
        const list = await goals.list();
        const lines = list.map((goal) => {
          const done = goal.milestones.filter((x) => x.done).length;
          const total = goal.milestones.length;
          return `- ${goal.id.slice(0, 8)} [${goal.status}] ${goal.title}${total ? ` (${done}/${total})` : ""}${goal.milestones.map((m) => `\n    ${m.done ? "x" : " "} ${m.id.slice(0, 8)} ${m.title}`).join("")}`;
        });
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "No goals yet." }],
          details: undefined,
        };
      }
      if (params.action === "check") {
        if (!params.goalId || !params.milestoneId)
          return {
            content: [{ type: "text", text: "check needs goalId and milestoneId (see list)." }],
            details: undefined,
            isError: true,
          };
        const result = await goals.toggleMilestone(params.goalId, params.milestoneId);
        if (!result.goal)
          return {
            content: [{ type: "text", text: "Goal or milestone not found." }],
            details: undefined,
            isError: true,
          };
        return {
          content: [
            {
              type: "text",
              text: `Milestone ${result.milestone?.done ? "done" : "reopened"} in "${result.goal.title}".`,
            },
          ],
          details: undefined,
        };
      }
      if (!params.goalId || !params.status)
        return {
          content: [{ type: "text", text: "status needs goalId and status." }],
          details: undefined,
          isError: true,
        };
      const goal = await goals.setStatus(params.goalId, params.status as GoalStatus);
      return {
        content: [
          { type: "text", text: goal ? `Goal "${goal.title}" is now ${goal.status}.` : "Goal not found." },
        ],
        details: undefined,
        isError: !goal,
      };
    },
  });
