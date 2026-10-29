import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApprovalCapacityError, type ActionService } from "../../../features/actions/action-service.js";
import type { ActivityObservation } from "../../../features/activities/types.js";
import type { WorkspaceCommitQueue } from "../../workspace/file-commit-queue.js";
import { createWorkspaceCommitQueue } from "../../workspace/file-commit-queue.js";

export const MAX_TEXT_FILE_BYTES = 100_000;
const POLL_INTERVAL_MS = 2_000;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ApprovalContext = {
  spaceId?: string;
  runId?: string;
  toolCallId?: string;
  subagentId?: string;
  workspaceSpaceId?: string | null;
  activityId?: (() => string | null) | string;
};
export type ApprovalActions = Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution">;
export type FileSnapshot = { content: string; version: string };
export type ActivityApprovalObservation = {
  observe: (event: ActivityObservation) => void;
  prefix: string;
  getActivityId?: () => string | undefined;
};

/** 独立工具测试使用隔离提交队列；生产组合层注入与手动 HTTP 共用的队列。 */
const fallbackCommits = createWorkspaceCommitQueue();

export const deniedResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { denied: true },
  isError: true,
});

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export const decodeStrictUtf8 = (bytes: Buffer) => strictUtf8.decode(bytes);

/** 内容摘要和 inode/纳秒时间戳共同绑定版本；同内容重建或改后复原也不能复用旧审批。 */
export const readFileSnapshot = async (
  target: string,
  maxBytes?: number,
): Promise<FileSnapshot | undefined> => {
  let file;
  try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Not a regular file");
    if (maxBytes !== undefined && before.size > maxBytes) throw new Error("File too large");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const metadata = (stat: typeof before) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const atPath = await lstat(target, { bigint: true });
    if (atPath.isSymbolicLink() || metadata(before) !== metadata(after) || metadata(after) !== metadata(atPath))
      throw new Error("File changed while reading");
    return {
      content: decodeStrictUtf8(bytes),
      version: `${metadata(after)}:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally { await file.close(); }
};

/**
 * abort 监听覆盖 submit/poll/休眠；中止发生在登记落盘期间也会补撤销 pending。
 * 只以服务端持久化的 expiresAt 过期，轮询不能延长授权。
 */
export const awaitFileApproval = async (
  actions: ApprovalActions,
  kind: "file_write" | "file_edit",
  title: string,
  payload: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  context?: ApprovalContext,
  observe?: (event: ActivityObservation) => void,
): Promise<{ id: string; expiresAt: number } | undefined> => {
  if (signal?.aborted) return undefined;
  let wakeAbort!: () => void;
  const interrupted = new Promise<undefined>((resolve) => { wakeAbort = () => resolve(undefined); });
  signal?.addEventListener("abort", wakeAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const action = await actions.submit(kind, title, payload, {
      ...context,
      timeoutMs,
      activityId: typeof context?.activityId === "function" ? context.activityId() : context?.activityId,
    });
    observe?.({
      id: `approval:${action.id}`,
      kind: "approval",
      phase: "start",
      title: "Approval requested",
    });
    for (;;) {
      if (signal?.aborted) {
        await actions.cancel(action.id);
        observe?.({ id: `approval:${action.id}`, kind: "approval", phase: "end", status: "cancelled", title: "Approval cancelled", result: "Operation aborted by user" });
        return undefined;
      }
      const decision = await Promise.race([actions.poll(action.id), interrupted]);
      if (signal?.aborted) {
        await actions.cancel(action.id);
        observe?.({ id: `approval:${action.id}`, kind: "approval", phase: "end", status: "cancelled", title: "Approval cancelled", result: "Operation aborted by user" });
        return undefined;
      }
      if (decision?.status === "approved") {
        observe?.({ id: `approval:${action.id}`, kind: "approval", phase: "end", status: "succeeded", title: "Approval granted", result: "Action was approved" });
        return { id: action.id, expiresAt: Date.parse(action.expiresAt) };
      }
      if (decision?.status !== "pending") {
        const status = decision?.status === "denied" ? "denied" : decision?.status === "expired" ? "expired" : "cancelled";
        observe?.({ id: `approval:${action.id}`, kind: "approval", phase: "end", status, title: `Approval ${decision?.status ?? "refused"}`, result: `Approval was ${decision?.status ?? "refused"}` });
        return undefined;
      }
      await Promise.race([
        new Promise<void>((resolve) => { timer = setTimeout(resolve, POLL_INTERVAL_MS); }),
        interrupted,
      ]);
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof ApprovalCapacityError) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", wakeAbort);
  }
};

export type CommitApprovedFileOptions = {
  target: string;
  /** 只用于成功文案，必须是逻辑路径，不能返回服务端绝对路径。 */
  successPath: string;
  original?: FileSnapshot;
  content: string;
  approval: { id: string; expiresAt: number };
  actions: ApprovalActions;
  signal?: AbortSignal;
  commitQueue?: WorkspaceCommitQueue;
  /** 提交前重查目标仍是登记时解析出的物理路径与版本。 */
  validateTarget?: (target: string) => Promise<boolean>;
  /** 文件提交后的收尾；文件与配置不是事务，失败保留 running 供人工核查。 */
  afterCommit?: (target: string) => Promise<void>;
};

/**
 * 在共享逐路径锁内重查版本；先写同目录临时文件，最后一次检查 signal/路径/版本才提交。
 * 不截断原文件；新建用 link 的排他语义防止覆盖刚出现的文件。
 */
export const commitApprovedFile = async ({
  target,
  successPath,
  original,
  content,
  approval,
  actions,
  signal,
  commitQueue = fallbackCommits,
  validateTarget,
  afterCommit,
}: CommitApprovedFileOptions) => commitQueue(target, async () => {
  if (!await actions.markExecuting(approval.id))
    return deniedResult("Approval cannot execute (expired or already used); nothing was written.");
  const unchanged = async () =>
    (!validateTarget || await validateTarget(target)) &&
    (await readFileSnapshot(target, MAX_TEXT_FILE_BYTES))?.version === original?.version;
  const expired = () => !Number.isFinite(approval.expiresAt) || Date.now() >= approval.expiresAt;
  let temporary: string | undefined;
  let committed = false;
  const refused = async (text: string, cancelled = false) => {
    await actions.finishExecution(approval.id, cancelled ? "cancelled" : "failed", text);
    return deniedResult(text);
  };
  try {
    if (signal?.aborted) return await refused("Operation aborted; nothing was written.", true);
    if (expired()) return await refused("Approval expired before commit; nothing was written.");
    if (!await unchanged()) return await refused("File changed since approval was requested; request a new approval.");
    if (signal?.aborted) return await refused("Operation aborted; nothing was written.", true);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (signal?.aborted) return await refused("Operation aborted; nothing was written.", true);
    if (!await unchanged()) return await refused("File changed since approval was requested; request a new approval.");
    temporary = join(dirname(target), `.approval-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      if (signal?.aborted) return await refused("Operation aborted; nothing was written.", true);
      await file.writeFile(content, "utf8");
    } finally { await file.close(); }
    if (!await unchanged()) return await refused("File changed since approval was requested; request a new approval.");
    if (signal?.aborted) return await refused("Operation aborted; nothing was written.", true);
    if (expired()) return await refused("Approval expired before commit; nothing was written.");
    if (original) await rename(temporary, target);
    else await link(temporary, target);
    committed = true;
    if (afterCommit) await afterCommit(target);
    if ((await readFileSnapshot(target, MAX_TEXT_FILE_BYTES))?.content !== content)
      throw new Error("Read-back mismatch");
    await actions.finishExecution(approval.id, "succeeded", "File committed after approval and version checks");
    return { content: [{ type: "text" as const, text: `Saved ${successPath}.` }], details: undefined };
  } catch {
    if (committed) return deniedResult("File was committed, but its execution receipt could not be saved. Verify the file before repeating.");
    return refused("File commit refused: the file changed, the path is unsafe, or writing failed.");
  } finally {
    if (temporary) await unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; });
  }
});
