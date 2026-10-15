import { join, resolve } from "node:path";

/**
 * 统一描述个人助手的数据文件布局。
 *
 * 第一版故意返回现有路径，不迁移任何用户数据；后续调整布局时只需要
 * 修改这里并增加显式迁移，不再让业务代码自己拼接 dataDir 路径。
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

/**
 * 一次性把旧布局（会话文件直接放在 sessions/ 根）迁入 sessions/local-main/。
 * 已是目录布局时幂等；迁移失败不阻塞启动（旧目录保留，错误向上抛）。
 */
export const ensureThreadLayout = async (layout: DataLayout) => {
  const { readdir, mkdir, rename, access } = await import("node:fs/promises");
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 });
  const legacy = await readdir(layout.sessionsDir, { withFileTypes: true });
  const files = legacy.filter((x) => x.isFile() && x.name.endsWith(".jsonl"));
  if (!files.length) return;
  const mainDir = threadSessionsDir(layout, "local-main");
  await mkdir(mainDir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const from = join(layout.sessionsDir, file.name);
    const to = join(mainDir, file.name);
    try {
      await access(to);
    } catch {
      await rename(from, to);
    }
  }
};
