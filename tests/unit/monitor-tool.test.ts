import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorTool } from "../../src/adapters/pi/tools/monitor.js";
import type { Monitor } from "../../src/features/monitors/types.js";

const createMockMonitors = () => {
  const items: Monitor[] = [];
  const calls: { method: string; args: unknown }[] = [];

  return {
    items,
    calls,
    service: {
      create: async (input: { url: string; condition: "change" | "contains"; originSpaceId?: string; title?: string; value?: string; intervalMinutes?: number }) => {
        calls.push({ method: "create", args: input });
        const m: Monitor = {
          id: "mon-123",
          title: input.title ?? input.url,
          url: input.url,
          condition: input.condition,
          value: input.value,
          intervalMinutes: input.intervalMinutes ?? 30,
          status: "active",
          createdAt: new Date().toISOString(),
          originSpaceId: input.originSpaceId,
          checks: 0,
        };
        items.push(m);
        return m;
      },
      list: async () => {
        calls.push({ method: "list", args: undefined });
        return items;
      },
      control: async (id: string, action: "pause" | "resume" | "stop") => {
        calls.push({ method: "control", args: { id, action } });
        const found = items.find((x) => x.id === id);
        if (!found) return { ok: false as const, code: "not_found" as const, message: "Monitor not found" };
        found.status = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
        return { ok: true as const, monitor: found };
      },
    },
  };
};

test("monitor tool schema: url is optional and not required for non-create actions", () => {
  const { service } = createMockMonitors();
  const tool = monitorTool(service, "space-1");

  const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
  // required 只能有 action，url 不得在 required 中
  assert.deepEqual(params.required, ["action"]);
  assert.ok(params.properties?.url);
});

test("monitor tool execute: create requires valid http(s) url", async () => {
  const { service, calls } = createMockMonitors();
  const tool = monitorTool(service, "space-1");

  // 1. 缺少 url 时拒绝
  const resNoUrl = await tool.execute("call-1", { action: "create" } as never, undefined, undefined, {} as never);
  assert.equal(resNoUrl.isError, true);
  assert.match(resNoUrl.content[0]?.type === "text" ? resNoUrl.content[0].text : "", /url must be a public http\(s\) URL/);
  assert.equal(calls.length, 0);

  // 2. 非 http(s) url 拒绝
  const resFtp = await tool.execute("call-2", { action: "create", url: "ftp://example.com" } as never, undefined, undefined, {} as never);
  assert.equal(resFtp.isError, true);
  assert.equal(calls.length, 0);

  // 3. 合法 http(s) url 成功创建
  const resOk = await tool.execute("call-3", { action: "create", url: "https://example.com/feed", title: "My Feed" } as never, undefined, undefined, {} as never);
  assert.equal(resOk.isError, undefined);
  assert.match(resOk.content[0]?.type === "text" ? resOk.content[0].text : "", /Monitor created \(id mon-123\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "create");
});

test("monitor tool execute: list/pause/resume/stop do not require url", async () => {
  const { service, items } = createMockMonitors();
  items.push({
    id: "m-1",
    title: "Site",
    url: "https://example.com",
    condition: "change",
    intervalMinutes: 10,
    status: "active",
    createdAt: new Date().toISOString(),
    checks: 1,
  });
  const tool = monitorTool(service, "space-1");

  // 1. list 无需 url
  const listRes = await tool.execute("call-list", { action: "list" } as never, undefined, undefined, {} as never);
  assert.equal(listRes.isError, undefined);
  assert.match(listRes.content[0]?.type === "text" ? listRes.content[0].text : "", /m-1 \[active\] Site/);

  // 2. pause 无需 url
  const pauseRes = await tool.execute("call-pause", { action: "pause", monitorId: "m-1" } as never, undefined, undefined, {} as never);
  assert.equal(pauseRes.isError, false);
  assert.match(pauseRes.content[0]?.type === "text" ? pauseRes.content[0].text : "", /paused/);

  // 3. resume 无需 url
  const resumeRes = await tool.execute("call-resume", { action: "resume", monitorId: "m-1" } as never, undefined, undefined, {} as never);
  assert.equal(resumeRes.isError, false);
  assert.match(resumeRes.content[0]?.type === "text" ? resumeRes.content[0].text : "", /resumed/);

  // 4. stop 无需 url
  const stopRes = await tool.execute("call-stop", { action: "stop", monitorId: "m-1" } as never, undefined, undefined, {} as never);
  assert.equal(stopRes.isError, false);
  assert.match(stopRes.content[0]?.type === "text" ? stopRes.content[0].text : "", /stopd/);

  // 5. 控制动作缺少 monitorId 报错
  const noIdRes = await tool.execute("call-noid", { action: "pause" } as never, undefined, undefined, {} as never);
  assert.equal(noIdRes.isError, true);
  assert.match(noIdRes.content[0]?.type === "text" ? noIdRes.content[0].text : "", /control needs monitorId/);
});
