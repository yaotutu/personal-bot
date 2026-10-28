# noVNC Viewer Control Bridge

`assets/browser/viewer-bridge.js` 是 noVNC 外部工具条与 viewer 页面之间的非视觉协议核心。它提供命令校验、iframe/RN 消息封装、状态事件分发和受控错误回执；调用方不需要接触 RFB 连接、noVNC 内部对象或 DOM 工具条实现。

该桥只控制当前 noVNC viewer 页面，不提供服务端截图，也不能控制宿主设备的屏幕、窗口或跨域页面。

## 页面接入 {#page-integration}

viewer 页面以 ES module 引入：

```html
<script type="module" src="/viewer-bridge.js"></script>
```

页面代码提供一个最小 adapter：

```js
import { createViewerBridge } from "./viewer-bridge.js";

const adapter = {
  // command 与 args 已通过桥的 allowlist 校验。
  execute(command, args) {
    if (!rfbConnection) {
      throw Object.assign(new Error("not connected"), { code: "NOT_CONNECTED" });
    }
    return viewerAdapter.execute(command, args);
  },
  // 只返回可安全发送到宿主 UI 的 JSON 数据；不要返回 RFB、DOM、token 或凭据。
  getState() {
    return {
      connected: viewerAdapter.connected,
      toolbarVisible: toolbar.visible,
      viewportMode: viewport.mode,
    };
  },
  subscribe(listener) {
    return viewerAdapter.onStateOrClipboardChange(listener);
  },
};

const viewer = createViewerBridge(adapter);
window.piMuseViewer = viewer; // createViewerBridge 内部也会完成这一步。
```

`createViewerBridge(adapter, options)` 目前只支持 `options.window`，默认使用当前 `window`。返回值包含：

- `dispatch(command, args={}) -> Promise<result>`：页面内调用。adapter 在 `dispatch` 的同步阶段被立即调用，以尽量保留浏览器用户手势。
- `getState()`：读取当前可序列化公开状态。
- `subscribe(listener) -> unsubscribe`：订阅时获得一次当前 `ready` 快照，之后接收 state/clipboard 事件 envelope；不接收命令 result 回执。
- `receive(serializedOrObject)`：接收外部 command；RN 原生侧可传入 JSON 字符串。
- `dispose()`：移除 message 监听、取消 adapter 订阅，并避免卸载后继续通知。

外部 transport 错过初始 `ready` 时，发送 `state.get` 重新读取状态；桥不会重放历史 state/clipboard 事件。

内置桌面/手机 adapter 的公开 state 固定为：

```json
{
  "connection": "connecting | connected | disconnecting | disconnected | error",
  "toolbarVisible": true,
  "keyboardVisible": false,
  "viewportMode": "scale | clip | native",
  "drag": false,
  "viewOnly": false,
  "fullscreen": false,
  "desktopName": "",
  "capabilities": {
    "commands": ["state.get", "connect", "disconnect", "reconnect", "focus", "toolbar.set", "keyboard.set", "key.send", "text.send", "clipboard.set", "viewport.set", "viewOnly.set", "fullscreen.set"],
    "keyboardRequiresGesture": true,
    "fullscreenRequiresGesture": true
  }
}
```

## 命令 {#commands}

未知命令、未知字段和错误类型都会被拒绝。所有参数对象必须是普通 JSON object，数组不是合法参数对象。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `state.get` | `{}` | 桥内部读取 `adapter.getState()`，不会传给 `adapter.execute()`。 |
| `connect` | `{}` | 建立或恢复 RFB 连接。 |
| `disconnect` | `{}` | 断开连接。 |
| `reconnect` | `{}` | 重新连接。 |
| `focus` | `{}` | 聚焦 viewer 输入区域。 |
| `toolbar.set` | `{visible:boolean}` | 显示或隐藏 noVNC 内建工具条。外部替换工具条时通常设置为 `false`。 |
| `keyboard.set` | `{visible:boolean}` | 显示或隐藏键盘能力；平台限制见下文。 |
| `key.send` | `{keysym:integer, code?:string, down?:boolean}` | 发送 RFB keysym。`keysym` 为 `1..0x1fffffff` 的整数；`code` 最长 64 字符。 |
| `text.send` | `{text:string}` | 发送文本，最长 10000 字符。 |
| `clipboard.set` | `{text:string}` | 设置远端剪贴板，最长 10000 字符。 |
| `viewport.set` | `{mode:'scale'|'clip'|'native', drag?:boolean}` | 设置视口模式与拖拽行为。 |
| `viewOnly.set` | `{enabled:boolean}` | 开启或关闭只读模式。 |
| `fullscreen.set` | `{enabled:boolean}` | 请求进入或退出 fullscreen；平台限制见下文。 |

未连接、能力不存在或需要用户手势时，adapter 应抛出带 `code` 的 `Error`。桥只透出固定错误码和固定文案，不透传 adapter 的原始异常文本或 stack。

| `code` | 含义 |
| --- | --- |
| `UNKNOWN_COMMAND` | 命令不在 allowlist。 |
| `INVALID_ARGUMENT` | 字段缺失、字段多余或类型/长度/取值不合法。 |
| `NOT_CONNECTED` | viewer 尚未连接。 |
| `UNSUPPORTED` | 当前页面、平台或 adapter 不支持该能力。 |
| `USER_GESTURE_REQUIRED` | 浏览器或原生层要求真实用户手势。 |
| `OPERATION_FAILED` | 其他执行失败，或 adapter 状态无法序列化。 |

## 传输格式 {#transport-format}

