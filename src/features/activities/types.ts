export const ACTIVITY_ENTRY_TYPE = "pi-muse.activity";
export const activityStatuses = ["running", "waiting_approval", "waiting_user", "awaiting_continuation", "completed", "failed", "stopped", "interrupted"] as const;
export type ActivityStatus = typeof activityStatuses[number];
export type StepStatus = "running" | "succeeded" | "failed" | "denied" | "cancelled" | "expired" | "interrupted";
export type StepKind = "execution" | "model" | "tool" | "subagent" | "approval" | "file_commit";

export type ActivityOverview = {
  id: string;
  threadId: string;
  title: string;
  goal: string;
  deliverable: string;
  status: ActivityStatus;
  progress: string;
  result: string | null;
  runIds: string[];
  currentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};
export type ActivityStep = {
  id: string;
  runId: string;
  parentId: string | null;
  kind: StepKind;
  title: string;
  status: StepStatus;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
};
export type ActivityDetail = { activity: ActivityOverview; steps: ActivityStep[] };
export type ActivityEntry =
  | { kind: "overview"; activity: ActivityOverview }
  | { kind: "step"; activityId: string; step: ActivityStep };
export type ActivityHistory = {
  read: () => ActivityEntry[];
  append: (entry: ActivityEntry) => void;
};
export type ActivityObservation = {
  id: string;
  parentId?: string;
  kind: Exclude<StepKind, "execution">;
  phase: "start" | "end";
  title: string;
  status?: Exclude<StepStatus, "running">;
  result?: string;
};
export type ActivityOutcome = "completed" | "failed" | "stopped" | "interrupted";
export type ActivityRun = {
  /** 只读关联现有活动，不创建另一份活动状态或推断归属。 */
  getCurrentActivityId: () => string | undefined;
  start: (input: { title: string; goal: string; deliverable: string }) => ActivityOverview;
  resume: (id: string) => ActivityOverview;
  update: (progress: string) => ActivityOverview;
  wait: (question: string) => ActivityOverview;
  complete: (result: string) => ActivityOverview;
  observe: (event: ActivityObservation) => void;
  finish: (outcome: ActivityOutcome, delivered?: boolean) => void;
  close: () => void;
};

export class ActivityError extends Error {}
