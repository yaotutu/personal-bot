import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  ensureSpaceWorkspace,
  ensureThreadLayout,
  sharedWorkspaceDir,
  spaceWorkspaceDir,
  type DataLayout,
} from "../storage/data-layout.js";
import { safeWorkspacePath, UnsafeFilePathError } from "../pi/tools/workspace-path.js";
import {
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  WorkspaceFileError,
  type WorkspaceFileDetail,
  type WorkspaceFileSelector,
  type WorkspaceListEntry,
  type WorkspaceTextDetail,
} from "../../features/workspace/files-service.js";
import type { WorkspaceCommitQueue } from "./file-commit-queue.js";

const invalid = () => new WorkspaceFileError(400, "INVALID_REQUEST", "Unsafe workspace path");
const missing = () => new WorkspaceFileError(404, "NOT_FOUND", "File not found");
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

const rootOf = (layout: DataLayout, selector: WorkspaceFileSelector) =>
  selector.scope === "space"
    ? spaceWorkspaceDir(layout, selector.spaceId!)
    : sharedWorkspaceDir(layout);

const targetOf = (root: string, path: string) =>
  path === "." ? root : join(root, ...path.split("/"));

/** safeWorkspacePath 返回物理规范路径；提交前用同一锚点创建缺失父目录。 */
const physicalRootOf = (target: string, path: string) => {
  let current = target;
  const depth = path === "." ? 0 : path.split("/").length;
  for (let index = 0; index < depth; index++) current = dirname(current);
  return current;
};

const imageTypeOf = (bytes: Uint8Array): string | undefined => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  let gif = "";
  for (let index = 0; index < 6; index++) gif += String.fromCharCode(bytes[index] ?? 0);
  if (bytes.length >= 6 && (gif === "GIF87a" || gif === "GIF89a"))
    return "image/gif";
  let riff = "";
  let webp = "";
  for (let index = 0; index < 4; index++) riff += String.fromCharCode(bytes[index] ?? 0);
  for (let index = 8; index < 12; index++) webp += String.fromCharCode(bytes[index] ?? 0);
  if (bytes.length >= 12 && riff === "RIFF" && webp === "WEBP")
    return "image/webp";
  return undefined;
};

const isText = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const metadataOf = (path: string, bytes: Buffer, mtimeMs: number): WorkspaceFileDetail => {
  const imageType = imageTypeOf(bytes);
  const kind = imageType ? "image" : isText(bytes) ? "text" : "binary";
  const common = {
    name: basename(path),
    path,
    size: bytes.length,
    updatedAt: new Date(mtimeMs).toISOString(),
  };
  if (kind === "text") {
    return {
      ...common,
      kind,
      mimeType: "text/plain; charset=utf-8",
      // ignoreBOM=true 让 U+FEFF 留在字符串中，完整下载/保存回读不改变原始字节。
      content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    };
  }
  return {
    ...common,
    kind,
    mimeType: imageType ?? "application/octet-stream",
    dataBase64: bytes.toString("base64"),
  };
};

const openRegularFile = async (target: string) => {
  // FIFO 等特殊文件也必须在 open 阶段非阻塞，随后由 fstat 拒绝；不能等待写入端。
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw invalid();
    if (before.size > MAX_WORKSPACE_DOWNLOAD_BYTES)
      throw new WorkspaceFileError(413, "TOO_LARGE", "File exceeds 8388608 bytes");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (!after.isFile() || bytes.length !== after.size || after.size > MAX_WORKSPACE_DOWNLOAD_BYTES)
      throw new WorkspaceFileError(413, "TOO_LARGE", "File changed and exceeds the download limit");
    return { bytes, mtimeMs: after.mtimeMs };
  } finally {
    await file.close();
  }
};

/** 父目录逐段检查/创建，绝不先 recursive mkdir 再补验符号链接。 */
const ensureParent = async (root: string, target: string) => {
  const components = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid();
    } catch (error) {
      if ((error as WorkspaceFileError).status === 400) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 }).catch(async (mkdirError: unknown) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const entry = await lstat(current);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid();
      });
    }
  }
};

const checkedTarget = async (
  layout: DataLayout,
  selector: WorkspaceFileSelector,
  options: { createDirectories?: boolean } = {},
) => {
  const root = rootOf(layout, selector);
  if (options.createDirectories) {
    if (selector.scope === "space") await ensureSpaceWorkspace(layout, selector.spaceId!);
    else await ensureThreadLayout(layout);
  }
  const lexical = targetOf(root, selector.path);
  try {
    return await safeWorkspacePath(root, lexical, {
      allowMissing: options.createDirectories === true,
      boundaryDir: layout.workspaceDir,
    });
  } catch (error) {
    if (error instanceof UnsafeFilePathError) throw invalid();
    if (isMissing(error)) throw missing();
    throw error;
  }
};

