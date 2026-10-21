import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFakeModel, type ModelRequest } from "../support/fake-model.js";
import { createServiceProcess, type ServiceProcessOptions } from "../support/service-process.js";
import { createTestClient, waitForTest } from "../support/http-client.js";
import { activitiesResponse, activityDetailResponse, type ActivityDetailDto } from "../../src/http/contracts/activities.js";

type Call = { name: string; args: object };
const activity = (action: string, fields: object = {}): Call => ({ name: "activity", args: { action, ...fields } });
const start = activity("start", { title: "E2E research", goal: "Verify the entrusted outcome", deliverable: "An evidence report" });
const complete = activity("complete", { result: "E2E report delivered" });
const clock: Call = { name: "currentTime", args: {} };
const script = (calls: Call[], end: "reply" | "hold" | "fail" | "empty" = "reply") => `E2E activity ${JSON.stringify({ calls, end })}`;
const succeeded = (events: { type: string }[]) => assert.equal(events.at(-1)?.type, "RUN_FINISHED");
const failed = (events: { type: string }[]) => assert.equal(events.at(-1)?.type, "RUN_ERROR");

/** 模型是本地 provider；HTTP/socket、dist 入口、pi、工具、审批与磁盘状态全部真实运行。 */
const fixture = async (t: TestContext, options: Partial<Omit<ServiceProcessOptions, "modelBaseUrl">> = {}) => {
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createServiceProcess>> | undefined;
  t.after(async () => { try { await service?.close(); } finally { await model?.close(); } });
  model = await createFakeModel();
  service = await createServiceProcess(t, { modelBaseUrl: model.baseUrl, ...options });
  const login = await fetch(service.baseUrl + "/api/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: service.accessKey }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const client = createTestClient(() => service!.baseUrl, token);
  const list = async (query = "") => activitiesResponse.parse(await client.json("/api/activities" + query));
  const detail = async (id: string) => activityDetailResponse.parse(await client.json(`/api/activities/${id}`));
  const one = async (spaceId: string) => {
    const page = await list(`?spaceId=${spaceId}`);
    assert.equal(page.activities.length, 1);
    return detail(page.activities[0].id);
  };
  return { service, model, client, list, detail, one };
};

const sessionFiles = async (dataDir: string, spaceId: string) => {
  const directory = join(dataDir, "sessions", spaceId);
  return (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
};
const sessionBytes = async (dataDir: string, spaceId: string) => Promise.all((await sessionFiles(dataDir, spaceId)).map(async (file) => {
  const bytes = await readFile(file);
  return { file, hash: createHash("sha256").update(bytes).digest("hex"), mtime: (await stat(file)).mtimeMs };
}));
const callsOf = (request: ModelRequest) => request.messages.flatMap((message) => message.tool_calls ?? []) as { id: string; function: { name: string } }[];
const assertClosedSteps = (detail: ActivityDetailDto) => {
  assert.equal(new Set(detail.steps.map((step) => step.id)).size, detail.steps.length);
  for (const step of detail.steps) {
    assert.notEqual(step.status, "running", step.id);
    if (step.status === "interrupted" && step.finishedAt === null) continue;
    assert.ok(step.finishedAt, `${step.id} must have a finish time`);
    assert.ok(Date.parse(step.finishedAt!) >= Date.parse(step.startedAt));
    if (step.parentId) assert.ok(detail.steps.some((parent) => parent.id === step.parentId), `missing parent of ${step.id}`);
  }
};

test("activity e2e: authentication and ordinary chat do not create records; queries preserve files and revision", async (t) => {
  const { service, model, client, list } = await fixture(t);
  for (const path of ["/api/activities", "/api/activities/missing"]) {
    assert.equal((await fetch(service.baseUrl + path, { signal: AbortSignal.timeout(5000) })).status, 401);
  }
  succeeded(await client.run("ordinary hello", "activity-ordinary"));
  succeeded(await client.run("现在几点", "activity-ordinary"));
  const before = await client.history("activity-ordinary");
  const files = await sessionBytes(service.dataDir, "activity-ordinary");
  const spaces = await client.json("/api/spaces");
  const count = model.requests.length;
  assert.deepEqual((await list()).activities, []);
  assert.deepEqual((await list("?spaceId=never-created")).activities, []);
  assert.equal((await client.request("/api/activities/missing")).status, 404);
  assert.deepEqual(await client.history("activity-ordinary"), before);
  assert.deepEqual(await sessionBytes(service.dataDir, "activity-ordinary"), files);
  assert.deepEqual(await client.json("/api/spaces"), spaces);
  await assert.rejects(stat(join(service.dataDir, "sessions/never-created")), { code: "ENOENT" });
  assert.equal(model.requests.length, count);
});

test("activity e2e: registration is idempotent, steps match tool calls, replay and process restart preserve the same record", async (t) => {
  const { service, model, client, one, list } = await fixture(t);
  const spaceId = "activity-complete";
  const message = { id: randomUUID(), content: script([start, start, activity("update", { progress: "Evidence collected" }), clock, complete]) };
  const body = { spaceId, runId: randomUUID(), expectedRevision: "empty", message };
  const response = await client.request("/api/conversation/run", body);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /RUN_FINISHED/);
  const result = await one(spaceId);
  assert.equal(result.activity.status, "completed");
  assert.equal(result.activity.result, "E2E report delivered");
  assert.deepEqual(result.activity.runIds, [body.runId]);
  assert.equal(result.steps.filter((step) => step.kind === "execution").length, 1);
  assert.equal(result.steps.filter((step) => step.kind === "tool").length, 1);
  const clockCall = model.requests.flatMap(callsOf).find((call) => call.function.name === "currentTime");
  assert.ok(clockCall);
  assert.ok(result.steps.some((step) => step.id === `${body.runId}:main:tool:${clockCall.id}`));
  assertClosedSteps(result);
  const requests = model.requests.length;
  const before = await sessionBytes(service.dataDir, spaceId);
  const replay = await client.request("/api/conversation/run", body);
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /RUN_FINISHED/);
  assert.deepEqual(await one(spaceId), result);
  assert.deepEqual(await sessionBytes(service.dataDir, spaceId), before);
  assert.equal(model.requests.length, requests);
  await service.restart();
  assert.deepEqual(await one(spaceId), result);
  assert.equal(model.requests.length, requests, "restart must not dispatch work");
  assert.equal((await list()).activities.length, 1);
  await assert.rejects(stat(join(service.dataDir, "activities.json")), { code: "ENOENT" });
});

