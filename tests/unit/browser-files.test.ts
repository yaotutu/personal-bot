import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserDownloadStore } from "../../src/adapters/browser/download-store.js";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createBrowserService } from "../../src/features/browser/browser-service.js";
import type { BrowserService } from "../../src/features/browser/browser-service.js";
import {
  MAX_BROWSER_DOWNLOAD_BYTES,
  MAX_BROWSER_UPLOAD_BYTES,
} from "../../src/features/browser/files.js";
import {
  BrowserError,
  type BrowserDownload,
  type BrowserDownloadEvent,
  type BrowserDownloadStore,
  type BrowserDriver,
  type BrowserUpload,
} from "../../src/features/browser/types.js";
import { browserUploadRequest } from "../../src/http/contracts/browser.js";
import { createBrowserRoutes } from "../../src/http/routes/browser.js";

const tab = {
  id: "tab-one",
  title: "Fixture",
  url: "https://example.test/",
  active: true,
  loading: false,
};

const emptyDownloadStore = (): BrowserDownloadStore => ({
  reconcileOnStart: async () => undefined,
  list: async () => [],
  capture: async () => undefined,
  content: async () => { throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found"); },
  remove: async () => { throw new BrowserError("DOWNLOAD_NOT_FOUND", "Browser download not found"); },
  close: async () => undefined,
});

const browserDriver = (overrides: Partial<BrowserDriver> = {}): BrowserDriver => ({
  start: async () => undefined,
  close: async () => undefined,
  listTabs: async () => [tab],
  newTab: async () => tab,
  closeTab: async () => [tab],
  activateTab: async () => tab,
  navigate: async () => tab,
  history: async () => tab,
  reload: async () => tab,
  input: async () => undefined,
  act: async () => undefined,
  snapshot: async () => ({ tab, title: tab.title, url: tab.url, text: "", elements: [] }),
  startScreencast: async () => undefined,
  stopScreencast: async () => undefined,
  listUploads: async () => [],
  setUploadFiles: async () => undefined,
  cancelUpload: async () => undefined,
  ...overrides,
});

const upload = (multiple = false): BrowserUpload => ({
  id: randomUUID(),
  tabId: tab.id,
  multiple,
  accept: ".txt",
  createdAt: new Date().toISOString(),
});

const eventFor = (
  id: string,
  chunks: Uint8Array[],
  options: {
    name?: string;
    failure?: string | null;
    gate?: Promise<void>;
    cancelled?: () => void;
  } = {},
): BrowserDownloadEvent => ({
  id,
  tabId: tab.id,
  name: options.name ?? "report.txt",
  createdAt: new Date().toISOString(),
  failure: async () => options.failure ?? null,
  read: async () => (async function* () {
    for (const chunk of chunks) {
      if (options.gate) await options.gate;
      yield chunk;
    }
  })(),
  cancel: async () => { options.cancelled?.(); },
  discard: async () => undefined,
});

const downloadFor = (id: string, status: BrowserDownload["status"] = "downloading"): BrowserDownload => ({
  id,
  tabId: tab.id,
  name: "report.txt",
  status,
  bytes: status === "completed" ? 2 : null,
  createdAt: new Date().toISOString(),
  error: status === "failed" ? "Download failed" : null,
});

test("upload files validate chooser cardinality, names, strict base64 and total bytes", async (t) => {
  let pending = [upload(false)];
  const writes: { id: string; files: { name: string; mimeType: string; content: Uint8Array }[] }[] = [];
  const cancels: string[] = [];
  const service = createBrowserService(browserDriver({
    listUploads: async () => pending,
    setUploadFiles: async (id, files) => {
      writes.push({ id, files });
      pending = pending.filter((item) => item.id !== id);
    },
    cancelUpload: async (id) => {
      cancels.push(id);
      pending = pending.filter((item) => item.id !== id);
    },
  }), {
    ...emptyDownloadStore(),
    list: async () => [downloadFor(randomUUID(), "completed")],
  });
  t.after(() => service.close());

  const files = await service.listFiles();
  assert.equal(files.uploads.length, 1);
  assert.equal(files.downloads[0]?.status, "completed");

  const single = pending[0]!;
  assert.deepEqual(await service.uploadFiles(single.id, [{
    name: "hello.txt",
    mimeType: "",
    contentBase64: "AQI=",
  }]), { ok: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.files[0]?.mimeType, "application/octet-stream");
  assert.deepEqual([...writes[0]!.files[0]!.content], [1, 2]);

  pending = [upload(false)];
  const current = pending[0]!;
  await assert.rejects(
    service.uploadFiles(current.id, [
      { name: "one.txt", mimeType: "text/plain", contentBase64: "AQ==" },
      { name: "two.txt", mimeType: "text/plain", contentBase64: "Ag==" },
    ]),
    (error: unknown) => error instanceof BrowserError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    service.uploadFiles(current.id, [{
      name: ".hidden",
      mimeType: "text/plain",
      contentBase64: "AQ==",
    }]),
    (error: unknown) => error instanceof BrowserError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    service.uploadFiles(current.id, [{
      name: "bad.txt",
      mimeType: "text/plain",
      contentBase64: "data:text/plain;base64,AQ==",
    }]),
    (error: unknown) => error instanceof BrowserError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    service.uploadFiles(current.id, [{
      name: "large.bin",
      mimeType: "application/octet-stream",
      contentBase64: "A".repeat(11_184_812),
    }]),
    (error: unknown) => error instanceof BrowserError && error.code === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(writes.length, 1);

  await service.cancelUpload(current.id);
  assert.deepEqual(cancels, [current.id]);
  assert.equal(writes.length, 1);
  assert.ok(MAX_BROWSER_UPLOAD_BYTES === 8 * 1024 * 1024);
});

test("download store persists completed content across instances and deletes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-browser-downloads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID();
  const first = createBrowserDownloadStore(root);
  await first.reconcileOnStart();
  await first.capture(eventFor(id, [Uint8Array.from([1]), Uint8Array.from([2, 3])]));

  const [download] = await first.list();
  assert.equal(download?.id, id);
  assert.equal(download?.status, "completed");
  assert.equal(download?.bytes, 3);
  assert.deepEqual(await first.content(id), {
    name: "report.txt",
    mimeType: "application/octet-stream",
    contentBase64: "AQID",
  });
  const directory = join(root, id);
  assert.deepEqual((await readdir(directory)).sort(), ["content", "meta.json"]);
  assert.equal((await lstat(join(directory, "meta.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(directory, "content"))).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);

  const restarted = createBrowserDownloadStore(root);
  await restarted.reconcileOnStart();
  assert.equal((await restarted.list())[0]?.status, "completed");
  assert.equal((await restarted.content(id)).contentBase64, "AQID");
  await restarted.remove(id);
  assert.deepEqual(await restarted.list(), []);
  await assert.rejects(
    restarted.content(id),
    (error: unknown) => error instanceof BrowserError && error.code === "DOWNLOAD_NOT_FOUND",
  );
});

test("download store fails interrupted and oversized downloads without exposing partial content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-browser-downloads-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBrowserDownloadStore(root);
  await store.reconcileOnStart();

  const oversized = randomUUID();
  await store.capture(eventFor(oversized, [new Uint8Array(MAX_BROWSER_DOWNLOAD_BYTES + 1)]));
  const failed = (await store.list()).find((item) => item.id === oversized);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.bytes, null);
  assert.equal(failed?.error, "Download exceeds 32 MiB");
  await assert.rejects(
    store.content(oversized),
    (error: unknown) => error instanceof BrowserError && error.code === "DOWNLOAD_NOT_READY",
  );

  const interrupted = randomUUID();
  const interruptedDir = join(root, interrupted);
  await mkdir(interruptedDir, { mode: 0o700 });
  await writeFile(join(interruptedDir, "meta.json"), JSON.stringify({
    ...downloadFor(interrupted),
    mimeType: "application/octet-stream",
  }), { mode: 0o600 });
  const restarted = createBrowserDownloadStore(root);
  await restarted.reconcileOnStart();
  const recovered = (await restarted.list()).find((item) => item.id === interrupted);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.error, "Interrupted by service restart");
  await assert.rejects(
    restarted.content(interrupted),
    (error: unknown) => error instanceof BrowserError && error.code === "DOWNLOAD_NOT_READY",
  );
});

test("download store rejects corrupt metadata and symlinked content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-browser-downloads-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBrowserDownloadStore(root);
  await store.reconcileOnStart();

  const corrupt = randomUUID();
  const corruptDir = join(root, corrupt);
  await mkdir(corruptDir, { mode: 0o700 });
  await writeFile(join(corruptDir, "meta.json"), JSON.stringify({ id: corrupt }), { mode: 0o600 });
  await assert.rejects(
    store.list(),
    (error: unknown) => error instanceof BrowserError && error.code === "BROWSER_FAILED",
  );
  await rm(corruptDir, { recursive: true, force: true });

  const symlinked = randomUUID();
  await store.capture(eventFor(symlinked, [Uint8Array.from([1, 2])]));
  const outside = join(root, "outside.bin");
  await writeFile(outside, "outside", { mode: 0o600 });
  await rm(join(root, symlinked, "content"));
  await symlink(outside, join(root, symlinked, "content"));
  await assert.rejects(
    store.list(),
    (error: unknown) => error instanceof BrowserError && error.code === "BROWSER_FAILED",
  );
});

test("deleting an in-progress download cancels it and prevents late metadata resurrection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-browser-downloads-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBrowserDownloadStore(root);
  await store.reconcileOnStart();
  const id = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  const task = store.capture(eventFor(id, [Uint8Array.from([1])], {
    gate,
    cancelled: () => { cancelled = true; release(); },
  }));
  while ((await store.list()).every((item) => item.id !== id))
    await new Promise<void>((resolve) => setImmediate(resolve));

  await store.remove(id);
  await task;
  assert.equal(cancelled, true);
  assert.deepEqual(await store.list(), []);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await store.list(), []);
});

