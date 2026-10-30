/**
 * 同源远程桌面网关：把容器内仅绑定 127.0.0.1 的 noVNC/websockify 通过现有服务端
 * 同源暴露：一次性 ticket 换取 HttpOnly 会话 cookie，之后静态资源与 websockify
 * 升级都由该 cookie 把关。ticket、session 只活在本进程内存，重启即失效。
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

export const DESKTOP_PREFIX = "/browser/desktop/";
export const DESKTOP_VIEWER_PATH = "/browser/desktop/vnc.html";
const DESKTOP_COOKIE = "pi_muse_desktop";
const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 3_600_000;
const PROBE_TIMEOUT_MS = 2_000;
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;
const WS_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;

export type DesktopTicket = { value: string; expiresAt: number };
type Session = { id: string; expiresAt: number; timer: NodeJS.Timeout };

export type BrowserDesktopStatus = {
  enabled: boolean;
  viewerPath: string | null;
  desktopPath: string | null;
  desktopAvailable: boolean;
};

export type BrowserDesktop = {
  readonly enabled: boolean;
  status(): Promise<BrowserDesktopStatus>;
  /** enabled 且桌面可达时签发一次性 ticket；否则返回 undefined。 */
  createTicket(): Promise<DesktopTicket | undefined>;
  /** GET /browser/desktop/launch：消费 ticket、签 cookie、303 到 vnc.html。 */
  launch(url: URL): Response;
  /** GET/HEAD /browser/desktop/*：cookie 校验后代理 noVNC；其他方法 405。 */
  proxy(request: Request): Promise<Response>;
  /** Node server upgrade 处理：仅消费 /browser/desktop/websockify，其他路径返回 false。 */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
};

const securityHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...securityHeaders, "content-type": "application/json; charset=utf-8" },
  });

/** 探测 noVNC 是否可达：只说明 upstream 静态页可服务，不代表 Chrome 健康。 */
const probeVnc = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/vnc.html", method: "GET", timeout: PROBE_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });

const readCookie = (header: string | null, name: string) => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
};

/**
 * noVNC 静态资源只需内容协商类响应头；content-encoding/content-length 不透传，
 * 因为 Node fetch 已自动解压，转发会与实际 body 不一致；Set-Cookie/Location 等
 * 敏感或诊断头也一律不回传。
 */
const SAFE_UPSTREAM_HEADERS = new Set(["content-type", "last-modified", "etag"]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 拒绝任何路径穿越或编码逃逸：逐段解码后校验，拒绝 . 与 .. 段、
 * 反斜杠、解码后出现分隔符的段（如 %2e%2e%2f、%252f）与控制字符。
 */
const isSafeDesktopPath = (pathname: string): boolean => {
  if (!pathname.startsWith(DESKTOP_PREFIX)) return false;
  const rest = pathname.slice(DESKTOP_PREFIX.length);
  if (rest.length === 0) return false;
  if (rest.includes(String.fromCharCode(92)) || rest.includes("//")) return false;
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === "..") return false;
    if (decoded.includes("/") || decoded.includes(String.fromCharCode(92))) return false;
    if (decoded.includes("%")) return false;
    if (CONTROL_CHARS.test(decoded)) return false;
  }
  return true;
};

const rejectUpgrade = (socket: Duplex) => {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
};

