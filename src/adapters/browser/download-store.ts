import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_FILE_NAME_PATTERN,
  MAX_BROWSER_DOWNLOAD_BYTES,
  safeBrowserDownloadName,
} from "../../features/browser/files.js";
import {
  BrowserError,
  type BrowserDownload,
  type BrowserDownloadContent,
  type BrowserDownloadEvent,
  type BrowserDownloadStatus,
  type BrowserDownloadStore,
} from "../../features/browser/types.js";

type DownloadMeta = BrowserDownload & { mimeType: string };
type ActiveDownload = {
  deleted: boolean;
  interrupted: boolean;
  cancel: () => Promise<void>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_STATUSES = new Set<BrowserDownloadStatus>(["downloading", "completed", "failed"]);
const INVALID_STORAGE = () =>
  new BrowserError("BROWSER_FAILED", "Browser download storage is invalid");

const isIsoTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const assertDownloadId = (downloadId: string) => {
  if (!UUID_PATTERN.test(downloadId))
    throw new BrowserError("INVALID_INPUT", "Invalid browser download id");
};

const parseMeta = (value: unknown, expectedId: string): DownloadMeta => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw INVALID_STORAGE();
  const item = value as Record<string, unknown>;
  const keys = [
    "id",
    "tabId",
    "name",
    "status",
    "bytes",
    "createdAt",
    "error",
    "mimeType",
  ];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item)))
    throw INVALID_STORAGE();
  if (
    item.id !== expectedId ||
    !UUID_PATTERN.test(expectedId) ||
    typeof item.tabId !== "string" ||
    item.tabId.length < 1 ||
    item.tabId.length > 128 ||
    typeof item.name !== "string" ||
    !BROWSER_FILE_NAME_PATTERN.test(item.name) ||
    safeBrowserDownloadName(item.name) !== item.name ||
    !DOWNLOAD_STATUSES.has(item.status as BrowserDownloadStatus) ||
    !isIsoTime(item.createdAt) ||
    typeof item.mimeType !== "string" ||
    item.mimeType.length < 1 ||
    item.mimeType.length > 255
  ) throw INVALID_STORAGE();

  const status = item.status as BrowserDownloadStatus;
  const bytes = item.bytes;
  const error = item.error;
  if (status === "completed") {
    if (
      typeof bytes !== "number" ||
      !Number.isInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_BROWSER_DOWNLOAD_BYTES ||
      error !== null
    ) throw INVALID_STORAGE();
  } else if (bytes !== null || (status === "failed" ? typeof error !== "string" || !error : error !== null)) {
    throw INVALID_STORAGE();
  }
  return {
    id: item.id,
    tabId: item.tabId,
    name: item.name,
    status,
    bytes: bytes as number | null,
    createdAt: item.createdAt,
    error: error as string | null,
    mimeType: item.mimeType,
  };
};

const publicMeta = ({ mimeType: _mimeType, ...download }: DownloadMeta): BrowserDownload => download;

const failureMessage = (error: unknown) => {
  if (error instanceof BrowserError && error.code === "PAYLOAD_TOO_LARGE")
    return "Download exceeds 32 MiB";
  return "Download failed";
};

/**
 * Playwright 下载的持久文件适配器。每个 UUID 目录只保存 content 与 meta.json，
 * 不进入 workspace；所有路径都先做 UUID 与 lstat 校验，损坏数据明确报错。
 */
