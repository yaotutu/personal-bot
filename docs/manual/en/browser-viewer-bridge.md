# noVNC Viewer Control Bridge

`assets/browser/viewer-bridge.js` is the non-visual protocol core between an external noVNC toolbar and the viewer page. It provides command validation, iframe/RN message encapsulation, state-event dispatch, and controlled error receipts. Callers do not need to touch the RFB connection, noVNC internals, or the DOM toolbar implementation.

The bridge controls only the current noVNC viewer page. It does not provide server-side screenshots and cannot control the host device's screen, windows, or cross-origin pages.

## Page Integration {#page-integration}

The viewer page imports it as an ES module:

```html
<script type="module" src="/viewer-bridge.js"></script>
```

The page code provides a minimal adapter:

```js
import { createViewerBridge } from "./viewer-bridge.js";

const adapter = {
  // command and args have already passed the bridge allowlist validation.
  execute(command, args) {
    if (!rfbConnection) {
      throw Object.assign(new Error("not connected"), { code: "NOT_CONNECTED" });
    }
    return viewerAdapter.execute(command, args);
  },
  // Return only JSON data that is safe to send to the host UI; never return RFB, DOM, token, or credential objects.
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
window.piMuseViewer = viewer; // createViewerBridge also performs this assignment internally.
```

`createViewerBridge(adapter, options)` currently supports only `options.window`; it defaults to the current `window`. The returned object contains:

- `dispatch(command, args={}) -> Promise<result>`: called within the page. The adapter is invoked synchronously during `dispatch` to preserve the browser user gesture where possible.
- `getState()`: reads the current serializable public state.
- `subscribe(listener) -> unsubscribe`: receives one current `ready` snapshot when subscribing, then receives state/clipboard event envelopes; it does not receive command result receipts.
- `receive(serializedOrObject)`: receives an external command; the native RN side may pass a JSON string.
- `dispose()`: removes message listeners, unsubscribes from the adapter, and avoids notifying after teardown.

When an external transport misses the initial `ready` event, send `state.get` to read state again; the bridge does not replay historical state/clipboard events.

The public state exposed by the built-in desktop/mobile adapters is fixed to:

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

## Commands {#commands}

Unknown commands, unknown fields, and invalid error types are rejected. Every parameter object must be a plain JSON object; arrays are not valid parameter objects.

| Command | Parameters | Description |
| --- | --- | --- |
| `state.get` | `{}` | The bridge internally calls `adapter.getState()`; it does not pass this command to `adapter.execute()`. |
| `connect` | `{}` | Establishes or restores the RFB connection. |
| `disconnect` | `{}` | Disconnects. |
| `reconnect` | `{}` | Reconnects. |
| `focus` | `{}` | Focuses the viewer input area. |
| `toolbar.set` | `{visible:boolean}` | Shows or hides the built-in noVNC toolbar. An external replacement toolbar normally sets this to `false`. |
| `keyboard.set` | `{visible:boolean}` | Shows or hides keyboard capability; see platform limits below. |
| `key.send` | `{keysym:integer, code?:string, down?:boolean}` | Sends an RFB keysym. `keysym` is an integer from `1` through `0x1fffffff`; `code` is at most 64 characters. |
| `text.send` | `{text:string}` | Sends text, at most 10000 characters. |
| `clipboard.set` | `{text:string}` | Sets the remote clipboard, at most 10000 characters. |
| `viewport.set` | `{mode:'scale'|'clip'|'native', drag?:boolean}` | Sets viewport mode and drag behavior. |
| `viewOnly.set` | `{enabled:boolean}` | Enables or disables read-only mode. |
| `fullscreen.set` | `{enabled:boolean}` | Requests entering or exiting fullscreen; see platform limits below. |

When not connected, when a capability is unavailable, or when a user gesture is required, the adapter should throw an `Error` with `code`. The bridge exposes only fixed error codes and fixed messages; it does not pass through the adapter's original exception text or stack.

