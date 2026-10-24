import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createWritableFileTools } from "../../src/adapters/pi/tools/files-writable.js";
import { sharedWorkspaceDir, spaceWorkspaceDir } from "../../src/adapters/storage/data-layout.js";
import type { WorkspaceFileSelector } from "../../src/features/workspace/files-service.js";
import {
  workspaceContentResponse,
  workspaceListResponse,
  workspaceTextWriteResponse,
} from "../../src/http/contracts/workspace-files.js";

type Service = Awaited<ReturnType<typeof createService>>;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const openService = async (t: TestContext, options: { modelBaseUrl?: string; existingSpace?: boolean } = {}) => {
  let service: Service | undefined;
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-workspace-files-"));
  t.after(async () => {
    try { await service?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  if (options.existingSpace) await mkdir(join(dataDir, "sessions", "trip-2026"), { recursive: true, mode: 0o700 });
  service = await createService(createConfig({
    ...(options.modelBaseUrl ? {
      model: { baseUrl: options.modelBaseUrl, id: "test-model", apiKey: "test-key" },
    } : {}),
    runtime: { dataDir, runTimeoutMs: 15000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  return {
    service: service!,
    dataDir,
    headers: { Authorization: `Bearer ${service.auth.login()}` },
  };
};

const request = (service: Service, path: string, init: RequestInit = {}) =>
  service.app.request(path, {
    ...init,
    headers: { ...init.headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });

const jsonBody = (body: unknown) => JSON.stringify(body);

const waitUntil = async <T>(check: () => Promise<T> | T, description: string) => {
  for (let index = 0; index < 300; index++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

test("workspace files: all five operations require Bearer auth", async (t) => {
  const { service } = await openService(t);
  const cases = [
    ["/api/workspace/files?scope=space&spaceId=local-main", "GET"],
    ["/api/workspace/files/content?scope=space&spaceId=local-main&path=note.md", "GET"],
    ["/api/workspace/files/text?scope=space&spaceId=local-main&path=note.md", "POST"],
    ["/api/workspace/files/text?scope=space&spaceId=local-main&path=note.md", "PUT"],
    ["/api/workspace/files?scope=space&spaceId=local-main&path=note.md", "DELETE"],
  ] as const;
  for (const [path, method] of cases) {
    const response = await request(service, path, { method, body: method === "GET" || method === "DELETE" ? undefined : jsonBody({ content: "x", confirmed: true }) });
    assert.equal(response.status, 401, `${method} ${path} must require auth`);
  }
});

test("workspace files: list is explicit, stable, isolated and skips symlinks", async (t) => {
  const { service, dataDir, headers } = await openService(t, { existingSpace: true });
  const root = join(dataDir, "workspace", "threads", "trip-2026");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "z-dir"));
  await writeFile(join(root, "a.md"), "space text");
  await writeFile(join(root, "z.txt"), "later");
  await symlink(join(root, "a.md"), join(root, "link.md"));
  await writeFile(join(dataDir, "workspace", "shared", "shared.md"), "shared text");

  const privateList = await request(service, "/api/workspace/files?scope=space&spaceId=trip-2026", { headers });
  assert.equal(privateList.status, 200);
  const privateBody = workspaceListResponse.parse(await privateList.json());
  assert.deepEqual(privateBody, {
    scope: "space",
    spaceId: "trip-2026",
    path: ".",
    entries: [
      { name: "z-dir", path: "z-dir", kind: "directory", size: 0, updatedAt: privateBody.entries[0]!.updatedAt },
      { name: "a.md", path: "a.md", kind: "file", size: 10, updatedAt: privateBody.entries[1]!.updatedAt },
      { name: "z.txt", path: "z.txt", kind: "file", size: 5, updatedAt: privateBody.entries[2]!.updatedAt },
    ],
  });

  const sharedList = await request(service, "/api/workspace/files?scope=shared", { headers });
  assert.equal(sharedList.status, 200);
  const sharedBody = workspaceListResponse.parse(await sharedList.json());
  assert.equal(sharedBody.scope, "shared");
  assert.equal(sharedBody.spaceId, null);
  assert.deepEqual(sharedBody.entries.map((entry) => entry.path), ["shared.md"]);

  const nested = await request(service, "/api/workspace/files?scope=space&spaceId=trip-2026&path=z-dir", { headers });
  assert.equal(nested.status, 200);
  assert.deepEqual((await nested.json()).entries, []);

  for (const query of [
    "scope=shared&spaceId=local-main",
    "scope=space",
    "scope=space&spaceId=ghost",
    "scope=space&spaceId=local-main&path=..",
    "scope=space&spaceId=local-main&path=/etc",
    "scope=space&spaceId=local-main&path=a\\b",
  ]) {
    const response = await request(service, `/api/workspace/files?${query}`, { headers });
    assert.equal(response.status, query.includes("ghost") ? 404 : 400, query);
  }
  assert.equal(await stat(join(dataDir, "workspace", "threads", "ghost")).catch(() => null), null);
});

test("workspace files: text create, update and read preserve exact UTF-8 content", async (t) => {
  const { service, dataDir, headers } = await openService(t);
  const content = "\uFEFF第一行\nsecond line\n";
  const root = join(dataDir, "workspace", "threads", "local-main");
  await writeFile(join(root, "image.png"), PNG_1X1);
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const create = await request(service, "/api/workspace/files/text", {
    method: "POST", headers, body: jsonBody({ scope: "space", spaceId: "local-main", path: "notes/read-me.md", content, confirmed: true }),
  });
  assert.equal(create.status, 200);
  const created = workspaceTextWriteResponse.parse(await create.json());
  assert.equal(created.kind, "text");
  assert.equal(created.content, content);
  assert.equal(created.size, Buffer.byteLength(content, "utf8"));
  assert.equal(created.path, "notes/read-me.md");
  assert.equal((await readFile(join(root, "notes", "read-me.md"))).equals(Buffer.from(content, "utf8")), true);

  const conflict = await request(service, "/api/workspace/files/text", {
    method: "POST", headers, body: jsonBody({ scope: "space", spaceId: "local-main", path: "notes/read-me.md", content: "again", confirmed: true }),
  });
  assert.equal(conflict.status, 409);

  const replacement = "\uFEFF短中文";
  const update = await request(service, "/api/workspace/files/text", {
    method: "PUT", headers, body: jsonBody({ scope: "space", spaceId: "local-main", path: "notes/read-me.md", content: replacement, confirmed: true }),
  });
  assert.equal(update.status, 200);
  const updated = workspaceTextWriteResponse.parse(await update.json());
  assert.equal(updated.content, replacement);
  assert.equal(updated.size, Buffer.byteLength(replacement, "utf8"));
  assert.equal((await readFile(join(root, "notes", "read-me.md"))).equals(Buffer.from(replacement, "utf8")), true);

  const read = await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=notes/read-me.md", { headers });
  assert.equal(read.status, 200);
  const detail = workspaceContentResponse.parse(await read.json());
  assert.equal(detail.kind, "text");
  assert.equal(detail.content, replacement);
  assert.equal(detail.size, Buffer.byteLength(replacement, "utf8"));

  for (const [path, original] of [["image.png", PNG_1X1], ["binary.bin", Buffer.from([0, 1, 2, 3])] as const] as const) {
    const refused = await request(service, "/api/workspace/files/text", {
      method: "PUT", headers,
      body: jsonBody({ scope: "space", spaceId: "local-main", path, content: "not an image", confirmed: true }),
    });
    assert.equal(refused.status, 400, path);
    assert.equal((await readFile(join(root, path))).equals(original), true, path);
  }

  for (const body of [
    { scope: "space", spaceId: "local-main", path: "new.md", content: "x", confirmed: false },
    { scope: "space", spaceId: "local-main", path: "bad name.md", content: "x", confirmed: true },
    { scope: "space", spaceId: "local-main", path: "../new.md", content: "x", confirmed: true },
    { scope: "space", spaceId: "local-main", path: "a/../new.md", content: "x", confirmed: true },
    { scope: "shared", spaceId: "local-main", path: "new.md", content: "x", confirmed: true },
    { scope: "space", spaceId: "local-main", path: "new.md", content: "\0", confirmed: true },
  ]) {
    const response = await request(service, "/api/workspace/files/text", { method: "POST", headers, body: jsonBody(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const oversized = await request(service, "/api/workspace/files/text", {
    method: "POST", headers, body: jsonBody({ scope: "shared", path: "large.md", content: "a".repeat(100001), confirmed: true }),
  });
  assert.equal(oversized.status, 413);
  const missingUpdate = await request(service, "/api/workspace/files/text", {
    method: "PUT", headers, body: jsonBody({ scope: "shared", path: "missing.md", content: "x", confirmed: true }),
  });
  assert.equal(missingUpdate.status, 404);

  const boundaryRequest = {
    scope: "shared",
    spaceId: null,
    path: "response-boundary.md",
    content: "boundary",
    confirmed: true,
    debug: "must-not-leak",
  } as WorkspaceFileSelector & { content: string; confirmed: boolean; debug: string };
  const boundaryCreate = await service.workspaceFiles.create(boundaryRequest);
  const boundaryUpdate = await service.workspaceFiles.update(boundaryRequest);
  for (const result of [boundaryCreate, boundaryUpdate]) {
    assert.equal("confirmed" in result, false);
    assert.equal("debug" in result, false);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["content", "kind", "mimeType", "name", "path", "scope", "spaceId", "size", "updatedAt"].sort(),
    );
  }
});

test("workspace files: downloads classify PNG, binary and SVG text with byte limits", async (t) => {
  const { service, dataDir, headers } = await openService(t);
  const root = join(dataDir, "workspace", "threads", "local-main");
  await writeFile(join(root, "logo.png"), PNG_1X1);
  await writeFile(join(root, "fake.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await writeFile(join(root, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]));
  await writeFile(join(root, "animation.gif"), Buffer.from("GIF89a trailer"));
  await writeFile(join(root, "picture.webp"), Buffer.concat([
    Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP data"),
  ]));
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "page.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");

  const png = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=logo.png", { headers })).json());
  assert.equal(png.kind, "image");
  assert.equal(png.mimeType, "image/png");
  assert.equal(Buffer.from(png.dataBase64, "base64").equals(PNG_1X1), true);

  const fakePng = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=fake.png", { headers })).json());
  assert.equal(fakePng.kind, "binary");
  const jpeg = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=photo.jpg", { headers })).json());
  assert.equal(jpeg.kind, "image");
  assert.equal(jpeg.mimeType, "image/jpeg");
  const gif = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=animation.gif", { headers })).json());
  assert.equal(gif.kind, "image");
  assert.equal(gif.mimeType, "image/gif");
  const webp = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=picture.webp", { headers })).json());
  assert.equal(webp.kind, "image");
  assert.equal(webp.mimeType, "image/webp");

  const binary = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=blob.bin", { headers })).json());
  assert.equal(binary.kind, "binary");
  assert.equal(binary.mimeType, "application/octet-stream");

  const svg = workspaceContentResponse.parse(await (await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=page.svg", { headers })).json());
  assert.equal(svg.kind, "text");
  assert.match(svg.content, /<svg/);

  await writeFile(join(root, "large.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 1));
  const tooLarge = await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=large.bin", { headers });
  assert.equal(tooLarge.status, 413);
});

test("workspace files: FIFOs are rejected without blocking or leaking paths", async (t) => {
  if (process.platform === "win32") return;
  const { service, dataDir, headers } = await openService(t);
  const fifo = join(dataDir, "workspace", "threads", "local-main", "pipe.fifo");
  execFileSync("mkfifo", [fifo]);
  const response = await request(service, "/api/workspace/files/content?scope=space&spaceId=local-main&path=pipe.fifo", { headers });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.equal(typeof body.error, "string");
  assert.equal(body.error.includes(dataDir), false);
});

test("workspace files: directory entry limit is honest and deletes only regular files", async (t) => {
  const { service, dataDir, headers } = await openService(t);
  const root = join(dataDir, "workspace", "shared");
  await mkdir(join(root, "directory"), { recursive: true });
  await writeFile(join(root, "delete-me.md"), "bye");
  await symlink(join(root, "delete-me.md"), join(root, "link.md"));
  for (let index = 0; index < 1001; index++) await mkdir(join(root, `entry-${String(index).padStart(4, "0")}`));

  const tooMany = await request(service, "/api/workspace/files?scope=shared", { headers });
  assert.equal(tooMany.status, 413);

  for (const path of ["directory", "link.md", "missing.md"]) {
    const response = await request(service, `/api/workspace/files?scope=shared&path=${encodeURIComponent(path)}`, { method: "DELETE", headers });
    assert.equal(response.status, path === "missing.md" ? 404 : 400, path);
  }
  const deleted = await request(service, "/api/workspace/files?scope=shared&path=delete-me.md", { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { scope: "shared", spaceId: null, path: "delete-me.md", ok: true });
  assert.equal(await stat(join(root, "delete-me.md")).catch(() => null), null);
});

test("workspace files: target and parent symlinks cannot read, write or delete through links", async (t) => {
  const { service, dataDir, headers } = await openService(t);
  const root = join(dataDir, "workspace", "threads", "local-main");
  const outside = join(dataDir, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "SECRET");
  await symlink(join(outside, "secret.md"), join(root, "target-link.md"));
  await symlink(outside, join(root, "parent-link"));

  for (const path of ["target-link.md", "parent-link/secret.md"]) {
    const read = await request(service, `/api/workspace/files/content?scope=space&spaceId=local-main&path=${encodeURIComponent(path)}`, { headers });
    assert.equal(read.status, 400, path);
    const create = await request(service, "/api/workspace/files/text", {
      method: "POST", headers,
      body: jsonBody({ scope: "space", spaceId: "local-main", path: path === "target-link.md" ? "target-link.md" : "parent-link/new.md", content: "x", confirmed: true }),
    });
    assert.equal(create.status, 400, path);
    const remove = await request(service, `/api/workspace/files?scope=space&spaceId=local-main&path=${encodeURIComponent(path)}`, { method: "DELETE", headers });
    assert.equal(remove.status, 400, path);
  }
  assert.equal(await readFile(join(outside, "secret.md"), "utf8"), "SECRET");
  assert.equal(await stat(join(outside, "new.md")).catch(() => null), null);
});

test("workspace files: manual save invalidates an old model write approval version", async (t) => {
  const opened = await openService(t);
  const { service, headers } = opened;
  const root = spaceWorkspaceDir(service.layout, "local-main");
  const writeTool = createWritableFileTools(
    root,
    service.actions,
    10_000,
    { spaceId: "local-main", runId: "manual-write-race" },
    sharedWorkspaceDir(service.layout),
    service.layout.workspaceDir,
    undefined,
    service.workspaceCommits,
  ).find((tool) => tool.name === "write")!;
  const pendingWrite = (writeTool.execute as unknown as (
    id: string,
    params: { path: string; content: string },
  ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>)(
    "model-write-call",
    { path: "draft.md", content: "MODEL-STALE-CONTENT" },
  );
  const action = await waitUntil(async () => (await service.actions.snapshotPending())[0], "model write approval");
  assert.equal((action.payload as Record<string, string>).path, "draft.md");

  const manual = await request(service, "/api/workspace/files/text", {
    method: "POST", headers,
    body: jsonBody({ scope: "space", spaceId: "local-main", path: "draft.md", content: "MANUAL-SAFE-CONTENT", confirmed: true }),
  });
  assert.equal(manual.status, 200);
  const decision = await request(service, `/api/approvals/${action.id}/decision`, {
    method: "POST", headers, body: jsonBody({ decision: "approve" }),
  });
  assert.equal(decision.status, 200);
  const toolResult = await pendingWrite;
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0]?.text ?? "", /File changed since approval/);
  assert.equal(await readFile(join(opened.dataDir, "workspace", "threads", "local-main", "draft.md"), "utf8"), "MANUAL-SAFE-CONTENT");
});
