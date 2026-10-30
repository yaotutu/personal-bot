# Real Browser Docker and noVNC Guide

This deployment places the complete browser workstation inside one Linux container: the Node service, Google Chrome, Xvfb, fluxbox, x11vnc, websockify, and noVNC share the same virtual display. Chrome remains a real GUI browser and does not use `--headless`; Xvfb only supplies the X display that must exist for it to run.

Browser tab detection requires Chrome 150 or later. After the `/browser` frame stream is open, switching native tabs manually in noVNC synchronizes the current tab and frame stream within about one second; the periodic probe does not run when there is no frame-stream subscriber. If Chrome lacks the required native tab metadata, browser operations return a controlled error instead of falling back to page DOM visibility or tab-order guesses.

## Architecture {#architecture}

```text
User browser (single server address only)
  ├── /browser                  -> Node API/CDP viewport frame stream and controlled input
  └── /browser/desktop/vnc.html -> same-origin desktop gateway (one-time ticket + HttpOnly cookie)
                                     -> websockify/noVNC -> x11vnc -> Xvfb -> Chrome window
Agent
  └── in-process BrowserService -> Playwright/CDP -> the same Chrome
```

noVNC/websockify binds only to 127.0.0.1 inside the container (`tools.browser.desktopPort`, default 6080) and is no longer published to the host; all desktop traffic goes through the server's same-origin `/browser/desktop/` prefix, guarded by a one-time ticket exchanged via Bearer auth and a short-lived HttpOnly session cookie.

`/browser` is suited to product-oriented tab and viewport operations; noVNC is suited to observing and taking over the complete Chrome window, including native browser UI such as the address bar, tab strip, context menu, and download bubble. Both operate the same Chrome instance and the same persistent profile. The mobile page only adapts touch, scaling, and the soft keyboard; it does not add a custom browser shell or address bar.

## Startup {#startup}

Run these commands from the server repository root. First prepare an independent configuration; do not bake a real model key into the image:

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

Edit `.pi-muse/config.json` as needed. For browser-only use, the model may remain empty; for Agent conversations, fill in a real model configuration. Then build and start:

```sh
docker compose -f compose.browser.yaml up --build -d
```

Both the API and the desktop share the same server address—any address that can route to this machine works:

```text
http://<any-host-or-domain>:12330/browser
http://<any-host-or-domain>:12330/api/browser/status
```

Opening the full remote desktop takes two steps (no separate noVNC port or SSH tunnel needed):

```sh
# 1. Exchange a Bearer token for a one-time 60-second ticket
curl -fsS -X POST http://<host>:12330/api/browser/desktop-ticket \
  -H "Authorization: Bearer <session-token>"
# => {"launchPath":"/browser/desktop/launch?ticket=...","expiresAt":"..."}

# 2. Open the same-origin launch URL in a browser; the server issues an
#    HttpOnly cookie and redirects into the desktop
#    http://<host>:12330/browser/desktop/launch?ticket=...
```

On `/browser`, enter the AccessKey manually. Successful login clears the input and keeps only the Session Token in the current tab's session storage. Do not put credentials in links: the page does not use `accessKey` or `key` query parameters to log in and removes them from the address bar. After a disconnection, click **Reconnect** to synchronize tabs and resume the stream; navigation, tab creation, and closing operations are not automatically replayed. This debug page supports Chinese input, text pasting, and left, middle, and right mouse buttons, but does not include Chrome's native menus. Use the `/browser/desktop/` desktop for the complete window.

Desktop and mobile share the `/browser/desktop/vnc.html` entry point. The default is `layout=auto`: when the viewport width is no wider than 700px, the page automatically switches to the mobile page, and it automatically returns to official noVNC once desktop width is restored. An explicit `layout=desktop` or `layout=mobile` pins the current page and prevents navigation based on window size. Redirects preserve query and `#` parameters. The mobile page connects to the same-origin `/browser/desktop/websockify` by default, and also supports overriding `path`, `host`, or `port` through query parameters.

::: danger Remote desktop access boundary
The desktop session cookie grants full ability to view and operate the entire remote desktop, including signed-in websites. Tickets are one-time and expire in 60 seconds; the session cookie expires after 1 hour and is never renewed. Over plain HTTP the desktop traffic is unencrypted—use it only on trusted networks. HTTPS-terminating reverse proxies are currently unsupported (the cookie Secure flag and WS Origin checks follow the direct connection protocol). The mobile client has no desktop entry yet.
:::

The real browser is configured on the server. The mobile client neither stores a desktop address nor provides an open-browser entry. To view the remote desktop, use the ticket flow above and open the same-origin launch URL in a system browser.

## File Upload and Download {#files}

After `/browser` connects, the **Files** button opens the file panel. It reads the current pending chooser and download records every two seconds only while the panel is open and the connection is online; closing the panel or disconnecting stops polling. A single read failure keeps the previous list and shows an error, then polling continues. A read failure is not treated as an empty list.

An upload must start from a real filechooser event on the remote page:

1. Click the website's upload control on the remote page to trigger its filechooser; Playwright intercepts that chooser, so do not wait for a remote native file picker.
2. When the matching pending item appears in Files, choose local files in that panel.
3. Click **Upload** explicitly. The server passes only the in-memory bytes from that selection to the page; it does not read server paths, the workspace, or model file tools.