| `code` | Meaning |
| --- | --- |
| `UNKNOWN_COMMAND` | The command is not in the allowlist. |
| `INVALID_ARGUMENT` | A field is missing or extra, or its type, length, or value is invalid. |
| `NOT_CONNECTED` | The viewer is not connected yet. |
| `UNSUPPORTED` | The current page, platform, or adapter does not support the capability. |
| `USER_GESTURE_REQUIRED` | The browser or native layer requires a real user gesture. |
| `OPERATION_FAILED` | Another execution failed, or adapter state could not be serialized. |

## Transport Format {#transport-format}

Every direction uses `channel: "pi-muse-viewer"` and `version: 1`. The top level allows only the fields listed by the contract; unknown fields are rejected.

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

The external caller must generate `id` and keep it unique. The bridge remembers the most recent 128 ids; a remembered duplicate command is ignored and is not executed or answered with another result. The bridge does not automatically retry or replay commands.

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

Failure receipts are fixed to:

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

`result` must be JSON serializable; `undefined` serializes as `null`. An asynchronous execution failure likewise returns only the controlled error object.

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

The only event names are:

- `ready`: the bridge has been created; `data` is the current state.
- `state`: public state changed.
- `clipboard`: the remote clipboard content changed.

`data` passes a JSON serialization check. The adapter must prevent RFB objects, DOM nodes, tokens, model keys, and other credentials from entering it at the source.

## iframe Host {#iframe-host}

When the viewer is embedded as an iframe, the bridge handles only browser `message` events that meet all of these conditions:

1. `event.source === window.parent`;
2. `event.origin` equals the configured parent origin;
3. `event.data` is a protocol command or its JSON string.

The parent origin is read from the `parentOrigin` query or hash parameter in the viewer URL. When omitted, the viewer page's own `location.origin` is used, so only same-origin parents are allowed. The value must be an exact `http://` or `https://` origin; `*`, `null`, non-HTTP(S), path-bearing, or non-standard forms are rejected. For output, the bridge also always calls `parent.postMessage(envelope, exactOrigin)` and never uses `*`.

Example iframe URL:

```text
https://viewer.example.test/vnc.html?parentOrigin=https%3A%2F%2Fapp.example.test&toolbar=hidden&layout=mobile
```

Host-side example:

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

Note that `postMessage` from the parent to the iframe uses the viewer origin as the target origin, while the bridge returning data to the parent uses `parentOrigin`. Do not interchange the two directions.

`toolbar=hidden` and `layout=desktop|mobile|auto` are startup parameters for the viewer page UI and are implemented by the page/adapter layer. The protocol core itself parses only `parentOrigin`; it does not read or rewrite other URL parameters.

## React Native Host {#react-native-host}

When `window.ReactNativeWebView.postMessage` is detected in an RN WebView, the bridge outputs every event/result as a JSON string:

```js
window.ReactNativeWebView.postMessage(JSON.stringify(envelope));
```

The native entry point calls:

```js
window.piMuseViewer.receive(JSON.stringify(command));
```

The native side must first escape the command JSON into a valid JavaScript string literal before evaluating the expression above. Do not concatenate unescaped user text. The RN case has no iframe parent-origin check; the WebView-to-native communication boundary is responsible for the message boundary.

## Keyboard and Fullscreen Limits {#keyboard-and-fullscreen-limits}

- `keyboard.set` is not the sole guarantee for switching the remote X11 keyboard. A mobile soft keyboard is also constrained by WebView focus, contenteditable state, the operating-system input method, and user gestures. When these conditions are not present, the adapter should return `USER_GESTURE_REQUIRED` or `UNSUPPORTED`.
- `fullscreen.set` is constrained by the browser Fullscreen API, WebView native configuration, and user gestures. iOS WebViews often require cooperation from the native container, so it cannot promise equivalence to native fullscreen.
- These commands affect only the noVNC viewer page; they do not change the host device's screen orientation, status bar, or other application windows.

## Security Boundaries {#security-boundaries}

- The bridge does not expose RFB objects, noVNC internal APIs, DOM nodes, connection credentials, or model keys.
- Public state should describe only viewer capabilities and UI state, never sensitive configuration.
- The bridge does not read the VNC password from the viewer URL and does not apply keyword-based redaction guesses to state content; sensitive fields must be removed when the adapter constructs the state.
- Commands are not automatically retried, replayed after disconnection, or broadcast across pages.
