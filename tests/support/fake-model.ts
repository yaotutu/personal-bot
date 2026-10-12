import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export type ModelRequest = {
  model: string;
  messages: {
    role: string;
    content: unknown;
    tool_calls?: unknown[];
  }[];
  tools?: unknown[];
  [key: string]: unknown;
};
export async function createFakeModel() {
  const requests: ModelRequest[] = [];
  let slowClosed = 0;
  let failCount = 0;
  // 真实供应商的 tool call id 每次唯一；固定 id 会让多轮工具的历史关联错乱。
  let toolCallSeq = 0;
  // 记录本轮发起的工具调用 id → 工具名，第二轮按工具名生成不同回复。
  const toolCallNames = new Map<string, string>();
  const toolCall = (name: string, args: object) => {
    const id = `call_fake_${++toolCallSeq}`;
    toolCallNames.set(id, name);
    return {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    };
  };
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as ModelRequest;
    requests.push(input);
    const content = input.messages
      .filter((x) => x.role === "user")
      .at(-1)?.content;
    const last =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((x) => x.text || "").join("")
          : "";
    if (last === "fail-once" && failCount++ === 0) {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: {
              message: "Invalid API key test-secret-model-key",
              type: "invalid_api_key",
            },
          }),
        );
      return;
    }
    if (last === "freeze") {
      res.on("close", () => {
        slowClosed++;
      });
      return;
    }
    const lastUserIndex = input.messages.findLastIndex((x) => x.role === "user");
    const pendingToolResult = input.messages
      .slice(lastUserIndex + 1)
      .find((x) => x.role === "tool" && x.content);
    // 工具已经执行后再返回 401，用来验证 nanobot 式语义：副作用保留，
    // 最终模型回复失败只影响本轮输出，不回滚 memory/jobs。
    if (pendingToolResult && /工具后失败/.test(last)) {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_api_key" } }));
      return;
    }
    if (pendingToolResult && /工具后挂起/.test(last)) {
      res.on("close", () => { slowClosed++; });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (delta: object, reason: string | null = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: input.model,
            choices: [{ index: 0, delta, finish_reason: reason }],
          }) +
          "\n\n",
      );
    // pi 压缩的 summarization 请求：system 指令有固定签名。返回短摘要，
    // 避免回显对话导致压缩后仍超阈值而反复压缩。
    const systemText = String(
      input.messages.find((x) => x.role === "system")?.content ?? "",
    );
    if (systemText.includes("context summarization assistant")) {
      event({ role: "assistant" });
      event({
        content: "## Summary\n- User sent filler test rounds.\n- Assistant replied each round.",
      });
      event({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    event({ role: "assistant" });
    if (last === "slow" || last === "disconnect" || (pendingToolResult && /工具后慢流/.test(last))) {
      let ticks = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return;
        event({ content: "partial " });
        if (++ticks >= 200) {
          clearInterval(timer);
          event({}, "stop");
          res.end("data: [DONE]\n\n");
        }
      }, 20);
      res.on("close", () => {
        clearInterval(timer);
        slowClosed++;
      });
      return;
    }
    if (last === "broken") {
      event({ content: "fragment" });
      res.destroy();
      return;
    }
    if (last === "empty") {
      // 整个流没有有效内容或 finish_reason；不同于正常流中的 usage-only chunk。
      // nanobot 视为不完整响应，由真实 pi parser 决定本项目的执行终态。
      res.write("data: " + JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: input.model, choices: [] }) + "\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (last === "malformed") {
      // 独立模拟无法解析的 SSE 数据，确认 pi 适配层会结束本轮并释放会话。
      res.write("data: {not-json}\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    // 工具闭环路径：触发词 + 请求声明了对应工具且本轮还没有工具结果时，
    // 流式返回 OpenAI tool_calls chunk，让真实 pi 执行工具后发起第二轮请求。
    // 只看最后一条 user 消息之后的 tool 消息，历史里的旧工具轮不算本轮。
    const declaresTool = (name: string) =>
      (input.tools || []).some(
        (tool) =>
          typeof tool === "object" &&
          tool !== null &&
          ((tool as { function?: { name?: string } }).function?.name === name ||
            (tool as { name?: string }).name === name),
      );
    // 定时任务路径：触发词"提醒我" + 声明了 schedule 工具。测试用 15 秒后的一次性任务。
    if (declaresTool("schedule") && /提醒我/.test(last) && !pendingToolResult) {
      event({ role: "assistant" });
      event(
        toolCall("schedule", {
          action: "create",
          prompt: /喝水/.test(last) ? "提醒喝水" : last.replace(/^.*提醒我/, "").trim() || "提醒",
          at: new Date(Date.now() + 15_000).toISOString(),
        }),
      );
      event({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    // 定时触发轮（⏰ 前缀的会话轮）：直接回文本，模拟任务执行结果。
    if (/^⏰/.test(last)) {
      event({ role: "assistant" });
      event({ content: "JOB-RAN " + last.replace(/^⏰\s*/, "") });
      event({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    // 记忆工具路径：触发词"记住/忘掉" + 声明了 memory 工具。
    if (declaresTool("memory") && /记住|忘掉/.test(last) && !pendingToolResult) {
      const forget = /忘掉/.test(last);
      event({ role: "assistant" });
      event(
        toolCall(
          "memory",
          forget
            ? { action: "forget", keyword: last.replace(/^.*忘掉/, "").trim() }
            : { action: "remember", text: last.replace(/^.*记住/, "").trim() },
        ),
      );
      event({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    // 文件读取路径：触发词 + 请求声明了 read。测试用固定文件名与越界路径。
    if (declaresTool("read") && /读/.test(last) && !pendingToolResult) {
      const sensitive = /敏感|secret/.test(last);
      const match = last.match(/[\w./-]+\.(txt|md|json)/);
      event({ role: "assistant" });
      event(
        toolCall(
          "read",
          sensitive ? { path: "/etc/passwd" } : { path: match?.[0] || "notes.txt" },
        ),
      );
      event({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (declaresTool("currentTime") && /时间|几点/.test(last) && !pendingToolResult) {
      event({ role: "assistant" });
      event(toolCall("currentTime", {}));
      event({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (pendingToolResult) {
      const text =
        typeof pendingToolResult.content === "string"
          ? pendingToolResult.content
          : Array.isArray(pendingToolResult.content)
            ? pendingToolResult.content
                .map((x) => (x as { text?: string }).text || "")
                .join("")
            : "";
      // 第二轮：按工具名生成对应回答，模拟真实闭环的最终输出。
      const toolName =
        toolCallNames.get(
          String(
            (pendingToolResult as { tool_call_id?: string }).tool_call_id ?? "",
          ),
        ) ?? "unknown";
      const prefix =
        toolName === "read"
          ? "file reply: "
          : toolName === "memory"
            ? "memory reply: "
            : toolName === "schedule"
              ? "schedule reply: "
              : "time reply: ";
      const output = prefix + text;
      for (const part of [output.slice(0, 8), output.slice(8)])
        event({ content: part });
      event({}, "stop");
      res.end("data: [DONE]\n\n");
      return;
    }
    const userCount = input.messages.filter((x) => x.role === "user").length;
    const output = "reply: " + last + "; users=" + userCount;
    // 真正使用 OpenAI SSE 而非注入 pi mock：测试覆盖 pi 的 provider 解析与取消。
    for (const part of [output.slice(0, 8), output.slice(8)])
      event({ content: part });
    event({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl:
      "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1",
    requests,
    slowClosed: () => slowClosed,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
