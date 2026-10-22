import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLiveOptions } from "./options.js";

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createTestClient } = await import("../support/http-client.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as {
    server?: { port?: number; accessKey?: string };
    model?: { id?: string };
  };

  const port = raw.server?.port ?? 17890;
  const baseUrl = `http://127.0.0.1:${port}`;
  const accessKey = raw.server?.accessKey ?? "";
  const modelId = raw.model?.id ?? "unknown";

  const results: Record<string, boolean> = {};
  const cleanup: { memoryDeleted: boolean; spaceDeleted: boolean } = { memoryDeleted: false, spaceDeleted: false };
  let serviceVersion: unknown = null;
  let createdMemoryId = "";
  const spaceId = `cors-live-${randomUUID().slice(0, 8)}`;
  const marker = `A05-CORS-LIVE-${randomUUID().slice(0, 8)}`;
  let token = "";

  try {
    // 1. 登录既有 17890 真实服务
    const loginRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(loginRes.status, 200, `Login failed: ${loginRes.status}`);
    token = ((await loginRes.json()) as { token: string }).token;

    const client = createTestClient(() => baseUrl, token, 120_000);
    serviceVersion = (await client.json("/api/health")).serviceVersion;

    // 2. OPTIONS 预检 /api/memories/:id，校验三项 CORS 头与 204
    const optionsRes = await fetch(`${baseUrl}/api/memories/m_preflight_check`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8082",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(optionsRes.status, 204, `OPTIONS preflight status expected 204, got ${optionsRes.status}`);
    assert.equal(optionsRes.headers.get("access-control-allow-origin"), "http://localhost:8082");
    const allowMethods = (optionsRes.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    assert.ok(allowMethods.split(",").map((s) => s.trim()).includes("PATCH"), `allow-methods missing PATCH: ${allowMethods}`);
    const allowHeaders = (optionsRes.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.ok(allowHeaders.includes("authorization") && allowHeaders.includes("content-type"), `allow-headers missing auth/content-type: ${allowHeaders}`);
    results.corsPreflight = true;

    // 3. 真实模型只完成一轮对话；CORS 验收不依赖模型是否选择工具。
    const prompt = `系统测试。请直接且仅回复：${marker}`;
    const runResult = await client.startRun(prompt, spaceId);
    const events = await runResult.done;
    assert.equal(events.at(-1)?.type, "RUN_FINISHED", "Run must end with RUN_FINISHED");
    // 该专项只需要证明真实模型链路可用；不把 CORS 结果绑定在模型输出措辞上。
    assert.equal(events.length > 0, true);
    results.liveModelRun = true;

    // 4. 用正式 REST 创建测试记忆，避免模型工具选择波动影响 PATCH 协议验收。
    const createRes = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "http://localhost:8082" },
      body: JSON.stringify({ text: marker, source: "CORS live regression" }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(createRes.status, 200, "REST memory creation failed");
    createdMemoryId = ((await createRes.json()) as { id: string }).id;

    // 5. 真实 PATCH 跨域修改记忆，断言 200、CORS 回显及 GET 落盘
    const updatedText = `${marker}-updated`;
    const patchRes = await fetch(`${baseUrl}/api/memories/${createdMemoryId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "http://localhost:8082" },
      body: JSON.stringify({ text: updatedText }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.headers.get("access-control-allow-origin"), "http://localhost:8082");

    const getRes = await fetch(`${baseUrl}/api/memories/${createdMemoryId}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:8082" },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(getRes.status, 200);
    assert.equal(((await getRes.json()) as { text: string }).text, updatedText, "PATCHed text not persisted");
    results.corsPatchPersisted = true;

    // 6. 无 token PATCH 断言 401 且内容不变
    const unauthPatch = await fetch(`${baseUrl}/api/memories/${createdMemoryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:8082" },
      body: JSON.stringify({ text: `${marker}-unauthorized` }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(unauthPatch.status, 401);
    const verifyRes = await fetch(`${baseUrl}/api/memories/${createdMemoryId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(((await verifyRes.json()) as { text: string }).text, updatedText, "Content modified by unauth request");
    results.unauthorized401Preserved = true;
  } finally {
    if (baseUrl && token) {
      // 工具可能已经写入、最终回复却失败，按本轮标记回查后清理，不依赖成功分支赋值。
      const remaining = await fetch(`${baseUrl}/api/memories`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        assert.equal(response.status, 200);
        return (await response.json()) as { memories: { id: string; text: string }[] };
      }).catch(() => null);
      cleanup.memoryDeleted = remaining !== null;
      const ids = new Set(remaining?.memories.filter((item) => item.text === marker || item.text === `${marker}-updated`).map((item) => item.id));
      if (createdMemoryId) ids.add(createdMemoryId);
      for (const id of ids) {
        const delMem = await fetch(`${baseUrl}/api/memories/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        cleanup.memoryDeleted = cleanup.memoryDeleted && delMem?.status === 200;
      }
      if (spaceId) {
        const delSpace = await fetch(`${baseUrl}/api/spaces/${spaceId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        cleanup.spaceDeleted = delSpace?.status === 200;
      }
    }

    const summary = {
      modelId,
      serviceVersion,
      results,
      cleanup,
      ok: Object.values(results).length === 4 && Object.values(results).every(Boolean) && cleanup.memoryDeleted && cleanup.spaceDeleted,
    };

    if (options.keepArtifacts) {
      const artifactDir = await mkdtemp(join(tmpdir(), "pi-muse-cors-"));
      await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
      process.stdout.write(`Artifacts saved: ${join(artifactDir, "summary.json")}\n`);
    }

    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    if (!summary.ok) process.exitCode = 1;
  }
};

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") {
  process.stdout.write("用法：node --import tsx tests/live/cors.ts --config <path> --allow-live [--keep-artifacts]\n连接已运行且使用真实模型的本机开发服务；读取 server.port/accessKey 与 model.id，仅创建并清理本轮测试记忆和空间。\n");
} else if (parsed.kind === "error") {
  process.stderr.write(`${parsed.message}\n`);
  process.exitCode = 2;
} else {
  await execute(parsed.options).catch(() => {
    process.stderr.write("Live CORS test failed; inspect the scenario summary and service readiness.\n");
    process.exitCode = 1;
  });
}