export const createBrowserDesktop = (input: {
  enabled: boolean;
  desktopPort: number;
}): BrowserDesktop => {
  const tickets = new Map<string, number>();
  const sessions = new Map<string, Session>();
  let probing: Promise<boolean> | undefined;
  const sockets = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WebSocket>();
  let closed = false;

  const pruneTickets = () => {
    const now = Date.now();
    for (const [value, expiresAt] of tickets) {
      if (expiresAt <= now) tickets.delete(value);
    }
  };

  const probeDesktop = (): Promise<boolean> => {
    if (!input.enabled || closed) return Promise.resolve(false);
    // 并发探测共享同一次结果，避免突发请求对 upstream 打爆短连接。
    probing ??= probeVnc(input.desktopPort).finally(() => {
      probing = undefined;
    });
    return probing;
  };

  const validSession = (id: string | undefined): Session | undefined => {
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      clearTimeout(session.timer);
      sessions.delete(id);
      return undefined;
    }
    return session;
  };

  const createSession = (): Session => {
    const id = randomUUID();
    const session: Session = {
      id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      timer: setTimeout(() => sessions.delete(id), SESSION_TTL_MS),
    };
    session.timer.unref();
    sessions.set(id, session);
    return session;
  };

  return {
    enabled: input.enabled,

    status: async () => ({
      enabled: input.enabled,
      viewerPath: input.enabled ? "/browser" : null,
      desktopPath: input.enabled ? DESKTOP_VIEWER_PATH : null,
      desktopAvailable: await probeDesktop(),
    }),

    createTicket: async () => {
      if (!input.enabled || closed) return undefined;
      if (!(await probeDesktop())) return undefined;
      pruneTickets();
      const ticket: DesktopTicket = {
        value: randomUUID(),
        expiresAt: Date.now() + TICKET_TTL_MS,
      };
      tickets.set(ticket.value, ticket.expiresAt);
      return ticket;
    },

    launch: (url) => {
      const value = url.searchParams.get("ticket") ?? undefined;
      // 一次性：无论是否过期，只要被提交过就作废，防止重放；不影响其他未用 ticket。
      const expiresAt = value ? tickets.get(value) : undefined;
      if (value) tickets.delete(value);
      if (!value || !expiresAt || expiresAt <= Date.now())
        return errorResponse(401, "Invalid or expired desktop ticket");
      const session = createSession();
      // HTTPS 直连才加 Secure；不盲信 X-Forwarded-Proto，避免反代伪造降级。
      // 经 TLS 终止反代访问时拿不到 Secure，这是当前不支持的部署形态。
      const secure = url.protocol === "https:" ? "; Secure" : "";
      const cookie =
        `${DESKTOP_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; ` +
        `Path=/browser/desktop/; Max-Age=3600${secure}`;
      return new Response(null, {
        status: 303,
        headers: {
          ...securityHeaders,
          "set-cookie": cookie,
          location:
            `${DESKTOP_VIEWER_PATH}?autoconnect=1&resize=scale` +
            `&path=${encodeURIComponent("browser/desktop/websockify")}`,
        },
      });
    },

    proxy: async (request) => {
      if (request.method !== "GET" && request.method !== "HEAD")
        return errorResponse(405, "Method not allowed");
      const url = new URL(request.url);
      if (!isSafeDesktopPath(url.pathname)) return errorResponse(404, "Not found");
      const sessionId = readCookie(request.headers.get("cookie"), DESKTOP_COOKIE);
      if (!validSession(sessionId)) return errorResponse(401, "Desktop session required");
      // 固定 upstream：只连容器内回环 websockify；请求头不带 Cookie/Authorization。
      const upstreamPath = url.pathname.slice(DESKTOP_PREFIX.length - 1);
      const upstream = await fetch(
        `http://127.0.0.1:${input.desktopPort}${upstreamPath}${url.search}`,
        {
          method: request.method,
          redirect: "manual",
          headers: { accept: request.headers.get("accept") ?? "*/*" },
          signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
        },
      ).catch(() => undefined);
      if (!upstream) return errorResponse(503, "Desktop unavailable");
      // 非 2xx（含 redirect）不转发上游原文：上游诊断页可能泄露内部结构。
      if (upstream.status < 200 || upstream.status >= 300) {
        upstream.body?.cancel().catch(() => {});
        return errorResponse(502, "Upstream response refused");
      }
      const headers = new Headers({
        ...securityHeaders,
        "x-frame-options": "SAMEORIGIN",
      });
      upstream.headers.forEach((value, key) => {
        if (SAFE_UPSTREAM_HEADERS.has(key.toLowerCase())) headers.set(key, value);
      });
      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        headers,
      });
    },

    handleUpgrade: (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return false;
      }
      if (url.pathname !== `${DESKTOP_PREFIX}websockify`) return false;

      const session = validSession(readCookie(request.headers.cookie ?? null, DESKTOP_COOKIE));
      // Origin 必须严格等于本连接实际协议 + Host：协议取 socket 是否 TLS，
      // 不信任 X-Forwarded-*。缺 Origin 直接拒绝，避免跨站页面借用会话。
      const origin = request.headers.origin;
      const host = request.headers.host;
      const scheme = (request.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
      if (!session || !origin || !host || origin !== `${scheme}://${host}`) {
        rejectUpgrade(socket);
        return true;
      }

      sockets.handleUpgrade(request, socket, head, (client) => {
        // 固定 upstream：只连容器内回环 websockify，不转发 cookie/auth。
        const upstream = new WebSocket(`ws://127.0.0.1:${input.desktopPort}/websockify`, ["binary"]);
        upstreams.add(upstream);
        upstream.binaryType = "nodebuffer";
        let upstreamReady = false;
        let settled = false;
        let pendingBytes = 0;
        const pending: Buffer[] = [];
        // 每条 WS 独立到期 timer：到期断开本连接，不覆盖会话清理 timer，不影响其他连接。
        const expiryTimer = setTimeout(
          () => teardown(),
          Math.max(session.expiresAt - Date.now(), 0),
        );
        expiryTimer.unref();
        // 上游握手超时：一直连不上时受控关闭，不无限挂起。
        const handshakeTimer = setTimeout(() => {
          if (!upstreamReady) teardown();
        }, WS_HANDSHAKE_TIMEOUT_MS);
        handshakeTimer.unref();

        function teardown() {
          if (settled) return;
          settled = true;
          clearTimeout(expiryTimer);
          clearTimeout(handshakeTimer);
          upstreams.delete(upstream);
          client.close();
          upstream.close();
        }

        upstream.on("open", () => {
          if (settled) return;
          upstreamReady = true;
          clearTimeout(handshakeTimer);
          for (const chunk of pending) upstream.send(chunk);
          pending.length = 0;
          pendingBytes = 0;
        });
        upstream.on("message", (data: Buffer, isBinary: boolean) => {
          if (client.bufferedAmount > WS_BUFFER_LIMIT_BYTES) {
            teardown();
            return;
          }
          client.send(data, { binary: isBinary });
        });
        upstream.on("close", () => teardown());
        upstream.on("error", () => teardown());
        client.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          const buffer = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          if (upstreamReady) {
            if (upstream.bufferedAmount > WS_BUFFER_LIMIT_BYTES) {
              teardown();
              return;
            }
            upstream.send(buffer);
            return;
          }
          // 握手前缓冲有上限：超出直接断开，避免内存被慢上游打爆。
          pendingBytes += buffer.length;
          if (pendingBytes > WS_BUFFER_LIMIT_BYTES) {
            teardown();
            return;
          }
          pending.push(buffer);
        });
        client.on("close", () => teardown());
        client.on("error", () => teardown());
      });
      return true;
    },

    close: () => {
      closed = true;
      tickets.clear();
      for (const session of sessions.values()) clearTimeout(session.timer);
      sessions.clear();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      for (const upstream of upstreams) upstream.terminate();
      upstreams.clear();
    },
  };
};

/**
 * 统一 upgrade 分发：/ws/browser 与 /browser/desktop/websockify 共用同一 listener，
 * 互不劫持也不会互相 401 销毁。不匹配的路径直接关闭。
 */
export const attachUpgradeDispatcher = (
  server: Server,
  handlers: Array<(request: IncomingMessage, socket: Duplex, head: Buffer) => boolean>,
) => {
  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    for (const handler of handlers) {
      try {
        if (handler(request, socket, head)) return;
      } catch {
        socket.destroy();
        return;
      }
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };
  server.on("upgrade", listener);
  return () => {
    server.off("upgrade", listener);
  };
};