for (const variant of ["missing-declaration", "new-tool-after-complete", "empty-delivery", "waiting-user"] as const) {
  test(`activity e2e: completion protection for ${variant}`, async (t) => {
    const { client, one } = await fixture(t);
    const calls = variant === "waiting-user" ? [start, activity("wait", { progress: "Which output format?" })]
      : variant === "new-tool-after-complete" ? [start, complete, clock]
      : variant === "empty-delivery" ? [start, complete] : [start, clock];
    succeeded(await client.run(script(calls, variant === "empty-delivery" ? "empty" : "reply"), "activity-guard"));
    const result = await one("activity-guard");
    assert.equal(result.activity.status, variant === "waiting-user" ? "waiting_user" : "awaiting_continuation");
    assert.equal(result.activity.result, null);
    assert.equal(result.activity.currentRunId, null);
    assert.equal(result.activity.finishedAt, null);
    assertClosedSteps(result);
  });
}

for (const end of ["hold", "fail"] as const) {
  test(`activity e2e: pending completion cannot override ${end === "hold" ? "Stop" : "model failure"}`, async (t) => {
    const { client, model, one } = await fixture(t);
    const baseline = model.requests.length;
    const running = await client.startRun(script([start, complete], end), "activity-pending");
    if (end === "hold") {
      await waitForTest(() => model.requests.length >= baseline + 3, "final delivery request");
      const pending = await one(running.spaceId);
      assert.equal(pending.activity.status, "running");
      assert.equal(pending.activity.result, null);
      assert.ok(pending.steps.some((step) => step.kind === "model" && step.status === "running"));
      assert.equal((await client.json("/api/conversation/stop", { spaceId: running.spaceId, runId: running.runId })).stopped, true);
    }
    const events = await running.done;
    failed(events);
    const result = await one(running.spaceId);
    assert.equal(result.activity.status, end === "hold" ? "stopped" : "failed");
    assert.equal(result.activity.result, null);
    assertClosedSteps(result);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(events) + JSON.stringify(await client.history(running.spaceId)), /provider-secret-activity-diagnostic/);
  });
}

