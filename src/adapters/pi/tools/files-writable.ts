import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApprovalCapacityError, type ActionService } from "../../../features/actions/action-service.js";
import type { ActivityObservation } from "../../../features/activities/types.js";
import { resolveWorkspacePath, safeWorkspacePath } from "./workspace-path.js";

const MAX_BYTES = 100_000;
const POLL_INTERVAL_MS = 2_000;
type ApprovalContext = { threadId?: string; runId?: string; toolCallId?: string; subagentId?: string; workspaceThreadId?: string; activityId?: (() => string | null) | string };
type Actions = Pick<ActionService, "submit" | "poll" | "cancel">;
type Snapshot = { content: string; version: string };
export type ActivityToolObservation = { observe: (event: ActivityObservation) => void; prefix: string };

/** 同一物理 workspace 的不同工具工厂共用队列；审批等待不占锁，只有提交串行化。 */
const commits = new Map<string, Promise<void>>();
const serialCommit = async <T>(target: string, commit: () => Promise<T>): Promise<T> => {
  const previous = commits.get(target) ?? Promise.resolve();
  const result = previous.then(commit);
  const tail = result.then(() => undefined, () => undefined);
  commits.set(target, tail);
  try { return await result; }
  finally { if (commits.get(target) === tail) commits.delete(target); }
};

const denied = (text: string) => ({
  content: [{ type: "text" as const, text }], details: { denied: true }, isError: true,
});
const aborted = () => denied("Operation aborted; nothing was written.");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** 新文件可缺失，已有祖先和根目录仍逐段拒绝链接；审批后用同一规则重查。 */
const safeTarget = async (root: string, path: string, sharedDir?: string, boundaryDir?: string): Promise<string> => {
  if (!path.trim()) throw new Error("Unsafe path");
  const selected = resolveWorkspacePath(root, path, sharedDir);
  if (!selected || selected.path === selected.base) throw new Error("Unsafe path");
  return safeWorkspacePath(selected.base, selected.path, { allowMissing: true, boundaryDir });
};

/** 内容摘要和 inode/纳秒时间戳共同绑定版本：同内容重建或改后复原也不能复用旧审批。 */
const readSnapshot = async (target: string): Promise<Snapshot | undefined> => {
  let file;
  try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Not a regular file");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const metadata = (stat: typeof before) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const atPath = await lstat(target, { bigint: true });
    if (atPath.isSymbolicLink() || metadata(before) !== metadata(after) || metadata(after) !== metadata(atPath))
      throw new Error("File changed while reading");
    return {
      content: bytes.toString("utf8"),
      version: `${metadata(after)}:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally { await file.close(); }
};

/**
 * abort 监听覆盖 submit/poll/休眠：即使中止发生在登记落盘期间，也会补撤销刚登记的 pending。
 * 只以服务端持久化的 expiresAt 过期；poll 的旧 timeout 参数不能延长授权。
 */
const awaitApproval = async (
  actions: Actions, kind: "file_write" | "file_edit", title: string,
  payload: Record<string, string>, timeoutMs: number, signal?: AbortSignal, context?: ApprovalContext,
  observe?: (event: ActivityObservation) => void,
): Promise<number | undefined> => {
  if (signal?.aborted) return undefined;
  let wakeAbort!: () => void;
  const interrupted = new Promise<undefined>((resolve) => { wakeAbort = () => resolve(undefined); });
  signal?.addEventListener("abort", wakeAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const action = await actions.submit(kind, title, payload, {
      ...context, timeoutMs,
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
        observe?.({
          id: `approval:${action.id}`,
          kind: "approval",
          phase: "end",
          status: "cancelled",
          title: "Approval cancelled",
          result: "Operation aborted by user",
        });
        return undefined;
      }
      const decision = await Promise.race([actions.poll(action.id), interrupted]);
      if (signal?.aborted) {
        await actions.cancel(action.id);
        observe?.({
          id: `approval:${action.id}`,
          kind: "approval",
          phase: "end",
          status: "cancelled",
          title: "Approval cancelled",
          result: "Operation aborted by user",
        });
        return undefined;
      }
      if (decision?.status === "approved") {
        observe?.({
          id: `approval:${action.id}`,
          kind: "approval",
          phase: "end",
          status: "succeeded",
          title: "Approval granted",
          result: "Action was approved",
        });
        return Date.parse(action.expiresAt);
      }
      if (decision?.status !== "pending") {
        const status = decision?.status === "denied" ? "denied" : decision?.status === "expired" ? "expired" : "cancelled";
        observe?.({
          id: `approval:${action.id}`,
          kind: "approval",
          phase: "end",
          status,
          title: `Approval ${decision?.status ?? "refused"}`,
          result: `Approval was ${decision?.status ?? "refused"}`,
        });
        return undefined;
      }
      // 休眠可被 signal 立即唤醒，finally 清除计时器和监听器，不遗留轮询资源。
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

/**
 * 在共享逐路径锁内重查版本；先写同目录临时文件，最后一次检查 signal/路径/版本才提交。
 * 不截断原文件，避免写失败留下半份内容；新建用 link 的排他语义防止覆盖刚出现的文件。
 * 这是单进程工具间的并发保护，不声称提供针对外部恶意进程的操作系统级路径 CAS。
 */
const commitFile = async (
  root: string, path: string, target: string, original: Snapshot | undefined,
  content: string, expiresAt: number, signal?: AbortSignal, sharedDir?: string, boundaryDir?: string,
) => serialCommit(target, async () => {
  const unchanged = async () =>
    await safeTarget(root, path, sharedDir, boundaryDir) === target && (await readSnapshot(target))?.version === original?.version;
  const expired = () => !Number.isFinite(expiresAt) || Date.now() >= expiresAt;
  let temporary: string | undefined;
  try {
    if (signal?.aborted) return aborted();
    if (expired()) return denied("Approval expired before commit; nothing was written.");
    if (!await unchanged()) return denied("File changed since approval was requested; request a new approval.");
    if (signal?.aborted) return aborted();
    await mkdir(dirname(target), { recursive: true });
    if (await safeTarget(root, path, sharedDir, boundaryDir) !== target) return denied("Access denied: unsafe file path.");
    if (signal?.aborted) return aborted();
    temporary = join(dirname(target), `.approval-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      if (signal?.aborted) return aborted();
      await file.writeFile(content, "utf8");
    } finally { await file.close(); }
    if (!await unchanged()) return denied("File changed since approval was requested; request a new approval.");
    if (signal?.aborted) return aborted();
    if (expired()) return denied("Approval expired before commit; nothing was written.");
    if (original) await rename(temporary, target);
    else await link(temporary, target);
    return { content: [{ type: "text" as const, text: `Saved ${path}.` }], details: undefined };
  } catch {
    // 文件路径和底层 I/O 细节不透给模型；冲突、链接逃逸和写失败一律不自动重试。
    return denied("File commit refused: the file changed, the path is unsafe, or writing failed.");
  } finally {
    if (temporary) await unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; });
  }
});