export const createBrowserDownloadStore = (root: string): BrowserDownloadStore => {
  const active = new Map<string, ActiveDownload>();
  const tasks = new Map<string, Promise<void>>();

  const ensureRoot = async () => {
    try {
      const entry = await lstat(root);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw INVALID_STORAGE();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(root, { recursive: true, mode: 0o700 });
      const created = await lstat(root);
      if (!created.isDirectory() || created.isSymbolicLink()) throw INVALID_STORAGE();
    }
  };

  const directoryFor = (downloadId: string) => {
    assertDownloadId(downloadId);
    return join(root, downloadId);
  };

  const assertDirectory = async (directory: string) => {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw INVALID_STORAGE();
  };

  const assertRegularFile = async (file: string) => {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw INVALID_STORAGE();
    return entry;
  };

  const readMeta = async (downloadId: string): Promise<DownloadMeta> => {
    const directory = directoryFor(downloadId);
    await assertDirectory(directory);
    await assertRegularFile(join(directory, "meta.json"));
    try {
      return parseMeta(JSON.parse(await readFile(join(directory, "meta.json"), "utf8")), downloadId);
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw INVALID_STORAGE();
    }
  };

  const writeMeta = async (meta: DownloadMeta) => {
    const directory = directoryFor(meta.id);
    const temporary = join(directory, `.meta-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(meta), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, "meta.json"));
  };

  const directoryEntries = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw INVALID_STORAGE();
      if (
        entry.name !== "meta.json" &&
        entry.name !== "content" &&
        !/^\.meta-[0-9a-f-]+\.tmp$/i.test(entry.name) &&
        !/^content\.part-[0-9a-f-]+$/i.test(entry.name)
      ) throw INVALID_STORAGE();
    }
    return entries.map((entry) => entry.name);
  };

  const cleanupTransient = async (downloadId: string) => {
    const directory = directoryFor(downloadId);
    for (const name of await directoryEntries(directory)) {
      if (/^\.meta-[0-9a-f-]+\.tmp$/i.test(name) || /^content\.part-[0-9a-f-]+$/i.test(name))
        await rm(join(directory, name), { force: true });
    }
  };

  const verifyCompleted = async (meta: DownloadMeta) => {
    if (meta.status !== "completed") return;
    const entry = await assertRegularFile(join(directoryFor(meta.id), "content"));
    if (entry.size !== meta.bytes || entry.size > MAX_BROWSER_DOWNLOAD_BYTES)
      throw INVALID_STORAGE();
  };

  const list = async () => {
    await ensureRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const downloads: BrowserDownload[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name))
        throw INVALID_STORAGE();
      await directoryEntries(join(root, entry.name));
      let meta: DownloadMeta;
      try {
        meta = await readMeta(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && active.has(entry.name)) continue;
        throw error;
      }
      await verifyCompleted(meta);
      if (meta.status !== "completed" && !active.has(meta.id) &&
        (await directoryEntries(join(root, entry.name))).includes("content"))
        throw INVALID_STORAGE();
      downloads.push(publicMeta(meta));
    }
    return downloads.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  };

  const content = async (downloadId: string): Promise<BrowserDownloadContent> => {
    await ensureRoot();
    const directory = directoryFor(downloadId);
    try {
      await assertDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found");
      throw error;
    }
    let meta: DownloadMeta;
    try {
      meta = await readMeta(downloadId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw INVALID_STORAGE();
      throw error;
    }
    if (meta.status !== "completed")
      throw new BrowserError("DOWNLOAD_NOT_READY", "Browser download is not completed");
    try {
      await verifyCompleted(meta);
      return {
        name: meta.name,
        mimeType: meta.mimeType,
        contentBase64: (await readFile(join(directory, "content"))).toString("base64"),
      };
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw INVALID_STORAGE();
    }
  };

  const captureInternal = async (event: BrowserDownloadEvent) => {
    const directory = directoryFor(event.id);
    await ensureRoot();
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw INVALID_STORAGE();
      throw error;
    }
    await assertDirectory(directory);

    const state: ActiveDownload = {
      deleted: false,
      interrupted: false,
      cancel: event.cancel,
    };
    active.set(event.id, state);

    const name = safeBrowserDownloadName(event.name);
    const meta: DownloadMeta = {
      id: event.id,
      tabId: event.tabId,
      name,
      status: "downloading",
      bytes: null,
      createdAt: event.createdAt,
      error: null,
      mimeType: "application/octet-stream",
    };
    let temporary: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await writeMeta(meta);
      const failure = await event.failure();
      if (state.deleted) return;
      if (state.interrupted) throw new Error("interrupted");
      if (failure) throw new Error("download failed");

      temporary = join(directory, `content.part-${randomUUID()}`);
      handle = await open(temporary, "wx", 0o600);
      const stream = await event.read();
      let bytes = 0;
      for await (const chunk of stream) {
        if (state.deleted) return;
        if (state.interrupted) throw new Error("interrupted");
        bytes += chunk.byteLength;
        if (bytes > MAX_BROWSER_DOWNLOAD_BYTES)
          throw new BrowserError("PAYLOAD_TOO_LARGE", "Browser download exceeds 32 MiB");
        await handle.writeFile(chunk);
      }
      await handle.close();
      handle = undefined;
      if (state.deleted) return;
      if (state.interrupted) throw new Error("interrupted");
      await rename(temporary, join(directory, "content"));
      temporary = undefined;
      await writeMeta({ ...meta, status: "completed", bytes });
      await event.discard().catch(() => undefined);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      if (state.deleted) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      await event.cancel().catch(() => undefined);
      await event.discard().catch(() => undefined);
      const interrupted = state.interrupted;
      const failed: DownloadMeta = {
        ...meta,
        status: "failed",
        bytes: null,
        error: interrupted ? "Interrupted by service restart" : failureMessage(error),
      };
      await writeMeta(failed).catch(() => undefined);
      await cleanupTransient(event.id).catch(() => undefined);
      await rm(join(directory, "content"), { force: true }).catch(() => undefined);
    } finally {
      await handle?.close().catch(() => undefined);
      if (active.get(event.id) === state) active.delete(event.id);
    }
  };

  const capture = (event: BrowserDownloadEvent) => {
    const task = captureInternal(event);
    tasks.set(event.id, task);
    const cleanup = () => {
      if (tasks.get(event.id) === task) tasks.delete(event.id);
    };
    void task.then(cleanup, cleanup);
    return task;
  };

  const remove = async (downloadId: string) => {
    await ensureRoot();
    const directory = directoryFor(downloadId);
    const state = active.get(downloadId);
    if (state) {
      state.deleted = true;
      await state.cancel().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      await tasks.get(downloadId)?.catch(() => undefined);
      return;
    }
    try {
      await assertDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found");
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
  };

  const reconcileOnStart = async () => {
    await ensureRoot();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name))
        throw INVALID_STORAGE();
      const directory = join(root, entry.name);
      await directoryEntries(directory);
      const meta = await readMeta(entry.name);
      if (meta.status === "downloading") {
        await writeMeta({
          ...meta,
          status: "failed",
          bytes: null,
          error: "Interrupted by service restart",
        });
        await rm(join(directory, "content"), { force: true });
      } else {
        await verifyCompleted(meta);
        if (meta.status === "failed") await rm(join(directory, "content"), { force: true });
      }
      await cleanupTransient(entry.name);
    }
  };

  const close = async () => {
    for (const [downloadId, state] of active) {
      state.interrupted = true;
      await state.cancel().catch(() => undefined);
      await tasks.get(downloadId)?.catch(() => undefined);
    }
    await Promise.allSettled([...tasks.values()]);
  };

  return {
    reconcileOnStart,
    list,
    capture,
    content,
    remove,
    close,
  };
};
