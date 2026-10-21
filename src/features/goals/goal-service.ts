import { randomUUID } from "node:crypto";
import type { Goal, GoalRepository, GoalStatus } from "./types.js";

/** 目标业务入口：CRUD、里程碑勾选与状态迁移；不调度、不执行。 */
export const createGoalService = (repository: GoalRepository) => {
  const now = () => new Date().toISOString();
  return {
    list: (): Promise<Goal[]> => repository.read(),
    get: async (id: string): Promise<Goal | undefined> =>
      (await repository.read()).find((goal) => goal.id === id),
    create: (
      input: { title: string; description?: string; category?: string; milestones?: string[] },
    ): Promise<Goal> =>
      repository.update((items) => {
        const goal: Goal = {
          id: randomUUID(),
          title: input.title.trim().slice(0, 160),
          description: (input.description ?? "").trim().slice(0, 2000),
          category: (input.category ?? "general").trim().slice(0, 40) || "general",
          status: "active",
          milestones: (input.milestones ?? []).map((title) => ({
            id: randomUUID(),
            title: title.trim().slice(0, 160),
            done: false,
          })),
          createdAt: now(),
          updatedAt: now(),
        };
        items.push(goal);
        return { items, result: goal };
      }),
    edit: async (
      id: string,
      patch: { title?: string; description?: string; category?: string; status?: GoalStatus },
    ): Promise<Goal | undefined> =>
      repository.update((items) => {
        const goal = items.find((x) => x.id === id);
        if (!goal) return { result: undefined };
        if (patch.title !== undefined) goal.title = patch.title.trim().slice(0, 160);
        if (patch.description !== undefined)
          goal.description = patch.description.trim().slice(0, 2000);
        if (patch.category !== undefined)
          goal.category = patch.category.trim().slice(0, 40) || "general";
        if (patch.status !== undefined) {
          goal.status = patch.status;
          if (patch.status === "completed") {
            for (const milestone of goal.milestones) {
              if (!milestone.done) {
                milestone.done = true;
                milestone.doneAt = now();
              }
            }
          }
        }
        goal.updatedAt = now();
        return { items, result: goal };
      }),
    /** 状态迁移：completed 自动勾掉全部里程碑；重新激活不回退勾选（诚实保留历史）。 */
    setStatus: async (id: string, status: GoalStatus): Promise<Goal | undefined> =>
      repository.update((items) => {
        const goal = items.find((x) => x.id === id);
        if (!goal) return { result: undefined };
        goal.status = status;
        if (status === "completed")
          for (const milestone of goal.milestones)
            if (!milestone.done) {
              milestone.done = true;
              milestone.doneAt = now();
            }
        goal.updatedAt = now();
        return { items, result: goal };
      }),
    /** 勾选/取消里程碑；全部勾选不自动完成目标（完成是用户的显式决定）。 */
    toggleMilestone: async (
      goalId: string,
      milestoneId: string,
    ): Promise<{ goal?: Goal; milestone?: { done: boolean } }> =>
      repository.update(
        (items): { items?: Goal[]; result: { goal?: Goal; milestone?: { done: boolean } } } => {
        const goal = items.find((x) => x.id === goalId);
        const milestone = goal?.milestones.find((x) => x.id === milestoneId);
        if (!goal || !milestone) return { result: {} };
        milestone.done = !milestone.done;
        milestone.doneAt = milestone.done ? now() : undefined;
        goal.updatedAt = now();
        return { items, result: { goal, milestone: { done: milestone.done } } };
        },
      ),
    remove: (id: string): Promise<boolean> =>
      repository.update((items) => {
        const before = items.length;
        const next = items.filter((x) => x.id !== id);
        if (next.length === before) return { result: false };
        return { items: next, result: true };
      }),
  };
};

export type GoalService = ReturnType<typeof createGoalService>;