/** 每次 run 由组合方传入新的上下文；此工厂不推断或缓存当前 runId。 */
export const createWritableFileTools = (
  root: string, actions: Actions, timeoutMs: number, context?: ApprovalContext, sharedDir?: string, boundaryDir?: string,
  observation?: ActivityToolObservation,
) => [
  defineTool({
    name: "write", label: "Write file",
    description: "Create or overwrite a text file inside the documents directory. Every write requires explicit user approval. Relative paths only, no symlinks or ..; max 100KB. Concurrent changes require new approval.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the documents directory (or shared/... for global shared files)." }),
      content: Type.String({ description: "Full file content to write." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) return aborted();
      if (Buffer.byteLength(params.content, "utf8") > MAX_BYTES)
        return denied("File too large: writes are limited to 100KB.");
      let target: string;
      let original: Snapshot | undefined;
      try { target = await safeTarget(root, params.path, sharedDir, boundaryDir); original = await readSnapshot(target); }
      catch { return denied("Access denied: unsafe or unreadable file path."); }
      // 保存完整原文和新内容供 UI 比较，不再用截断 preview 隐藏真正的写入内容。
      const approved = await awaitApproval(actions, "file_write", `写入 ${params.path}`, {
        path: params.path, content: params.content, originalContent: original?.content ?? "",
        baseVersion: original?.version ?? "missing", beforeExists: String(original !== undefined),
      }, timeoutMs, signal, { ...context, toolCallId: _id }, observation ? (event) => observation.observe({
        ...event, id: `${observation.prefix}:${event.id}`, parentId: `${observation.prefix}:tool:${_id}`,
      }) : undefined);
      if (approved === undefined) return denied("Write not approved (denied, expired or cancelled); nothing was written.");
      return commitFile(root, params.path, target, original, params.content, approved, signal, sharedDir, boundaryDir);
    },
  }),
  defineTool({
    name: "edit", label: "Edit file",
    description: "Replace one exact nonempty text occurrence in an existing file. Requires explicit user approval; oldText must appear exactly once; resulting file max 100KB. Concurrent changes require new approval.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the documents directory (or shared/... for global shared files)." }),
      oldText: Type.String({ minLength: 1, description: "Nonempty exact existing text to replace." }),
      newText: Type.String({ description: "Replacement text." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) return aborted();
      if (!params.oldText.length) return denied("oldText must not be empty.");
      let target: string;
      let original: Snapshot | undefined;
      try { target = await safeTarget(root, params.path, sharedDir, boundaryDir); original = await readSnapshot(target); }
      catch { return denied("Access denied: unsafe or unreadable file path."); }
      if (!original) return denied("File not found.");
      const first = original.content.indexOf(params.oldText);
      if (first < 0) return denied("oldText not found in the file.");
      // 从下一字符查找也能识别重叠命中，防止有歧义的替换通过唯一性检查。
      if (original.content.indexOf(params.oldText, first + 1) >= 0)
        return denied("oldText appears more than once; make it unique first.");
      // 按索引拼接而非 replace 字符串模板，保证 $&/$`/$' 等也是字面内容。
      const content = original.content.slice(0, first) + params.newText + original.content.slice(first + params.oldText.length);
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES)
        return denied("File too large: edited files are limited to 100KB.");
      const approved = await awaitApproval(actions, "file_edit", `编辑 ${params.path}`, {
        path: params.path, oldText: params.oldText, newText: params.newText,
        originalContent: original.content, content, baseVersion: original.version, beforeExists: "true",
      }, timeoutMs, signal, { ...context, toolCallId: _id }, observation ? (event) => observation.observe({
        ...event, id: `${observation.prefix}:${event.id}`, parentId: `${observation.prefix}:tool:${_id}`,
      }) : undefined);
      if (approved === undefined) return denied("Edit not approved (denied, expired or cancelled); nothing was written.");
      return commitFile(root, params.path, target, original, content, approved, signal, sharedDir, boundaryDir);
    },
  }),
];