test("activity e2e: Stop cancels the provider, ordinary turns leave the activity unchanged and explicit resume retains history", async (t) => {
  const { service, model, client, one, list } = await fixture(t);
  const baseline = model.requests.length;
  const running = await client.startRun(script([start, clock], "hold"), "activity-resume");
  await waitForTest(() => model.requests.length >= baseline + 3, "running model after tool");
  const closed = model.slowClosed();
  const began = Date.now();
  assert.equal((await client.json("/api/conversation/stop", { spaceId: running.spaceId, runId: running.runId })).stopped, true);
  failed(await running.done);
  await waitForTest(() => model.slowClosed() > closed, "provider connection cancelled");
  assert.ok(Date.now() - began < 3000);
  const stopped = await one(running.spaceId);
  assert.equal(stopped.activity.status, "stopped");
  assertClosedSteps(stopped);
  succeeded(await client.run("ordinary hello", running.spaceId));
  assert.deepEqual(await one(running.spaceId), stopped);
  await service.restart();
  assert.deepEqual(await one(running.spaceId), stopped);
  succeeded(await client.run(script([activity("resume", { activityId: stopped.activity.id }), clock, complete]), running.spaceId));
  const resumed = await one(running.spaceId);
  assert.equal(resumed.activity.id, stopped.activity.id);
  assert.equal(resumed.activity.status, "completed");
  assert.equal(resumed.activity.runIds.length, 2);
  assert.deepEqual(resumed.steps.slice(0, stopped.steps.length), stopped.steps);
  assertClosedSteps(resumed);
  assert.equal((await list()).activities.length, 1);
});

for (const reason of ["timeout", "disconnect", "shutdown", "crash"] as const) {
  test(`activity e2e: ${reason} settles honestly and restart never reruns the interrupted activity`, async (t) => {
    // 故意挂起的请求仍必须触发真实超时；预算同时要容纳重启后正常 resume 的模型/落盘步骤。
    const { service, model, client, one } = await fixture(t, { runTimeoutMs: reason === "timeout" ? 10_000 : 30_000 });
    const baseline = model.requests.length;
    const running = await client.startRun(script([start], "hold"), "activity-lifecycle");
    await waitForTest(() => model.requests.length >= baseline + 2, "in-flight activity model");
    const runningState = await one(running.spaceId);
    assert.equal(runningState.activity.status, "running");
    if (reason === "disconnect") await running.cancel();
    else if (reason === "shutdown") await service.stop();
    else if (reason === "crash") await service.crash();
    if (reason === "disconnect" || reason === "crash") await assert.rejects(running.done);
    else {
      const events = await running.done;
      failed(events);
      if (reason === "timeout") assert.ok(events.some((event) => event.type === "RUN_ERROR" && event.code === "TIMEOUT"));
    }
    const count = model.requests.length;
    if (reason === "shutdown" || reason === "crash") await service.start();
    else await service.restart();
    const after = await one(running.spaceId);
    assert.equal(after.activity.id, runningState.activity.id);
    assert.equal(after.activity.status, reason === "timeout" ? "failed" : reason === "disconnect" ? "stopped" : "interrupted");
    assert.equal(after.activity.result, null);
    assert.equal(after.activity.currentRunId, null);
    if (reason === "crash") {
      assert.equal(after.activity.finishedAt, null);
      for (const step of after.steps.filter((step) => step.status === "interrupted")) {
        assert.equal(step.finishedAt, null, "crash has no trustworthy end timestamp");
      }
    }
    assert.equal(model.requests.length, count);
    const bytes = await sessionBytes(service.dataDir, running.spaceId);
    assert.deepEqual(await one(running.spaceId), after);
    assert.deepEqual(await sessionBytes(service.dataDir, running.spaceId), bytes, "read-only interrupted projection must not append");
    succeeded(await client.run(script([activity("resume", { activityId: after.activity.id }), complete]), running.spaceId));
    const resumed = await one(running.spaceId);
    assert.equal(resumed.activity.status, "completed");
    assertClosedSteps(resumed);
    assert.deepEqual(resumed.steps.slice(0, after.steps.length), after.steps);
  });
}

