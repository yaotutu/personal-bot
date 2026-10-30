# Real Browser Docker and noVNC Guide

This deployment places the complete browser workstation inside one Linux container: the Node service, Google Chrome, Xvfb, fluxbox, x11vnc, websockify, and noVNC share the same virtual display. Chrome remains a real GUI browser and does not use `--headless`; Xvfb only supplies the X display that must exist for it to run.

Browser tab detection requires Chrome 150 or later. After the `/browser` frame stream is open, switching native tabs manually in noVNC synchronizes the current tab and frame stream within about one second; the periodic probe does not run when there is no frame-stream subscriber. If Chrome lacks the required native tab metadata, browser operations return a controlled error instead of falling back to page DOM visibility or tab-order guesses.

## Architecture {#architecture}

```text
User browser
  ├── /browser       -> Node API/CDP viewport frame stream and controlled input
  ├── /vnc.html      -> websockify/noVNC -> x11vnc -> Xvfb -> Chrome window
  ├── /pimuse-mobile.html -> phone-oriented noVNC page; still the same complete remote desktop
  └── /viewer-bridge-demo.html -> static acceptance page for a same-origin iframe and external toolbar
Agent
  └── in-process BrowserService -> Playwright/CDP -> the same Chrome
```

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

The API address is not hard-coded in the service. Any address that can route to this machine works. Compose binds noVNC only to the host loopback address by default, so the passwordless desktop is not exposed directly to the network:

```text
http://<any-host-or-domain>:12330/browser
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
```

If Docker runs on a remote host, create an SSH tunnel first, then open noVNC locally:

```sh
ssh -L 6080:127.0.0.1:6080 <user>@<server-host>
```

On `/browser`, enter the AccessKey manually. Successful login clears the input and keeps only the Session Token in the current tab's session storage. Do not put credentials in links: the page does not use `accessKey` or `key` query parameters to log in and removes them from the address bar. After a disconnection, click **Reconnect** to synchronize tabs and resume the stream; navigation, tab creation, and closing operations are not automatically replayed. This debug page supports Chinese input, text pasting, and left, middle, and right mouse buttons, but does not include Chrome's native menus. Use noVNC for the complete window.

Desktop and mobile share the `vnc.html` entry point. The default is `layout=auto`: when the viewport width is no wider than 700px, the page automatically switches to the mobile page, and it automatically returns to official noVNC once desktop width is restored. An explicit `layout=desktop` or `layout=mobile` pins the current page and prevents navigation based on window size. Redirects preserve query and `#` parameters. The mobile page connects to `/websockify` on the current address by default, and also supports overriding `path`, `host`, or `port` through query parameters. If a custom x11vnc setup later requires credentials, `password` can be supplied in the query or `#` fragment:

```text
http://127.0.0.1:6080/pimuse-mobile.html
http://127.0.0.1:6080/pimuse-mobile.html?password=<VNC-password>
http://127.0.0.1:6080/pimuse-mobile.html#password=<VNC-password>
```

The current Compose entry still starts with `-nopw`, so VNC access does not require credentials by default.

::: danger Remote desktop access boundary
The noVNC port is not protected by the Pi Muse API AccessKey. With no VNC credentials required by default, anyone who can reach the port can view and operate the entire remote desktop, including signed-in websites. Compose maps it only to `127.0.0.1` by default; use an SSH tunnel or a local browser, and do not expose the default port directly to untrusted networks. Set `PI_MUSE_BROWSER_NOVNC_HOST` to override the bind address only when you have restricted the source network and added an authenticated proxy yourself. HTTPS encrypts transport but does not replace access authentication.
:::

The real browser is configured on the server. The mobile client neither stores a noVNC address nor provides an open-browser entry. To view the remote desktop, open the complete deployed noVNC URL in a system browser.

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

Visit `/viewer-bridge-demo.html` under the same noVNC address to operate the real desktop in an iframe with a static external toolbar: connect, send keys, enter text, use the clipboard, scale, and toggle the built-in bar. It embeds `vnc.html?autoconnect=1&resize=scale&toolbar=hidden&layout=desktop` by default and pins the desktop layout to avoid page changes when the container size changes. The input field accepts only same-origin relative viewer paths, not IP addresses. If a cross-origin parent page embeds the viewer itself, it must set an explicit `parentOrigin` in the viewer URL. Fullscreen is entered directly from the demo page button into the iframe container; cross-window commands and the mobile soft keyboard cannot be guaranteed to preserve the user gesture.

Host ports can be changed without code changes. For example, map the API to `18890` and noVNC to `16080` while keeping noVNC bound to loopback:

```sh
PI_MUSE_BROWSER_PORT=18890 \
PI_MUSE_BROWSER_NOVNC_PORT=16080 \
docker compose -f compose.browser.yaml up -d
```

Set `PI_MUSE_BROWSER_NOVNC_HOST` only when you provide a restricted network or authenticated proxy yourself. The API key does not protect noVNC.

With a reverse proxy, the API domain must forward `/api`, `/browser`, and `/ws/browser`, preserving WebSocket Upgrade headers. The noVNC domain must forward HTTP and the `/websockify` WebSocket.

### Mobile Portrait Instance {#mobile-portrait-instance}

Compose provides a separate `mobile` profile. It uses a `720x1280x24` virtual screen and an independent Chrome profile volume without affecting the default desktop instance. Its default host ports are API `18891` and noVNC `16081`:

```sh
docker compose -f compose.browser.yaml --profile mobile up -d pi-muse-browser-mobile
```

Visit:

```text
http://<any-host-or-domain>:18891/api/health
http://127.0.0.1:16081/pimuse-mobile.html
```

The mobile noVNC port also binds to `127.0.0.1` by default. `PI_MUSE_BROWSER_MOBILE_NOVNC_HOST` can override it; confirm the network and authentication boundary before doing so.

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
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
```

After opening noVNC, you should see the complete Chrome window. After opening `/browser` or letting the Agent call `tab` or `navigate`, noVNC shows the same window changing in real time.

`viewer-bridge-demo.html` is a static acceptance tool, not the browser business client. Subsequent changes to the bridge, layout, or input logic require retesting iframe control, toolbar occlusion, connection recovery, and mobile input in a real browser.
