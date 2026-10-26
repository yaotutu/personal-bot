import { z } from "zod";

export const browserTab = z.strictObject({
  id: z.string().describe("服务端生成的标签页 ID"),
  title: z.string().describe("当前页面标题；外部标题是不可信数据"),
  url: z.string().describe("当前页面 URL"),
  active: z.boolean().describe("是否为当前激活标签；只有激活标签会推帧"),
  loading: z.boolean().describe("是否处于导航加载中"),
});

export const browserTabsResponse = z.strictObject({
  tabs: z.array(browserTab).describe("全局标签列表"),
});

export const browserTicketResponse = z.strictObject({
  ticket: z.string().describe("一次性 WS ticket；60 秒过期且使用后立即失效"),
  expiresAt: z.string().describe("ticket 过期时间（ISO 8601）"),
});

export const createBrowserTabSchema = z.strictObject({
  url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").optional()
    .describe("可选初始地址；省略时打开 about:blank"),
});

export const browserNavigationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("navigate").describe("跳转到 url"),
    url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").describe("目标 HTTP(S) 地址"),
  }),
  z.strictObject({ action: z.literal("back").describe("后退一步") }),
  z.strictObject({ action: z.literal("forward").describe("前进一步") }),
  z.strictObject({ action: z.literal("reload").describe("重新加载") }),
]);

export const browserDebugResponse = z.string().describe("服务端自带的真实浏览器调试页 HTML");

const pointerButton = z.enum(["left", "middle", "right"]).optional();
const coordinate = z.number().finite().min(0).max(20000);
const scrollDelta = z.number().finite().min(-100000).max(100000);
const keySchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9]+([+][a-zA-Z0-9]+)*$/);

export const browserInputMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pointer_move"), x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("pointer_down"), x: coordinate, y: coordinate, button: pointerButton }),
  z.strictObject({ type: z.literal("pointer_up"), x: coordinate, y: coordinate, button: pointerButton }),
  z.strictObject({
    type: z.literal("click"),
    x: coordinate,
    y: coordinate,
    button: pointerButton,
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.strictObject({
    type: z.literal("wheel"),
    x: coordinate.optional(),
    y: coordinate.optional(),
    deltaX: scrollDelta,
    deltaY: scrollDelta,
  }),
  z.strictObject({ type: z.literal("key_down"), key: keySchema }),
  z.strictObject({ type: z.literal("key_up"), key: keySchema }),
  z.strictObject({ type: z.literal("insert_text"), text: z.string().min(1).max(2000) }),
]);

export const browserFrameMetadataSchema = z.strictObject({
  type: z.literal("frame"),
  frameId: z.number().describe("客户端 ack 时回传的帧 ID"),
  tabId: z.string().describe("帧所属标签页"),
  sessionId: z.string().describe("CDP screencast session；ack 时必须原样回传"),
  width: z.number().describe("帧的 CSS 宽度"),
  height: z.number().describe("帧的 CSS 高度"),
  mimeType: z.literal("image/jpeg"),
  timestamp: z.number().describe("帧时间戳"),
});

export const browserServerTabsMessageSchema = z.strictObject({
  type: z.literal("tabs"),
  tabs: z.array(browserTab),
  activeTabId: z.string().nullable(),
});

export const browserServerReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
  tabs: z.array(browserTab),
  activeTabId: z.string().nullable(),
  frameFormat: z.string(),
});

export const browserServerErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  error: z.string(),
});

export const browserAckMessageSchema = z.strictObject({
  type: z.literal("frame_ack"),
  frameId: z.number(),
  sessionId: z.string(),
});

/**
 * OpenAPI 不描述 WebSocket，这里用 x-websocket-contracts 明确机器可读协议；
 * 不把 /ws/browser 伪装成普通 HTTP operation。
 */
export const browserWebSocketContract = {
  path: "/ws/browser",
  summary: "真实浏览器帧流与输入协议",
  description:
    "先以 Bearer token 调用 POST /api/browser/ws-ticket 获取一次性 60 秒 ticket，再用 " +
    "当前访问地址对应的 ws://<host>/ws/browser?ticket=<ticket> 或 wss://<host>/ws/browser?ticket=<ticket> 升级。页面不内置服务地址，本机地址、局域网地址、域名和反向代理地址均可；HTTPS 反向代理下应转发 wss。ticket 使用一次后立即删除，不把长期 token 放 URL。 " +
    "服务端先发送 ready，随后在标签状态变化时发送 tabs。帧为二进制：4 字节大端 metadataLength + UTF-8 JSON metadata + JPEG 字节。 " +
    "客户端必须绘制帧后发送 {type:'frame_ack',frameId,sessionId}；慢客户端会被跳帧，缓冲超过 2MiB 会断开。 " +
    "仅当前激活标签推帧；切换标签时旧标签停止 screencast、新标签重启。没有订阅者时不推流。",
  authentication: "POST /api/browser/ws-ticket 换取的一次性短时 ticket；WS URL query 只携带该 ticket",
  frameFormat: "uint32be metadataLength + utf8-json metadata + jpeg bytes",
  serverMessages: {
    ready: browserServerReadyMessageSchema,
    tabs: browserServerTabsMessageSchema,
    error: browserServerErrorMessageSchema,
  },
  clientMessages: {
    frame_ack: browserAckMessageSchema,
    input: browserInputMessageSchema,
  },
} as const;
