import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserService } from "../features/browser/browser-service.js";

const writeUnauthorized = (socket: Duplex) => {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
};

/**
 * Hono 的 fetch 抽象不承载 HTTP upgrade；这里在 Node server 上挂 /ws/browser。
 * 长期 Bearer token 不进入 URL，只消费一次性的短时 ticket。
 */
export const attachBrowserWebSocket = (
  server: Server,
  browser: BrowserService | undefined,
) => {
  const sockets = new WebSocketServer({ noServer: true });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws/browser" ||
          !browser?.consumeTicket(url.searchParams.get("ticket") ?? undefined)) {
        writeUnauthorized(socket);
        return;
      }
    } catch {
      writeUnauthorized(socket);
      return;
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
  };
  server.on("upgrade", upgrade);
  return () => {
    server.off("upgrade", upgrade);
    sockets.clients.forEach((client) => client.terminate());
    sockets.close();
  };
};