for (const decision of ["approve", "deny", "expire", "cancel", "conflict"] as const) {
  test(`activity e2e: file approval ${decision} separates authorization from actual commit`, async (t) => {
    const { service, client, one } = await fixture(t, { actionTimeoutMs: decision === "expire" ? 600 : 30_000 });
    const path = "report.md";
    const content = "FULL-APPROVAL-CONTENT\n" + "complete preview\n".repeat(100);
    const running = await client.startRun(script([start, { name: "write", args: { path, content } }]), "activity-approval");
    const action = await waitForTest(async () => (await client.pending()).find((item) => item.runId === running.runId), "file approval");
    assert.equal(action.spaceId, running.spaceId);
    assert.equal(action.preview.path, path);
    assert.equal(action.preview.after, content);
    assert.equal(action.preview.before, "");
    assert.equal(action.preview.beforeExists, false);
    const target = join(service.dataDir, "workspace/threads", running.spaceId, path);
    await assert.rejects(stat(target), { code: "ENOENT" });
    const waiting = await one(running.spaceId);
    assert.equal(waiting.activity.status, "waiting_approval");
    assert.equal(action.activityId, waiting.activity.id);
    assert.equal(action.execution, null);
    const approval = waiting.steps.find((step) => step.kind === "approval");
    const tool = waiting.steps.find((step) => step.kind === "tool");
    assert.ok(approval && tool);
    assert.equal(approval.parentId, tool.id);
    assert.doesNotMatch(JSON.stringify(waiting), /FULL-APPROVAL-CONTENT|complete preview|report\.md/);
    if (decision === "cancel") {
      await client.json("/api/conversation/stop", { spaceId: running.spaceId, runId: running.runId });
      failed(await running.done);
    } else {
      if (decision === "conflict") await writeFile(target, "EXTERNAL-CONTENT", { mode: 0o600 });
      if (decision !== "expire")
        assert.equal((await client.decideApproval(action.id, decision === "deny" ? "deny" : "approve")).status, 200);
      succeeded(await running.done);
    }
    const result = await one(running.spaceId);
    assertClosedSteps(result);
    const expected = decision === "approve" ? "succeeded" : decision === "deny" ? "denied" : decision === "expire" ? "expired" : decision === "cancel" ? "cancelled" : "succeeded";
    assert.equal(result.steps.find((step) => step.kind === "approval")?.status, expected);
    const commit = result.steps.find((step) => step.kind === "file_commit");
    assert.ok(commit);
    assert.equal(commit.status, decision === "approve" ? "succeeded" : "denied");
    if (decision === "approve") assert.equal(await readFile(target, "utf8"), content);
    else if (decision === "conflict") assert.equal(await readFile(target, "utf8"), "EXTERNAL-CONTENT");
    else await assert.rejects(stat(target), { code: "ENOENT" });
    assert.equal(result.activity.status, decision === "cancel" ? "stopped" : "awaiting_continuation");
    const settled = await client.json(`/api/approvals/${action.id}`);
    assert.equal(settled.execution?.status ?? null, decision === "approve" ? "succeeded" : decision === "conflict" ? "failed" : null);
    assert.equal(settled.revision, decision === "approve" || decision === "conflict" ? 4 : 2);
    assert.equal(settled.preview.after, content);
    if (decision === "approve") {
      assert.equal((await client.decideApproval(action.id, "approve")).status, 200);
      await service.restart();
      assert.deepEqual(await client.json(`/api/approvals/${action.id}`), settled);
      assert.equal(await readFile(target, "utf8"), content);
    }
  });
}

