import { createServer } from "node:http";
import { once } from "node:events";

export type CallTrace = {
  index: number; startedAt: number; endedAt?: number; child: boolean;
  users: string[]; toolNames: string[]; toolResults: string[];
  calls: { name: string; arguments: string }[]; output: string; disconnected: boolean;
};
const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((entry) => entry && typeof entry === "object" && "text" in entry ? String(entry.text) : "").join("") : "";
export const redactApiKey = (text: string, key?: string) => key ? text.split(key).join("[REDACTED]") : text;

/** 测试透明代理仅观察合成内容的工具事实，不保存鉴权头、供应商地址/错误正文或system原文。 */
export const createLiveModel = async (model: { baseUrl: string; apiKey?: string }) => {
  const traces: CallTrace[] = [];
  const active = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const work = (async () => {
      if (closing) { response.writeHead(503).end(); return; }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const abort = new AbortController();
      active.add(abort);
      const timeout = setTimeout(() => abort.abort(), 180_000);
      let trace: CallTrace | undefined;
      response.once("close", () => {
        if (!response.writableEnded) { if (trace) trace.disconnected = true; abort.abort(); }
      });
      try {
        let body = "";
        for await (const part of request) {
          body += part;
          if (Buffer.byteLength(body) > 1_048_576) throw new Error("Test model input too large");
        }
        if (traces.length >= 200) throw new Error("Test model request budget exceeded");
        const input = JSON.parse(body) as { messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string }; name?: string }[] };
        const messages = input.messages ?? [];
        trace = {
          index: traces.length, startedAt: Date.now(), child: messages.some((entry) => entry.role === "system" && textOf(entry.content).includes("## Subagent role")),
          users: messages.filter((entry) => entry.role === "user").map((entry) => textOf(entry.content).slice(0, 16_384)),
          toolNames: (input.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ""),
          toolResults: messages.filter((entry) => entry.role === "tool").map((entry) => textOf(entry.content).slice(0, 16_384)),
          calls: [], output: "", disconnected: false,
        };
        traces.push(trace);
        const upstream = await fetch(model.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
          body, signal: abort.signal,
        });
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel(); response.writeHead(502).end('{"error":"Live model request failed"}'); return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const calls = new Map<number, { name: string; arguments: string }>();
        let buffer = "";
        let delivered = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            delivered += chunk.value.byteLength;
            if (delivered > 1_048_576) throw new Error("Live stream budget exceeded");
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
              for (const line of frame.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                let event; try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
                for (const choice of event.choices ?? []) {
                  const delta = choice.delta ?? {};
                  if (typeof delta.content === "string") trace.output = (trace.output + delta.content).slice(0, 65_536);
                  for (const call of delta.tool_calls ?? []) {
                    const previous = calls.get(call.index) ?? { name: "", arguments: "" };
                    previous.name += call.function?.name ?? ""; previous.arguments += call.function?.arguments ?? "";
                    calls.set(call.index, previous);
                  }
                }
              }
            }
            response.write(chunk.value);
          }
        } finally {
          trace.calls = [...calls.values()];
          await reader.cancel().catch(() => undefined);
        }
        response.end();
      } catch {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      } finally {
        clearTimeout(timeout); abort.abort(); active.delete(abort);
        if (trace) trace.endedAt = Date.now();
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => undefined);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Live proxy address missing");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, traces,
    close: () => closing ??= (async () => {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
    })(),
  };
};
