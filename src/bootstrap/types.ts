import type { Config } from "../config/load-config.js";
import type { Conversation } from "../features/conversation/conversation-service.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { MemoryService } from "../features/memory/memory-service.js";
import type { IdentityService } from "../features/identity/identity-service.js";
import type { DataLayout } from "../adapters/storage/data-layout.js";
import type { Scheduler } from "../features/jobs/scheduler.js";
import type { createAuth } from "../adapters/auth/token-service.js";
import type { ToolPresentation } from "../adapters/ag-ui/tool-presentation.js";

type Auth = Awaited<ReturnType<typeof createAuth>>;

export type ServiceContainer = {
  config: Config;
  layout: DataLayout;
  auth: Auth;
  memory: MemoryService;
  identity: IdentityService;
  jobs: JobService;
  conversation: Conversation;
  scheduler: Scheduler;
  presentation: ToolPresentation;
};

export type HttpDependencies = Pick<
  ServiceContainer,
  "config" | "auth" | "memory" | "identity" | "jobs" | "conversation" | "presentation" | "scheduler"
>;
