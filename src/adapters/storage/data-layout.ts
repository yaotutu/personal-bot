import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isThreadId } from "../../features/conversation/validate-input.js";

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
  goalsFile: string;
  actionsFile: string;
  monitorsFile: string;
  soulFile: string;
  userFile: string;
  dreamFile: string;
  authKeyFile: string;
  skillsDir: string;
  subagentsDir: string;
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
    goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"),
    monitorsFile: join(root, "monitors.json"),
    soulFile: join(root, "SOUL.md"),
    userFile: join(root, "USER.md"),
    dreamFile: join(root, "DREAM.md"),
    authKeyFile: join(root, "auth.key"),
    skillsDir: join(root, "skills"),
    subagentsDir: join(root, "subagents"),
  };
};

/** 单 owner 多会话：每个 thread 独占 sessions/<threadId>/ 下的 pi 会话树。 */
export const threadSessionsDir = (layout: DataLayout, threadId: string) =>
  join(layout.sessionsDir, threadId);

/** 每个会话的技能覆盖文件：sessions/<threadId>/skills.json */
export const threadSkillsFile = (layout: DataLayout, threadId: string) =>
  join(threadSessionsDir(layout, threadId), "skills.json");

/** 每个会话的专属指令文件：sessions/<threadId>/INSTRUCTIONS.md */
export const threadInstructionsFile = (layout: DataLayout, threadId: string) =>
  join(threadSessionsDir(layout, threadId), "INSTRUCTIONS.md");

/** 每个会话的 Dream 补充提示词：sessions/<threadId>/DREAM.md */
export const threadDreamPromptFile = (layout: DataLayout, threadId: string) =>
  join(threadSessionsDir(layout, threadId), "DREAM.md");

/** 每个会话的 Dream 状态文件：sessions/<threadId>/dream.json */
export const threadDreamFile = (layout: DataLayout, threadId: string) =>
  join(threadSessionsDir(layout, threadId), "dream.json");

/** workspace/ 与 threads/ 仅为容器；主会话、用户会话和内部任务没有父目录访问特权。 */
export const threadWorkspaceDir = (layout: DataLayout, threadId: string) => {
  if (!isThreadId(threadId)) throw new Error("Invalid threadId");
  return join(layout.workspaceDir, "threads", threadId);
};

/** 所有会话通过 shared/ 别名显式访问的共享目录，不在私有目录内建立链接。 */
export const sharedWorkspaceDir = (layout: DataLayout) =>
  join(layout.workspaceDir, "shared");

const ensureWorkspaceDirectory = async (directory: string) => {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe workspace directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
};

/** 只初始化新布局，不读取、搬移或删除原 workspace 根目录下的旧文件。 */
export const ensureThreadLayout = async (layout: DataLayout) => {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "threads"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(threadWorkspaceDir(layout, "local-main"));
};

/** 从容器到私有根逐级拒绝链接，避免初始化本身跟随链接替其他会话创建目录。 */
export const ensureThreadWorkspace = async (layout: DataLayout, threadId: string) => {
  const directory = threadWorkspaceDir(layout, threadId);
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "threads"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(directory);
};
