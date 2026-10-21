import { randomUUID } from "node:crypto";
import { ActivityError, type ActivityDetail, type ActivityEntry, type ActivityHistory, type ActivityObservation, type ActivityOverview, type ActivityRun, type StepStatus } from "./types.js";

/** 活动 custom entry 只保存业务投影；不复制聊天文本、模型思维或原始工具载荷。 */
export const projectActivities = (entries: readonly ActivityEntry[], isRunning: (runId: string) => boolean = () => false): ActivityDetail[] => {
  const records = new Map<string, ActivityDetail>();
  for (const entry of entries) {
    if (entry.kind === "overview") {
      const previous = records.get(entry.activity.id);
      records.set(entry.activity.id, { activity: structuredClone(entry.activity), steps: previous?.steps ?? [] });
    } else {
      const record = records.get(entry.activityId);
      if (!record) throw new ActivityError("Activity step has no activity");
      const index = record.steps.findIndex((step) => step.id === entry.step.id);
      if (index < 0) record.steps.push(structuredClone(entry.step));
      else record.steps[index] = structuredClone(entry.step);
    }
  }
  return [...records.values()].map((record) => {
    const { activity } = record;
    if (activity.currentRunId && !isRunning(activity.currentRunId)) {
      activity.status = "interrupted";
      activity.currentRunId = null;
      activity.progress = "Execution was interrupted; ask the agent to continue explicitly.";
    }
    // 每一步按自身 run 归属判断，不能在 resume 绑定新 run 后把旧崩溃步骤投回 running。
    // 崩溃时没有可信结束时刻，保留 finishedAt=null，不用读取时间伪造完成时间。
    for (const step of record.steps) if (step.status === "running" && !isRunning(step.runId)) {
      step.status = "interrupted";
      step.result = "Execution interrupted; no completion was recorded.";
    }
    return record;
  });
};

export const createActivitySession = (spaceId: string, history: ActivityHistory) => {
  const activeRuns = new Set<string>();
  const details = () => projectActivities(history.read(), (id) => activeRuns.has(id));
  return {
    details,
    beginRun: (runId: string): ActivityRun => {
      activeRuns.add(runId);
      let boundId: string | undefined;
      let completion: string | undefined;
      let waiting: string | undefined;
      let closed = false;
      const writable = () => { if (closed) throw new ActivityError("Activity execution has ended"); };
      const record = (): ActivityDetail => {
        writable();
        const found = details().find((detail) => detail.activity.id === boundId);
        if (!found) throw new ActivityError("Start or resume an activity first");
        return found;
      };
      const save = (activity: ActivityOverview) => {
        history.append({ kind: "overview", activity: { ...activity, updatedAt: new Date().toISOString() } });
        return activity;
      };
      const step = (event: ActivityObservation) => {
        if (!boundId || closed) return;
        const current = record();
        const id = `${runId}:${event.id}`;
        const previous = current.steps.find((step) => step.id === id);
        const now = new Date().toISOString();
        history.append({ kind: "step", activityId: boundId, step: {
          id, runId, parentId: event.parentId ? `${runId}:${event.parentId}` : `${runId}:execution`,
          kind: event.kind, title: event.title, status: event.phase === "start" ? "running" : event.status ?? "succeeded",
          startedAt: previous?.startedAt ?? now, finishedAt: event.phase === "end" ? now : null, result: event.result ?? null,
        } });
        if (event.phase === "start" && event.kind !== "model") { completion = undefined; waiting = undefined; }
        const pendingApproval = record().steps.some((step) => step.kind === "approval" && step.status === "running");
        save({ ...current.activity, status: pendingApproval ? "waiting_approval" : "running", progress: event.title });
      };
      const bind = (activity: ActivityOverview) => {
        boundId = activity.id;
        completion = undefined;
        waiting = undefined;
        const now = new Date().toISOString();
        const next = save({ ...activity, status: "running", currentRunId: runId, runIds: [...new Set([...activity.runIds, runId])], result: null, finishedAt: null });
        history.append({ kind: "step", activityId: activity.id, step: {
          id: `${runId}:execution`, runId, parentId: null, kind: "execution", title: "Work execution", status: "running",
          startedAt: now, finishedAt: null, result: null,
        } });
        return next;
      };
      return {
        getCurrentActivityId: () => boundId,
        start: (input) => {
          writable();
          if (boundId) return record().activity;
          const now = new Date().toISOString();
          return bind({ id: randomUUID(), spaceId, ...input, status: "running", progress: "Work started", result: null, runIds: [], currentRunId: null, createdAt: now, updatedAt: now, finishedAt: null });
        },
        resume: (id) => {
          writable();
          if (boundId) {
            if (id !== boundId) throw new ActivityError("One activity per execution");
            return record().activity;
          }
          const existing = details().find((detail) => detail.activity.id === id)?.activity;
          const target = existing ? existing.spaceId : undefined;
          if (!existing || target !== spaceId) throw new ActivityError("Activity not found in this conversation");
          if (existing.status === "completed" || existing.currentRunId) throw new ActivityError("Activity cannot be resumed in its current state");
          return bind(existing);
        },
        update: (progress) => { const current = record(); return save({ ...current.activity, progress }); },
        wait: (question) => {
          waiting = question;
          completion = undefined;
          const current = record();
          return save({ ...current.activity, status: "waiting_user", progress: question });
        },
        complete: (result) => {
          const current = record();
          const unfinished = current.steps.some((step) => step.status === "running" && step.kind !== "execution" && step.kind !== "model");
          if (unfinished) throw new ActivityError("Wait for tools, subagents and approvals to finish before completing");
          completion = result;
          waiting = undefined;
          return save({ ...current.activity, progress: "Completion declared; waiting for final delivery" });
        },
        observe: step,
        finish: (outcome, delivered = false) => {
          if (!boundId || closed) return undefined;
          const current = record();
          const now = new Date().toISOString();
          for (const existing of current.steps.filter((step) => step.runId === runId && step.status === "running")) {
            const status: StepStatus = outcome === "completed" ? "succeeded" : outcome === "stopped" ? "cancelled" : outcome === "interrupted" ? "interrupted" : "failed";
            history.append({ kind: "step", activityId: boundId, step: { ...existing, status, finishedAt: now, result: existing.result ?? `Execution ${outcome}` } });
          }
          const complete = outcome === "completed" && completion !== undefined && delivered;
          const status = outcome === "completed" ? complete ? "completed" : waiting ? "waiting_user" : "awaiting_continuation" : outcome;
          return save({ ...current.activity, status, currentRunId: null, result: complete ? completion! : null,
            progress: complete ? "Work completed" : outcome === "completed" ? waiting ?? "Waiting for explicit continuation" : `Execution ${outcome}`,
            finishedAt: ["completed", "failed", "stopped", "interrupted"].includes(status) ? now : null });
        },
        close: () => { closed = true; activeRuns.delete(runId); },
      };
    },
  };
};
export type ActivitySession = ReturnType<typeof createActivitySession>;