test("capture failure cleanup consumes derived rejection and remove rejects a symlinked root before deleting", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-muse-browser-downloads-root-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outside = join(base, "outside");
  const root = join(base, "downloads-link");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, root);
  const store = createBrowserDownloadStore(root);

  await assert.rejects(
    store.capture(eventFor(randomUUID(), [Uint8Array.from([1])])),
    (error: unknown) => error instanceof BrowserError && error.code === "BROWSER_FAILED",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const id = randomUUID();
  const externalDownload = join(outside, id);
  await mkdir(externalDownload, { mode: 0o700 });
  await writeFile(join(externalDownload, "marker.txt"), "keep", { mode: 0o600 });
  await assert.rejects(
    store.remove(id),
    (error: unknown) => error instanceof BrowserError && error.code === "BROWSER_FAILED",
  );
  assert.equal(await readFile(join(externalDownload, "marker.txt"), "utf8"), "keep");
});

test("browser file endpoints are documented and only upload POST gets the 12 MiB body limit", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-browser-files-http-"));
  const service = await createService(createConfig({
    schemaVersion: 1,
    server: { host: "127.0.0.1" },
    runtime: {
      dataDir,
      schedulerIntervalMs: 60000,
      monitorScanIntervalMs: 60000,
    },
  }));
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const headers = {
    Authorization: `Bearer ${service.auth.login()}`,
    "content-type": "application/json",
  };

  const openapiResponse = await service.app.request("/openapi.json");
  const openapi = await openapiResponse.json() as {
    paths: Record<string, Record<string, { security?: unknown[]; description?: string }>>;
  };
  for (const [path, method] of [
    ["/api/browser/files", "get"],
    ["/api/browser/uploads/{uploadId}", "post"],
    ["/api/browser/uploads/{uploadId}", "delete"],
    ["/api/browser/downloads/{downloadId}/content", "get"],
    ["/api/browser/downloads/{downloadId}", "delete"],
  ] as const) {
    const operation = openapi.paths[path]?.[method];
    assert.ok(operation, `${method} ${path} must be documented`);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
  assert.match(openapi.paths["/api/browser/uploads/{uploadId}"]!.post!.description ?? "", /8MiB/);
  assert.match(openapi.paths["/api/browser/uploads/{uploadId}"]!.post!.description ?? "", /12MiB/);

  const belowBrowserLimit = JSON.stringify({
    files: [{
      name: "large.txt",
      mimeType: "text/plain",
      contentBase64: "A".repeat(2 * 1024 * 1024),
    }],
  });
  const missing = await service.app.request("/api/browser/uploads/missing", {
    method: "POST",
    headers,
    body: belowBrowserLimit,
  });
  assert.equal(missing.status, 404);

  const overBrowserLimit = JSON.stringify({
    files: [{
      name: "too-large.txt",
      mimeType: "text/plain",
      contentBase64: "A".repeat(13 * 1024 * 1024),
    }],
  });
  const rejected = await service.app.request("/api/browser/uploads/missing", {
    method: "POST",
    headers,
    body: overBrowserLimit,
  });
  assert.equal(rejected.status, 413);
  assert.equal(((await rejected.json()) as { code?: string }).code, "REQUEST_TOO_LARGE");
});