test("activity e2e: child model and tool steps nest under the parent invocation without granting activity capability", async (t) => {
  const { service, model, client, one, list } = await fixture(t);
  succeeded(await client.run(script([start, { name: "subagent", args: { tasks: [
    { agent: "worker", task: "E2E clock A" }, { agent: "reviewer", task: "E2E clock B" },
  ] } }, complete]), "activity-child"));
  const result = await one("activity-child");
  assert.equal(result.activity.status, "completed");
  const parent = result.steps.find((step) => step.kind === "tool" && step.title.includes("subagent"));
  assert.ok(parent);
  const children = result.steps.filter((step) => step.kind === "subagent");
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.parentId, parent.id);
    assert.ok(result.steps.some((step) => step.kind === "model" && step.parentId === child.id));
    assert.ok(result.steps.some((step) => step.kind === "tool" && step.parentId === child.id));
  }
  assertClosedSteps(result);
  const childRequests = model.requests.filter((request) => JSON.stringify(request.messages.filter((message) => message.role === "system")).includes("## Subagent role"));
  assert.ok(childRequests.length >= 4);
  for (const request of childRequests) assert.ok(!(request.tools as { function: { name: string } }[]).some((tool) => ["activity", "bash", "subagent"].includes(tool.function.name)));
  assert.equal((await list()).activities.length, 1);
  assert.ok((await readdir(join(service.dataDir, "sessions"))).every((name) => !name.startsWith("subagent-")));
});

for (const decision of ["approve", "cancel"] as const) {
  test(`activity e2e: child approval ${decision} stays nested in the parent activity and preserves filesystem truth`, async (t) => {
    const { service, client, one } = await fixture(t);
    const running = await client.startRun(script([start, { name: "subagent", args: { agent: "worker", task: "帮我写入草稿" } }]), "activity-child-approval");
    const action = await waitForTest(async () => (await client.pending()).find((item) => item.runId === running.runId), "child approval in activity");
    assert.equal(action.spaceId, running.spaceId);
    // 子代理发起的审批预览仍指向真实文件作用域；归属字段由服务端既有装配决定，
    // 这里只断言本测试关心的作用域与完整内容，不推断子会话/父会话归属。
    assert.ok(action.preview.scope === "space");
    const waiting = await one(running.spaceId);
    assert.equal(waiting.activity.status, "waiting_approval");
    const approval = waiting.steps.find((step) => step.kind === "approval")!;
    const write = waiting.steps.find((step) => step.id === approval.parentId)!;
    const child = waiting.steps.find((step) => step.id === write.parentId)!;
    assert.equal(write.kind, "tool");
    assert.equal(child.kind, "subagent");
    const childDirectory = (await readdir(join(service.dataDir, "workspace/threads"))).find((name) => name.startsWith("subagent-"));
    assert.ok(childDirectory);
    const target = join(service.dataDir, "workspace/threads", childDirectory, "draft.md");
    await assert.rejects(stat(target), { code: "ENOENT" });
    if (decision === "approve") {
      await client.decideApproval(action.id, "approve");
      succeeded(await running.done);
      assert.equal(await readFile(target, "utf8"), action.preview.after);
    } else {
      await client.json("/api/conversation/stop", { spaceId: running.spaceId, runId: running.runId });
      failed(await running.done);
      await assert.rejects(stat(target), { code: "ENOENT" });
    }
    const result = await one(running.spaceId);
    assertClosedSteps(result);
    assert.equal(result.steps.find((step) => step.kind === "approval")?.status, decision === "approve" ? "succeeded" : "cancelled");
    assert.equal(result.activity.status, decision === "approve" ? "awaiting_continuation" : "stopped");
  });
}

