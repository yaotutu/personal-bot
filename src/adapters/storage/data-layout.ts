import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSpaceId } from "../../features/conversation/space-id.js";

/**
 * 统一描述个人助手的数据文件布局。
 *
 * 业务代码通过这里读取当前布局，不在启动过程中隐式迁移文件。
 */
export type DataLayout = {
  root: string;
  profileDir: string;
  workspaceDir: string;
  sessionsDir: string;
  messageFeedbackDir: string;
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
  browserProfileDir: string;
  skillsDir: string;
  subagentsDir: string;
};

export const createDataLayout = (dataDir: string): DataLayout => {
  const root = resolve(dataDir);
  const profileDir = join(root, "profile");
  return {
    root,
    profileDir,
    workspaceDir: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    messageFeedbackDir: join(root, "messages"),
    agentDir: join(root, "agent"),
    piAuthFile: join(root, "agent", "auth.json"),
    memoryFile: join(profileDir, "memory.json"),
    jobsFile: join(root, "jobs.json"),
    goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"),
    monitorsFile: join(root, "monitors.json"),
    soulFile: join(profileDir, "SOUL.md"),
    userFile: join(profileDir, "USER.md"),
    dreamFile: join(profileDir, "DREAM.md"),
    authKeyFile: join(root, "auth.key"),
    browserProfileDir: join(root, "browser", "profile"),
    skillsDir: join(root, "skills"),
    subagentsDir: join(root, "subagents"),
  };
};

/** 单 owner 多会话：每个 thread 独占 sessions/<threadId>/ 下的 pi 会话树。 */
export const spaceSessionsDir = (layout: DataLayout, spaceId: string) =>
  join(layout.sessionsDir, spaceId);
export const threadSessionsDir = spaceSessionsDir;

/** 反馈按空间和 PI session 双重隔离；reset 后旧 session 文件不再可寻址。 */
export const messageFeedbackFile = (layout: DataLayout, spaceId: string, sessionId: string): string => {
  if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId / Invalid threadId");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid sessionId");
  return join(layout.messageFeedbackDir, spaceId, `${sessionId}.json`);
};

/** 每个会话的技能覆盖文件：sessions/<threadId>/skills.json */
export const spaceSkillsFile = (layout: DataLayout, spaceId: string) =>
  join(spaceSessionsDir(layout, spaceId), "skills.json");
export const threadSkillsFile = spaceSkillsFile;

/** 每个会话的专属指令文件：sessions/<threadId>/INSTRUCTIONS.md */
export const spaceInstructionsFile = (layout: DataLayout, spaceId: string) =>
  join(spaceSessionsDir(layout, spaceId), "INSTRUCTIONS.md");
export const threadInstructionsFile = spaceInstructionsFile;

/** 每个会话的 Dream 补充提示词：sessions/<threadId>/DREAM.md */
export const spaceDreamPromptFile = (layout: DataLayout, spaceId: string) =>
  join(spaceSessionsDir(layout, spaceId), "DREAM.md");
export const threadDreamPromptFile = spaceDreamPromptFile;

/** 每个会话的 Dream 状态文件：sessions/<threadId>/dream.json */
export const spaceDreamFile = (layout: DataLayout, spaceId: string) =>
  join(spaceSessionsDir(layout, spaceId), "dream.json");
export const threadDreamFile = spaceDreamFile;

/** workspace/ 与 threads/ 仅为容器；空间与内部任务没有父目录访问特权。 */
export const spaceWorkspaceDir = (layout: DataLayout, spaceId: string) => {
  if (!isSpaceId(spaceId)) throw new Error("Invalid spaceId / Invalid threadId");
  return join(layout.workspaceDir, "threads", spaceId);
};
export const threadWorkspaceDir = spaceWorkspaceDir;

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
export const ensureSpaceLayout = async (layout: DataLayout) => {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await mkdir(layout.profileDir, { recursive: true, mode: 0o700 });
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "threads"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(spaceWorkspaceDir(layout, "local-main"));
};
export const ensureThreadLayout = ensureSpaceLayout;

/** 从容器到私有根逐级拒绝链接，避免初始化本身跟随链接替其他空间创建目录。 */
export const ensureSpaceWorkspace = async (layout: DataLayout, spaceId: string) => {
  const directory = spaceWorkspaceDir(layout, spaceId);
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "threads"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(directory);
};
export const ensureThreadWorkspace = ensureSpaceWorkspace;
