export type WorkspaceScope = "space" | "shared";

export type WorkspaceSelector = {
  scope: WorkspaceScope;
  spaceId: string | null;
};

export type WorkspaceFileSelector = WorkspaceSelector & { path: string };

export type WorkspaceListEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  updatedAt: string;
};

export type WorkspaceFileMetadata = {
  name: string;
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  updatedAt: string;
  mimeType: string;
};

export type WorkspaceTextDetail = WorkspaceFileMetadata & {
  kind: "text";
  content: string;
};

export type WorkspaceBinaryDetail = WorkspaceFileMetadata & {
  kind: "image" | "binary";
  dataBase64: string;
};

export type WorkspaceFileDetail = WorkspaceTextDetail | WorkspaceBinaryDetail;

export type WorkspaceListResult = WorkspaceSelector & {
  path: string;
  entries: WorkspaceListEntry[];
};

export type WorkspaceDeleteResult = WorkspaceFileSelector & { ok: true };

type WorkspaceFileStore = {
  list: (input: WorkspaceFileSelector) => Promise<WorkspaceListEntry[]>;
  read: (input: WorkspaceFileSelector) => Promise<WorkspaceFileDetail>;
  create: (input: WorkspaceFileSelector, content: string) => Promise<WorkspaceTextDetail>;
  update: (input: WorkspaceFileSelector, content: string) => Promise<WorkspaceTextDetail>;
  delete: (input: WorkspaceFileSelector) => Promise<void>;
};

export class WorkspaceFileError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "CONFLICT" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

export const MAX_WORKSPACE_TEXT_BYTES = 100_000;
export const MAX_WORKSPACE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 1_000;

const WRITE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const reject = (
  status: 400 | 404 | 409 | 413,
  code: "INVALID_REQUEST" | "NOT_FOUND" | "CONFLICT" | "TOO_LARGE",
  message: string,
): never => {
  throw new WorkspaceFileError(status, code, message);
};

/**
 * 只读接口允许访问历史上由模型工具创建的非 ASCII 名称；写入接口另行执行
 * 更严格的新路径字符集。所有路径都必须是所选根内的相对路径。
 */
const normalizeReadPath = (raw: string): string => {
  if (!raw || raw.length > 2048 || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/"))
    reject(400, "INVALID_REQUEST", "Invalid workspace path");
  if (raw === ".") return raw;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    reject(400, "INVALID_REQUEST", "Invalid workspace path");
  return parts.join("/");
};

const normalizeWritePath = (raw: string): string => {
  const path = normalizeReadPath(raw);
  if (path === "." || !path.split("/").every((part) => WRITE_PATH_SEGMENT.test(part) && part !== "." && part !== ".."))
    reject(400, "INVALID_REQUEST", "Write path segments may contain only ASCII letters, digits, dot, hyphen, and underscore");
  return path;
};

const validUnicode = (content: string): boolean => {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = index + 1 < content.length ? content.charCodeAt(index + 1) : 0;
    if (code > 0xdbff || next < 0xdc00 || next > 0xdfff) return false;
    index++;
  }
  return true;
};

const selectorOf = (input: WorkspaceFileSelector): WorkspaceSelector => ({
  scope: input.scope,
  spaceId: input.spaceId,
});

/**
 * 手动文件服务只承担“用户已经看过完整 before/after 并确认”后的落盘入口；
 * 模型 write/edit 仍由 pi 工具层自行登记版本绑定审批，这里不新增审批记录。
 */
export const createWorkspaceFileService = (
  store: WorkspaceFileStore,
  dependencies: { spaceExists: (spaceId: string) => Promise<boolean> },
) => {
  const prepare = async (input: WorkspaceFileSelector, mode: "read" | "write"): Promise<WorkspaceFileSelector> => {
    if (input.scope === "space") {
      const spaceId = input.spaceId;
      if (!spaceId) reject(400, "INVALID_REQUEST", "spaceId is required when scope is space");
      if (!(await dependencies.spaceExists(spaceId!))) reject(404, "NOT_FOUND", "Workspace space not found");
    } else if (input.spaceId !== null) {
      reject(400, "INVALID_REQUEST", "spaceId must be omitted when scope is shared");
    }
    return { ...input, path: mode === "write" ? normalizeWritePath(input.path) : normalizeReadPath(input.path) };
  };

  return {
    async list(input: WorkspaceFileSelector): Promise<WorkspaceListResult> {
      const selected = await prepare(input, "read");
      return { ...selectorOf(selected), path: selected.path, entries: await store.list(selected) };
    },
    async read(input: WorkspaceFileSelector): Promise<WorkspaceFileDetail & WorkspaceSelector> {
      const selected = await prepare(input, "read");
      if (selected.path === ".") reject(400, "INVALID_REQUEST", "A file path is required");
      return { ...selectorOf(selected), ...(await store.read(selected)) };
    },
    async create(input: WorkspaceFileSelector & { content: string; confirmed: boolean }): Promise<WorkspaceTextDetail & WorkspaceSelector> {
      if (!input.confirmed) reject(400, "INVALID_REQUEST", "confirmed must be true after the full preview is accepted");
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_WORKSPACE_TEXT_BYTES) reject(413, "TOO_LARGE", "Text content exceeds 100000 UTF-8 bytes");
      if (input.content.includes("\0") || !validUnicode(input.content))
        reject(400, "INVALID_REQUEST", "Text content must be valid UTF-8 without NUL bytes");
      const selected = await prepare(input, "write");
      return { ...selectorOf(selected), ...(await store.create(selected, input.content)) };
    },
    async update(input: WorkspaceFileSelector & { content: string; confirmed: boolean }): Promise<WorkspaceTextDetail & WorkspaceSelector> {
      if (!input.confirmed) reject(400, "INVALID_REQUEST", "confirmed must be true after the full preview is accepted");
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_WORKSPACE_TEXT_BYTES) reject(413, "TOO_LARGE", "Text content exceeds 100000 UTF-8 bytes");
      if (input.content.includes("\0") || !validUnicode(input.content))
        reject(400, "INVALID_REQUEST", "Text content must be valid UTF-8 without NUL bytes");
      const selected = await prepare(input, "write");
      return { ...selectorOf(selected), ...(await store.update(selected, input.content)) };
    },
    async delete(input: WorkspaceFileSelector): Promise<WorkspaceDeleteResult & WorkspaceSelector> {
      const selected = await prepare(input, "write");
      if (selected.path === ".") reject(400, "INVALID_REQUEST", "A file path is required");
      await store.delete(selected);
      return { scope: selected.scope, spaceId: selected.spaceId, path: selected.path, ok: true };
    },
  };
};

export type WorkspaceFileService = ReturnType<typeof createWorkspaceFileService>;