test("activity e2e: hidden tool observations retain safe facts without names, arguments or file contents", async (t) => {
  const { client, one } = await fixture(t, { hiddenTools: ["currentTime", "read"] });
  const events = await client.run(script([start, clock, { name: "read", args: { path: "missing-secret.md" } }, complete]), "activity-hidden");
  succeeded(events);
  assert.ok(!events.some((event) => event.type === "TOOL_CALL_START" && ["currentTime", "read"].includes(event.toolCallName)));
  const result = await one("activity-hidden");
  assert.equal(result.steps.filter((step) => step.kind === "tool").length, 2);
  assert.doesNotMatch(JSON.stringify(result), /currentTime|missing-secret|\bISO\b/);
  assertClosedSteps(result);
});

test("activity e2e: cross-thread and completed resumes are refused; no HTTP activity write API exists", async (t) => {
  const { client, model, one, list } = await fixture(t);
  succeeded(await client.run(script([start, complete]), "activity-owner"));
  const original = await one("activity-owner");
  for (const spaceId of ["activity-other", "activity-owner"]) {
    const events = await client.run(script([activity("resume", { activityId: original.activity.id })]), spaceId);
    succeeded(events);
    const actualResults = model.requests.at(-1)!.messages.filter((message) => message.role === "tool");
    assert.match(JSON.stringify(actualResults), spaceId === "activity-other" ? /Activity not found in this conversation/ : /Activity cannot be resumed/);
    assert.deepEqual(await one("activity-owner"), original);
  }
  assert.equal((await list()).activities.length, 1);
  const spec = await client.json("/openapi.json");
  assert.deepEqual(Object.keys(spec.paths["/api/activities"]), ["get"]);
  assert.deepEqual(Object.keys(spec.paths["/api/activities/{id}"]), ["get"]);
  assert.equal((await client.request("/api/activities", { title: "cannot create" })).status, 501);
});

