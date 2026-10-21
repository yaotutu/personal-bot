import { Hono } from "hono";
import type { HttpDependencies } from "../bootstrap/types.js";
import { createSnapshotRoute } from "./routes/snapshot.js";
import { createJobsRoutes } from "./routes/jobs.js";
import { createGoalsRoutes } from "./routes/goals.js";
import { createMemoriesRoutes } from "./routes/memories.js";
import { createDreamRoutes } from "./routes/dream.js";
import { createIdentityRoutes } from "./routes/identity.js";
import { createMonitorsRoutes } from "./routes/monitors.js";
import { createApprovalsRoutes } from "./routes/approvals.js";
import { createActivitiesRoutes } from "./routes/activities.js";
import { createConversationRoutes } from "./routes/conversation.js";
import { createAgentStatusRoutes } from "./routes/agent-status.js";

/**
 * 自研 Web 业务端点的组合出口：每个域一个路由文件（routes/），
 * 各自声明最小依赖集合；这里只做挂载，不写业务逻辑。
 */
export const createWorkspaceRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  app.route("/", createAgentStatusRoutes(dependencies));
  app.route("/", createSnapshotRoute(dependencies));
  app.route("/", createJobsRoutes(dependencies));
  app.route("/", createGoalsRoutes(dependencies));
  app.route("/", createMemoriesRoutes(dependencies));
  app.route("/", createDreamRoutes(dependencies));
  app.route("/", createIdentityRoutes(dependencies));
  app.route("/", createMonitorsRoutes(dependencies));
  app.route("/", createApprovalsRoutes(dependencies));
  app.route("/", createActivitiesRoutes(dependencies));
  app.route("/", createConversationRoutes(dependencies));
  return app;
};