const writeTemporary = async (target: string, content: string) => {
  const temporary = join(dirname(target), `.manual-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
  return temporary;
};

/**
 * HTTP 手动文件适配器。读操作不创建目录；写操作在确认空间已存在后只创建
 * 工作区内部目录。所有错误使用受控文案，不透出服务端绝对路径或 fs 诊断。
 */
export const createWorkspaceFileStore = (layout: DataLayout, commitQueue: WorkspaceCommitQueue) => {
  const readDetail = async (selector: WorkspaceFileSelector): Promise<WorkspaceFileDetail> => {
    const target = await checkedTarget(layout, selector);
    const opened = await openRegularFile(target);
    return metadataOf(selector.path, opened.bytes, opened.mtimeMs);
  };

  return {
    async list(selector: WorkspaceFileSelector): Promise<WorkspaceListEntry[]> {
      let directory: string;
      try {
        directory = await checkedTarget(layout, selector);
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.status === 404 && selector.path === ".") return [];
        throw error;
      }
      let names;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isMissing(error)) throw missing();
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
          throw new WorkspaceFileError(400, "INVALID_REQUEST", "Workspace path is not a directory");
        throw error;
      }
      if (names.length > MAX_WORKSPACE_DIRECTORY_ENTRIES)
        throw new WorkspaceFileError(413, "TOO_LARGE", "Directory exceeds 1000 entries");
      const entries: WorkspaceListEntry[] = [];
      for (const name of names) {
        try {
          const stats = await lstat(join(directory, name));
          if (stats.isSymbolicLink() || !(stats.isFile() || stats.isDirectory())) continue;
          entries.push({
            name,
            path: selector.path === "." ? name : `${selector.path}/${name}`,
            kind: stats.isDirectory() ? "directory" : "file",
            size: stats.isDirectory() ? 0 : stats.size,
            updatedAt: new Date(stats.mtimeMs).toISOString(),
          });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return entries.sort((a, b) =>
        a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "directory" ? -1 : 1
      );
    },
    async read(selector: WorkspaceFileSelector): Promise<WorkspaceFileDetail> {
      return readDetail(selector);
    },
    async create(selector: WorkspaceFileSelector, content: string): Promise<WorkspaceTextDetail> {
      const target = await checkedTarget(layout, selector, { createDirectories: true });
      return commitQueue(target, async () => {
        let temporary: string | undefined;
        try {
          await ensureParent(physicalRootOf(target, selector.path), target);
          if (await checkedTarget(layout, selector, { createDirectories: true }) !== target)
            throw invalid();
          const existing = await lstat(target).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
          });
          if (existing) throw new WorkspaceFileError(409, "CONFLICT", "File already exists");
          temporary = await writeTemporary(target, content);
          await link(temporary, target);
          const detail = await readDetail(selector);
          if (detail.kind !== "text") throw invalid();
          return detail;
        } catch (error) {
          if (error instanceof WorkspaceFileError) throw error;
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new WorkspaceFileError(409, "CONFLICT", "File already exists");
          if (isMissing(error)) throw missing();
          throw invalid();
        } finally {
          if (temporary) await unlink(temporary).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
        }
      });
    },
    async update(selector: WorkspaceFileSelector, content: string): Promise<WorkspaceTextDetail> {
      const target = await checkedTarget(layout, selector, { createDirectories: true });
      return commitQueue(target, async () => {
        let temporary: string | undefined;
        let committed = false;
        try {
          await ensureParent(physicalRootOf(target, selector.path), target);
          if (await checkedTarget(layout, selector, { createDirectories: true }) !== target)
            throw invalid();
          const existing = await lstat(target).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
          });
          if (!existing) throw missing();
          if (!existing.isFile() || existing.isSymbolicLink()) throw invalid();
          const current = await readDetail(selector);
          if (current.kind !== "text")
            throw new WorkspaceFileError(400, "INVALID_REQUEST", "Only text files can be updated");
          temporary = await writeTemporary(target, content);
          await rename(temporary, target);
          committed = true;
          const detail = await readDetail(selector);
          if (detail.kind !== "text") throw invalid();
          return detail;
        } catch (error) {
          if (error instanceof WorkspaceFileError) throw error;
          if (isMissing(error)) throw missing();
          if (committed)
            throw new WorkspaceFileError(409, "CONFLICT", "File was replaced, but its receipt could not be read");
          throw invalid();
        } finally {
          if (temporary && !committed) await unlink(temporary).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
        }
      });
    },
    async delete(selector: WorkspaceFileSelector): Promise<void> {
      const target = await checkedTarget(layout, selector);
      await commitQueue(target, async () => {
        try {
          const entry = await lstat(target);
          if (!entry.isFile() || entry.isSymbolicLink())
            throw new WorkspaceFileError(400, "INVALID_REQUEST", "Only regular files can be deleted");
          await unlink(target);
        } catch (error) {
          if (error instanceof WorkspaceFileError) throw error;
          if (isMissing(error)) throw missing();
          throw invalid();
        }
      });
    },
  };
};
