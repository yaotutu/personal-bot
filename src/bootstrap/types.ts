import type { Config } from "../config/load-config.js";
import type { ConversationHub } from "../features/conversation/conversation-hub.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { MemoryService } from "../features/memory/memory-service.js";
import type { IdentityService } from "../features/identity/identity-service.js";
import type { DataLayout } from "../adapters/storage/data-layout.js";
import type { Scheduler } from "../features/jobs/scheduler.js";
import type { GoalService } from "../features/goals/goal-service.js";
import type { ActionService } from "../features/actions/action-service.js";
import type { MonitorService } from "../features/monitors/monitor-service.js";
import type { MonitorScheduler } from "../features/monitors/monitor-scheduler.js";
import type { SkillsService } from "../features/skills/service.js";
import type { createAuth } from "../adapters/auth/token-service.js";
import type { ToolPresentation } from "../adapters/ag-ui/tool-presentation.js";
import type { WorkspaceEvents } from "../features/workspace/workspace-events.js";
import type { ActivityService } from "../features/activities/service.js";
import type { DreamService } from "../features/dream/service.js";
import type { DreamScheduler } from "../features/dream/scheduler.js";

type Auth = Awaited<ReturnType<typeof createAuth>>;

export type ServiceContainer = {
  lifecycle?: { isClosing: () => boolean; enter: () => () => void };
  config: Config;
  layout: DataLayout;
  auth: Auth;
  memory: MemoryService;
  identity: IdentityService;
  jobs: JobService;
  conversationHub: ConversationHub;
  scheduler: Scheduler;
  goals: GoalService;
  actions: ActionService;
  monitors: MonitorService;
  monitorScheduler: MonitorScheduler;
  skills: SkillsService;
  presentation: ToolPresentation;
  workspaceEvents: WorkspaceEvents;
  activities: ActivityService;
  dream: DreamService;
  dreamScheduler: DreamScheduler;
};

export type HttpDependencies = Pick<
  ServiceContainer,
  "lifecycle" | "config" | "layout" | "auth" | "memory" | "identity" | "jobs" | "goals" | "actions" | "monitors" | "conversationHub" | "presentation" | "scheduler" | "skills" | "workspaceEvents" | "activities" | "dream"
>;
