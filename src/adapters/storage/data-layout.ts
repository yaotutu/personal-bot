import { join, resolve } from "node:path";

/**
 * 统一描述个人助手的数据文件布局。
 *
 * 业务代码通过这里读取当前布局，不在启动过程中隐式迁移文件。
 */
export type DataLayout = {
  root: string;
  workspaceDir: string;
  sessionsDir: string;
  agentDir: string;
  piAuthFile: string;
  memoryFile: string;
  jobsFile: string;
  tasksFile: string;
  goalsFile: string;
  actionsFile: string;
  monitorsFile: string;
  soulFile: string;
  userFile: string;
  authKeyFile: string;
};

export const createDataLayout = (dataDir: string): DataLayout => {
  const root = resolve(dataDir);
  return {
    root,
    workspaceDir: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    agentDir: join(root, "agent"),
    piAuthFile: join(root, "agent", "auth.json"),
    memoryFile: join(root, "memory.json"),
    jobsFile: join(root, "jobs.json"),
    tasksFile: join(root, "tasks.json"),
    goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"),
    monitorsFile: join(root, "monitors.json"),
    soulFile: join(root, "SOUL.md"),
    userFile: join(root, "USER.md"),
    authKeyFile: join(root, "auth.key"),
  };
};

/** 单 owner 多会话：每个 thread 独占 sessions/<threadId>/ 下的 pi 会话树。 */
export const threadSessionsDir = (layout: DataLayout, threadId: string) =>
  join(layout.sessionsDir, threadId);

/** 仅创建当前布局的会话根目录；启动时不探测或迁移任何旧会话文件。 */
export const ensureThreadLayout = async (layout: DataLayout) => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 });
};