A single-file chooser accepts exactly one file. A multiple chooser accepts one to four files with at most 8 MiB of original bytes in total. File names may contain only ASCII letters, digits, dot, underscore, and hyphen, and cannot start with a dot. An empty MIME type becomes `application/octet-stream`. **Cancel** removes only that pending item and does not clear a file already selected on the page. Page main navigation, tab close, or a newer chooser invalidates the old item; another upload then returns 404.

Downloads come from Playwright download events on the remote page. For a completed download, click **Save** in Files to save it to the current device; deletion asks for confirmation. Each completed download is limited to 32 MiB. An oversized or failed download is marked failed and is not retained as readable completed content. An in-progress download has no readable content; reading it returns a conflict rather than a partial file.

Download records are stored in the Docker volume at `/app/.pi-muse/browser/downloads/<uuid>/`, with protected `content` and `meta.json` files. Completed records remain readable after a container restart. An interrupted downloading record becomes failed and is not downloaded again automatically. This directory is not part of the workspace and ordinary model file tools cannot read it.

### External Toolbar and Built-in Bar {#external-toolbar-and-built-in-bar}

Both the official desktop page and the mobile page expose the `window.piMuseViewer` control bridge. Their respective toolbars remain by default. Adding `toolbar=hidden` to the URL query or fragment hides the page toolbar, status, and reconnect overlay, while the remote canvas remains operable. `toolbar.set` can show it again. For bridge commands and event fields, see [the viewer bridge guide](browser-viewer-bridge.md).

After acquiring the desktop session cookie, visit `/browser/desktop/viewer-bridge-demo.html` under the same server address to operate the real desktop in an iframe with a static external toolbar: connect, send keys, enter text, use the clipboard, scale, and toggle the built-in bar. It embeds `vnc.html?autoconnect=1&resize=scale&toolbar=hidden&layout=desktop` by default and pins the desktop layout to avoid page changes when the container size changes. The input field accepts only same-origin relative viewer paths, not IP addresses. The current gateway permits only same-origin iframes; the bridge protocol's `parentOrigin` parameter does not relax that restriction. Fullscreen is entered directly from the demo page button into the iframe container; cross-window commands and the mobile soft keyboard cannot be guaranteed to preserve the user gesture.

Host ports can be changed without code changes. For example, map the service to `18890`:

```sh
PI_MUSE_BROWSER_PORT=18890 docker compose -f compose.browser.yaml up -d
```

For an HTTP reverse proxy, forward `/api`, `/browser`, `/ws/browser`, and `/browser/desktop/`, preserving the original `Host`, `Origin`, and WebSocket Upgrade headers on both WebSocket paths. The desktop WebSocket requires `Origin` to match the actual server connection scheme and `Host`; HTTPS-terminating reverse proxies are currently unsupported.

### Mobile Portrait Instance {#mobile-portrait-instance}

Compose provides a separate `mobile` profile. It uses a `720x1280x24` virtual screen and an independent Chrome profile volume without affecting the default desktop instance. Its default host port is `18891`:

```sh
docker compose -f compose.browser.yaml --profile mobile up -d pi-muse-browser-mobile
```

Visit:

```text
http://<any-host-or-domain>:18891/api/health
http://<any-host-or-domain>:18891/browser/desktop/launch?ticket=...
```

The mobile instance likewise publishes no noVNC port; desktop access goes through each service address's same-origin `/browser/desktop/` gateway.

Both instances can run at the same time. To rebuild both simultaneously, run:

```sh
docker compose -f compose.browser.yaml --profile mobile up --build -d
```

## Data and Lifecycle {#data-and-lifecycle}

- The Chrome profile is persisted in Docker volume `pi-muse-browser-data` at `/app/.pi-muse/browser/profile/`.
- Browser downloads are persisted at `/app/.pi-muse/browser/downloads/`; each UUID directory contains only `content` and `meta.json`. Directory and file permissions are protected, and the directory is outside the workspace.
- `.pi-muse/config.json` is mounted read-only from the host at `/app/browser-config.json`. At container startup it is copied into the data volume while remaining `0600`; the image build context explicitly excludes `.pi-muse`, so model keys are not baked into an image layer.
- The entrypoint script first uses root to correct ownership of the data volume, then drops privileges to `pimuse`; Node, Chrome, Xvfb, x11vnc, websockify, and fluxbox do not run as root.
- After startup completes, the container proactively triggers one tab read so the Chrome window is immediately visible. On shutdown, the entrypoint sends SIGTERM only to the independent Node process and waits for it to finish. Node gracefully closes Chrome before the entrypoint stops fluxbox, x11vnc, websockify, and Xvfb, keeping the X server alive while Chrome exits and writes its profile. The entrypoint does not add its own wait timeout; Docker ultimately hard-stops the container after its stop grace period expires.
- The default virtual screen is `1440x900x24` and can be adjusted with the `BROWSER_SCREEN_SIZE` environment variable, for example `1920x1080x24`.
- The official Google Chrome package currently targets linux/amd64; Apple Silicon machines must run Docker with amd64 emulation.

## Verification {#verification}

```sh
curl -fsS http://127.0.0.1:12330/api/health
curl -fsS -X POST http://127.0.0.1:12330/api/browser/desktop-ticket \
  -H "Authorization: Bearer <session-token>"
```

Open the returned `launchPath` to see the complete Chrome window. After opening `/browser` or letting the Agent call `tab` or `navigate`, the desktop shows the same window changing in real time.

`viewer-bridge-demo.html` is a static acceptance tool, not the browser business client. Subsequent changes to the bridge, layout, or input logic require retesting iframe control, toolbar occlusion, connection recovery, and mobile input in a real browser.