所有方向都使用 `channel: "pi-muse-viewer"`、`version: 1`。顶层只允许契约列出的字段，未知字段会被拒绝。

### Command {#command}

```json
{
  "channel": "pi-muse-viewer",
  "version": 1,
  "type": "command",
  "id": "unique-command-id",
  "command": "key.send",
  "args": { "keysym": 97, "code": "KeyA", "down": true }
}
```

`id` 必须由外部调用方生成且保持唯一。桥会记住最近 128 个 id；已记住的重复 command 会被忽略，不会再次执行或再次发送 result。桥不做自动重试或 command 重放。

### Result {#result}

```json
{
  "channel": "pi-muse-viewer",
  "version": 1,
  "type": "result",
  "id": "unique-command-id",
  "ok": true,
  "result": null
}
```

失败回执固定为：

```json
{
  "channel": "pi-muse-viewer",
  "version": 1,
  "type": "result",
  "id": "unique-command-id",
  "ok": false,
  "error": {
    "code": "NOT_CONNECTED",
    "message": "Viewer is not connected."
  }
}
```

`result` 必须可 JSON 序列化；`undefined` 序列化为 `null`。异步执行失败同样只返回受控错误对象。

### Event {#event}

```json
{
  "channel": "pi-muse-viewer",
  "version": 1,
  "type": "event",
  "event": "state",
  "data": { "connection": "connected", "toolbarVisible": false }
}
```

事件名只有：

- `ready`：桥创建完成，`data` 为当前 state。
- `state`：公开状态变化。
- `clipboard`：远端剪贴板内容变化。

`data` 会经过 JSON 序列化检查。adapter 必须在源头避免放入 RFB、DOM、token、模型 key 或其他凭据。

## iframe 宿主 {#iframe-host}

viewer 作为 iframe 时，桥只处理满足以下条件的浏览器 `message`：

1. `event.source === window.parent`；
2. `event.origin` 等于配置的 parent origin；
3. `event.data` 是本协议 command，或其 JSON 字符串。

parent origin 从 viewer URL 的 query 或 hash 参数 `parentOrigin` 读取；未提供时使用 viewer 页面自身的 `location.origin`，因此只允许同源父页面。值必须是精确 `http://` 或 `https://` origin；`*`、`null`、非 HTTP(S)、带路径或非标准写法都会拒绝。桥输出时也始终调用 `parent.postMessage(envelope, exactOrigin)`，不会使用 `*`。

示例 iframe 地址：

```text
https://viewer.example.test/vnc.html?parentOrigin=https%3A%2F%2Fapp.example.test&toolbar=hidden&layout=mobile
```

宿主侧示例：

```js
const viewerOrigin = new URL("https://viewer.example.test");
const iframe = document.querySelector("iframe");

function send(command) {
  iframe.contentWindow.postMessage({
    channel: "pi-muse-viewer",
    version: 1,
    type: "command",
    id: crypto.randomUUID(),
    ...command,
  }, viewerOrigin.origin);
}

window.addEventListener("message", (event) => {
  if (event.origin !== viewerOrigin.origin) return;
  const message = event.data;
  if (message?.channel !== "pi-muse-viewer" || message.version !== 1) return;

  if (message.type === "event" && message.event === "ready") {
    send({ command: "toolbar.set", args: { visible: false } });
    send({ command: "state.get", args: {} });
  }
});

send({ command: "connect", args: {} });
```

注意父页面发给 iframe 的 `postMessage` target origin 是 viewer origin；桥回传给父页面的 target origin 是 `parentOrigin`。两个方向不要混用。

`toolbar=hidden` 与 `layout=desktop|mobile|auto` 是 viewer 页面 UI 的启动参数，由页面/adapter 层实现；协议核心本身只解析 `parentOrigin`，不读取或改写其他 URL 参数。

## React Native 宿主 {#react-native-host}

在 RN WebView 内检测到 `window.ReactNativeWebView.postMessage` 时，桥的所有 event/result 均输出为 JSON 字符串：

```js
window.ReactNativeWebView.postMessage(JSON.stringify(envelope));
```

原生入口调用：

```js
window.piMuseViewer.receive(JSON.stringify(command));
```

原生侧必须先把 command JSON 转义成合法 JavaScript 字符串字面量，再执行上面的表达式。不要拼接未转义的用户文本。RN 场景没有 iframe parent origin 检查，message 边界由 WebView 与原生通信负责。

## 键盘与全屏限制 {#keyboard-and-fullscreen-limits}

- `keyboard.set` 不是远端 X11 键盘开关的唯一保证；移动端软键盘通常还受 WebView 焦点、内容editable 状态、操作系统输入法和用户手势限制。adapter 不具备当前条件时应返回 `USER_GESTURE_REQUIRED` 或 `UNSUPPORTED`。
- `fullscreen.set` 受浏览器 Fullscreen API、WebView 原生配置和用户手势限制。iOS WebView 常需要原生容器配合，不能承诺等同于原生全屏。
- 这些命令只作用于 noVNC viewer 页面，不改变宿主设备屏幕方向、状态栏或其他应用窗口。

## 安全边界 {#security-boundaries}

- 桥不暴露 RFB 对象、noVNC 内部 API、DOM 节点、连接凭据或模型 key。
- 公开 state 只应描述 viewer 能力与 UI 状态，不包含敏感配置。
- 桥不读取 viewer URL 中的 VNC 密码，也不对 state 内容做关键词猜测式脱敏；敏感字段必须在 adapter 构造 state 时移除。
- 命令没有自动重试、断线重放或跨页面广播。
