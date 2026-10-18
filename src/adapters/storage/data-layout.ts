import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeJsonDocument } from "./json-document.js";
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
  tasksFile: string;
  goalsFile: string;
  actionsFile: string;
  monitorsFile: string;
  soulFile: string;
  userFile: string;
  authKeyFile: string;
  skillsDir: string;
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
    skillsDir: join(root, "skills"),
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

/** 快照继承：将父会话的 skills.json 复制到子会话目录中；父会话无覆盖时不复制。 */
export const copyThreadSkills = async (layout: DataLayout, sourceThreadId: string, targetThreadId: string): Promise<void> => {
  const source = threadSkillsFile(layout, sourceThreadId);
  const target = threadSkillsFile(layout, targetThreadId);
  let content: string;
  try { content = await readFile(source, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const document = JSON.parse(content) as { overrides?: unknown };
  if (!document || typeof document !== "object" || !document.overrides || typeof document.overrides !== "object" ||
    Array.isArray(document.overrides) || Object.values(document.overrides).some((value) => typeof value !== "boolean"))
    throw new Error("Invalid skill overrides snapshot");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeJsonDocument(target, document);
};
