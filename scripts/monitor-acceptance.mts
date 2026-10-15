// monitors 全流程本地验收：本地页面 server（内容可变）→ 创建监控 → 调度首检基线
// → 改内容 → 第二轮检查 → 📡 通知进入主聊天流。真实 HTTP 抓取 + 真实调度。
import { createServer } from "node:http";
import { once } from "node:events";
import { createConfig } from "../src/config/load-config.ts";
import { createService } from "../src/bootstrap/create-service.ts";
import { readFile } from "node:fs/promises";

let pageBody = "MONITOR-ACCEPT version-1 baseline content";
const target = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><body><main>${pageBody}</main></body></html>`);
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const pageUrl = "http://127.0.0.1:" + (target.address() as { port: number }).port + "/page.html";
console.log("[1] 本地目标页:", pageUrl);

const config = createConfig(JSON.parse(await readFile("/tmp/monitor-accept-config.json", "utf8")), { configFile: "/tmp/monitor-accept-config.json" });
const service = await createService(config);
const token = service.auth.login();
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// [2] 创建 change 监控（最小间隔 5 分钟；验收脚本直接拨回 lastCheckedAt 触发第二轮）
const res1 = await service.app.request("/api/agent/monitors", {
  method: "POST", headers: auth,
  body: JSON.stringify({ url: pageUrl, condition: "change", title: "本地验收页" }),
});
const monitor = (await res1.json()) as { id: string };
console.log("[2] 创建监控:", monitor.id.slice(0, 8), "change");

const waitNotified = async (label: string) => {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const main = await service.conversationHub.forThread("local-main");
    const hit = main.history().find((x) => String((x as { content?: string }).content ?? "").includes("📡"));
    if (hit) return String((hit as { content?: string }).content);
  }
  return undefined;
};

// [3] 首检（3s 扫描）建立基线，不应通知
await new Promise((r) => setTimeout(r, 5000));
const first = (await service.monitors.list()).find((x) => x.id === monitor.id)!;
console.log("[3] 首检: checks =", first.checks, "| error =", first.error ?? "无", "| 基线 =", first.lastFingerprint?.slice(0, 8));
if (first.error) throw new Error("首检失败: " + first.error);
const earlyNotify = await (async () => {
  const main = await service.conversationHub.forThread("local-main");
  return main.history().some((x) => String((x as { content?: string }).content ?? "").includes("📡"));
})();
console.log("[3] 基线期无通知:", !earlyNotify ? "✓" : "✗ 误报");

// [4] 改页面内容 + 拨回检查时间 → 第二轮 → 应通知
pageBody = "MONITOR-ACCEPT version-2 THE PAGE CHANGED";
await service.monitors.control(monitor.id, "pause"); // 稳住状态机
await service.monitors.control(monitor.id, "resume");
const raw = JSON.parse(await readFile(".personal-bot/monitor-acceptance/monitors.json", "utf8"));
raw.find((x: { id: string }) => x.id === monitor.id).lastCheckedAt = new Date(Date.now() - 3600_000).toISOString();
const { writeFile } = await import("node:fs/promises");
await writeFile(".personal-bot/monitor-acceptance/monitors.json", JSON.stringify(raw));
console.log("[4] 页面已改为 v2，拨回到期时间");

const notified = await waitNotified("v2");
console.log("[5] 📡 通知:", notified ? notified.slice(0, 160) : "（未收到——失败）");
await service.close();
target.close();
console.log(notified ? "\n=== 全流程验收通过 ===" : "\n=== 验收失败 ===");
process.exit(notified ? 0 : 1);