test("activity e2e: cursor pagination, filters, malformed queries and deletion/recreation preserve authoritative truth", async (t) => {
  const { service, client, list, one } = await fixture(t);
  for (const thread of ["activity-page-a", "activity-page-b"]) {
    for (let index = 0; index < 3; index++) succeeded(await client.run(script([start, ...(index === 1 ? [] : [complete])]), thread));
  }
  // 离线只调整排序时间：用真实生成的 JSONL 验证同毫秒全序与超过七天的留存，
  // 不在运行时开第二个 writer，也不伪造工具执行或完成状态。
  await service.stop();
  for (const spaceId of ["activity-page-a", "activity-page-b"]) {
    for (const file of await sessionFiles(service.dataDir, spaceId)) {
      const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === "pi-muse.activity" && entry.data.kind === "overview") entry.data.activity.createdAt = "2020-01-01T00:00:00.000Z";
      }
      await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
  }
  await service.start();
  const all = (await list()).activities;
  assert.equal(all.length, 6);
  assert.ok(all.every((item) => item.createdAt === "2020-01-01T00:00:00.000Z"));
  assert.deepEqual(all.map((item) => item.id), all.map((item) => item.id).sort().reverse());
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    ids.push(...page.activities.map((item) => item.id));
    assert.equal(page.hasMore, page.nextCursor !== null);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, all.map((item) => item.id));
  assert.equal(new Set(ids).size, 6);
  assert.equal((await list("?spaceId=activity-page-a")).activities.length, 3);
  assert.equal((await list("?status=awaiting_continuation")).activities.length, 2);
  const filtered = await list("?spaceId=activity-page-a&status=completed&limit=1");
  assert.ok(filtered.nextCursor);
  for (const query of ["?limit=0", "?limit=101", "?limit=1.5", "?limit=", "?limit=abc", "?limit=1&limit=2", "?unknown=1", "?cursor=invalid!", "?spaceId=../bad", "?status=unknown",
    `?spaceId=activity-page-b&status=completed&cursor=${filtered.nextCursor}`]) {
    assert.equal((await client.request("/api/activities" + query)).status, 400, query);
  }
  const removed = all.filter((item) => item.spaceId === "activity-page-a");
  await writeFile(join(service.dataDir, "workspace/shared/kept.md"), "SHARED-SURVIVES", { mode: 0o600 });
  await client.json("/api/spaces/activity-page-a", undefined, "DELETE");
  assert.deepEqual((await list("?spaceId=activity-page-a")).activities, []);
  for (const item of removed) assert.equal((await client.request(`/api/activities/${item.id}`)).status, 404);
  await assert.rejects(stat(join(service.dataDir, "sessions/activity-page-a")), { code: "ENOENT" });
  assert.equal(await readFile(join(service.dataDir, "workspace/shared/kept.md"), "utf8"), "SHARED-SURVIVES");
  succeeded(await client.run(script([start, complete]), "activity-page-a"));
  const replacement = await one("activity-page-a");
  assert.ok(!removed.some((item) => item.id === replacement.activity.id));
  await service.restart();
  assert.deepEqual(await one("activity-page-a"), replacement);
  for (const item of removed) assert.equal((await client.request(`/api/activities/${item.id}`)).status, 404);
});

test("activity e2e: deleting an in-flight activity cancels its provider and cannot revive records on late Stop or queries", async (t) => {
  const { service, model, client, one, list } = await fixture(t);
  const baseline = model.requests.length;
  const running = await client.startRun(script([start], "hold"), "activity-deleting");
  await waitForTest(() => model.requests.length >= baseline + 2, "in-flight activity to delete");
  const record = await one(running.spaceId);
  const disconnected = model.slowClosed();
  await client.json(`/api/spaces/${running.spaceId}`, undefined, "DELETE");
  failed(await running.done);
  await waitForTest(() => model.slowClosed() > disconnected, "deleted activity provider disconnect");
  assert.equal((await client.request(`/api/activities/${record.activity.id}`)).status, 404);
  assert.deepEqual((await list(`?spaceId=${running.spaceId}`)).activities, []);
  assert.deepEqual(await client.json("/api/conversation/stop", { spaceId: running.spaceId, runId: running.runId }), { stopped: false });
  await assert.rejects(stat(join(service.dataDir, "sessions", running.spaceId)), { code: "ENOENT" });
  await service.restart();
  assert.equal((await client.request(`/api/activities/${record.activity.id}`)).status, 404);
  assert.ok(!(await client.json("/api/spaces")).spaces.some((space: { id: string }) => space.id === running.spaceId));
});

test("activity e2e: invalid persisted custom entries fail closed instead of disappearing from list or detail", async (t) => {
  const { service, client, one } = await fixture(t);
  succeeded(await client.run(script([start, complete]), "activity-corrupt"));
  const result = await one("activity-corrupt");
  await service.stop();
  const [file] = await sessionFiles(service.dataDir, "activity-corrupt");
  const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const entry = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-muse.activity");
  assert.ok(entry);
  entry.data.activity.status = "invalid-state";
  await writeFile(file, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const before = await readFile(file, "utf8");
  await service.start();
  for (const path of ["/api/activities", `/api/activities/${result.activity.id}`]) {
    const response = await client.request(path);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /invalid-state|stack|activity-corrupt/);
  }
  assert.equal(await readFile(file, "utf8"), before, "corrupt record must never be repaired or removed implicitly");
});
