import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserService } from "../features/browser/browser-service.js";

const writeUnauthorized = (socket: Duplex) => {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
};

/**
 * Hono 的 fetch 抽象不承载 HTTP upgrade；这里在 Node server 上处理 /ws/browser。
 * 长期 Bearer token 不进入 URL，只消费一次性的短时 ticket。
 * 返回升级 handler，由统一 dispatcher 挂到 server，保证与桌面 websockify 互不劫持。
 */
export const createBrowserUpgradeHandler = (
  browser: BrowserService | undefined,
) => {
  const sockets = new WebSocketServer({ noServer: true });
  const handle = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return false;
    }
    if (url.pathname !== "/ws/browser") return false;
    if (!browser?.consumeTicket(url.searchParams.get("ticket") ?? undefined)) {
      writeUnauthorized(socket);
      return true;
    }
    sockets.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      const attached = browser!.attachClient({
        sendText: (message) => websocket.send(message),
        sendBinary: (data) => websocket.send(data, { binary: true }),
        close: () => websocket.close(),
        bufferedAmount: () => websocket.bufferedAmount,
      });
      websocket.on("message", (data, isBinary) => {
        if (!isBinary) attached.handleMessage(data.toString());
      });
      websocket.on("close", attached.detach);
      websocket.on("error", () => attached.detach());
    });
    return true;
  };
  return {
    handle,
    close: () => {
      sockets.clients.forEach((client) => client.terminate());
      sockets.close();
    },
  };
};
