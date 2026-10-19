import { Hono } from "hono";
import type { HttpDependencies } from "../bootstrap/types.js";
import { createSnapshotRoute } from "./routes/snapshot.js";
import { createTasksRoutes } from "./routes/tasks.js";
import { createGoalsRoutes } from "./routes/goals.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createMonitorsRoutes } from "./routes/monitors.js";
import { createApprovalsRoutes } from "./routes/approvals.js";
import { createActivitiesRoutes } from "./routes/activities.js";
import { createConversationRoutes } from "./routes/conversation.js";

/**
 * 自研 Web 业务端点的组合出口：每个域一个路由文件（routes/），
 * 各自声明最小依赖集合；这里只做挂载，不写业务逻辑。
 */
export const createWorkspaceRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  app.route("/", createSnapshotRoute(dependencies));
  app.route("/", createTasksRoutes(dependencies));
  app.route("/", createGoalsRoutes(dependencies));
  app.route("/", createMemoryRoutes(dependencies));
  app.route("/", createMonitorsRoutes(dependencies));
  app.route("/", createApprovalsRoutes(dependencies));
  app.route("/", createActivitiesRoutes(dependencies));
  app.route("/", createConversationRoutes(dependencies));
  return app;
};
