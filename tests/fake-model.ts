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
    event({ role: "assistant" });
    if (last === "slow" || last === "disconnect") {
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
    // 工具闭环路径：触发词 + 请求声明了 currentTime 且本轮还没有工具结果时，
    // 流式返回 OpenAI tool_calls chunk，让真实 pi 执行工具后发起第二轮请求。
    // 只看最后一条 user 消息之后的 tool 消息，历史里的旧工具轮不算本轮。
    const declaresCurrentTime = (input.tools || []).some(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        ((tool as { function?: { name?: string } }).function?.name ===
          "currentTime" ||
          (tool as { name?: string }).name === "currentTime"),
    );
    const lastUserIndex = input.messages.findLastIndex((x) => x.role === "user");
    const pendingToolResult = input.messages
      .slice(lastUserIndex + 1)
      .find((x) => x.role === "tool" && x.content);
    if (declaresCurrentTime && /时间|几点/.test(last) && !pendingToolResult) {
      event({ role: "assistant" });
      event({
        tool_calls: [
          {
            index: 0,
            id: `call_currenttime_${++toolCallSeq}`,
            type: "function",
            function: { name: "currentTime", arguments: "" },
          },
        ],
      });
      event({
        tool_calls: [{ index: 0, function: { arguments: "{}" } }],
      });
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
      // 第二轮：模型读到工具结果后生成回答，模拟真实闭环的最终输出。
      const output = "time reply: " + text;
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