test("browser upload contract and route error projection stay bounded", async () => {
  assert.equal(browserUploadRequest.safeParse({
    files: [{ name: "empty.bin", mimeType: "", contentBase64: "" }],
  }).success, true);
  assert.equal(browserUploadRequest.safeParse({
    files: [{ name: ".hidden", mimeType: "", contentBase64: "AQ==" }],
  }).success, false);
  assert.equal(browserUploadRequest.safeParse({
    files: [{ name: "bad.txt", mimeType: "", contentBase64: "data:text/plain;base64,AQ==" }],
  }).success, false);

  const fail = (code: ConstructorParameters<typeof BrowserError>[0]) => {
    throw new BrowserError(code, "Safe browser files error");
  };
  const browser = {
    listFiles: async () => fail("BROWSER_FAILED"),
    uploadFiles: async () => fail("PAYLOAD_TOO_LARGE"),
    cancelUpload: async () => fail("UPLOAD_NOT_FOUND"),
    downloadContent: async () => fail("DOWNLOAD_NOT_READY"),
    deleteDownload: async () => fail("INVALID_INPUT"),
  } as unknown as BrowserService;
  const app = createBrowserRoutes(browser);

  assert.equal((await app.request("/api/browser/files")).status, 500);
  assert.equal((await app.request("/api/browser/uploads/id", {
    method: "POST",
    body: JSON.stringify({ files: [] }),
  })).status, 400);
  const tooLarge = await app.request("/api/browser/uploads/id", {
    method: "POST",
    body: JSON.stringify({
      files: [{ name: "ok.txt", mimeType: "", contentBase64: "AQ==" }],
    }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(((await tooLarge.json()) as { code?: string }).code, "PAYLOAD_TOO_LARGE");
  assert.equal((await app.request("/api/browser/uploads/id", { method: "DELETE" })).status, 404);
  assert.equal((await app.request("/api/browser/downloads/id/content")).status, 409);
  assert.equal((await app.request("/api/browser/downloads/id", { method: "DELETE" })).status, 400);
});

test("browser upload returns 413 when decoded bytes exceed 8 MiB without a schema encoded-size cap", async (t) => {
  const pending = upload(false);
  let wroteFiles = false;
  const service = createBrowserService(browserDriver({
    listUploads: async () => [pending],
    setUploadFiles: async () => { wroteFiles = true; },
  }), emptyDownloadStore());
  t.after(() => service.close());

  const body = JSON.stringify({
    files: [{
      name: "large.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.alloc(MAX_BROWSER_UPLOAD_BYTES + 1024, 0x61).toString("base64"),
    }],
  });
  assert.ok(body.length > 11_184_812);
  assert.ok(Buffer.byteLength(body) < 12 * 1024 * 1024);

  const response = await createBrowserRoutes(service).request(`/api/browser/uploads/${pending.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as { code?: string }).code, "PAYLOAD_TOO_LARGE");
  assert.equal(wroteFiles, false);
});
