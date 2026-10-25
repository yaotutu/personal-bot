/** 服务端自带 /browser 调试页：只验证真实浏览器链路，不是移动端产品 UI。 */
export const browserDebugPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>pi-muse browser</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101314;
      --panel: #191f21;
      --panel-2: #222a2d;
      --line: #334044;
      --text: #e9f1f1;
      --muted: #9badb0;
      --accent: #77e0b8;
      --danger: #ff8f7a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; flex-direction: column;
      background: radial-gradient(circle at 15% 0%, #233236 0%, var(--bg) 42%);
      color: var(--text); font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    header { padding: 16px 18px 10px; }
    h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: .04em; }
    h1 span { color: var(--accent); }
    .login { display: flex; gap: 8px; max-width: 520px; }
    input, button {
      border: 1px solid var(--line); background: #111718; color: var(--text);
      border-radius: 7px; padding: 8px 10px; font: inherit;
    }
    button { cursor: pointer; background: var(--panel-2); }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.danger:hover { border-color: var(--danger); color: var(--danger); }
    .shell { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0 12px 12px; }
    .toolbar { display: flex; gap: 6px; align-items: center; padding: 8px; background: rgba(25,31,33,.94); border: 1px solid var(--line); border-radius: 10px 10px 0 0; }
    .toolbar input { flex: 1; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; padding: 8px; background: var(--panel); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
    .tab { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; background: #121819; color: var(--muted); }
    .tab.active { color: var(--text); border-color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
    .tab button { padding: 1px 5px; border: 0; background: transparent; color: inherit; }
    .stage { position: relative; flex: 1; min-height: 420px; border: 1px solid var(--line); border-top: 0; border-radius: 0 0 10px 10px; overflow: hidden; background: #050708; }
    canvas, textarea { position: absolute; inset: 0; width: 100%; height: 100%; }
    canvas { object-fit: contain; background: #050708; }
    textarea { opacity: 0; resize: none; border: 0; background: transparent; color: transparent; caret-color: transparent; }
    .status { position: absolute; left: 10px; bottom: 10px; padding: 5px 8px; border-radius: 6px; background: rgba(16,19,20,.82); color: var(--muted); font-size: 12px; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
    @media (max-width: 700px) { .toolbar { flex-wrap: wrap; } .toolbar input { min-width: 100%; order: 3; } }
  </style>
</head>
<body>
  <header>
    <h1>pi-muse <span>real browser</span></h1>
    <form id="login" class="login"><input id="accessKey" type="password" placeholder="Workspace access key" autocomplete="current-password"><button>Login</button></form>
  </header>
  <main class="shell">
    <section class="toolbar">
      <button id="back" title="Back">&#8592;</button>
      <button id="forward" title="Forward">&#8594;</button>
      <button id="reload" title="Reload">&#8635;</button>
      <input id="address" type="url" placeholder="https://example.com" spellcheck="false">
      <button id="go">Go</button>
      <button id="newTab">New tab</button>
    </section>
    <nav id="tabs" class="tabs"></nav>
    <section class="stage">
      <canvas id="canvas" width="1280" height="800"></canvas>
      <textarea id="keyboard" spellcheck="false" autocomplete="off"></textarea>
      <div id="empty" class="empty">Login to start Chrome</div>
      <div id="status" class="status">Disconnected</div>
    </section>
  </main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { token: sessionStorage.getItem("pi-muse-browser-token") || "", tabs: [], activeTabId: null, frame: null, socket: null, composing: false, lastMove: 0, lastPointer: null };
  const setStatus = (text) => { $("status").textContent = text; };
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), ...(state.token ? { Authorization: "Bearer " + state.token } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    if (response.status === 401) { state.token = ""; sessionStorage.removeItem("pi-muse-browser-token"); setStatus("Login required"); throw new Error("unauthorized"); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
    return body;
  };
  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId);
  const renderTabs = () => {
    $("tabs").replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
      item.role = "button";
      item.tabIndex = 0;
      item.textContent = (tab.title || tab.url || tab.id).slice(0, 34);
      item.onclick = () => activate(tab.id);
      item.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(tab.id); } };
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "x"; close.title = "Close"; close.className = "danger";
      close.onclick = async (event) => { event.stopPropagation(); await api("/api/browser/tabs/" + tab.id, { method: "DELETE" }).then(renderTabsFromResponse).catch(showError); };
      item.appendChild(close);
      return item;
    }));
    const tab = activeTab();
    if (tab && document.activeElement !== $("address")) $("address").value = tab.url === "about:blank" ? "" : tab.url;
    $("empty").style.display = state.tabs.length ? "none" : "grid";
  };
  const showError = (error) => setStatus(error.message || String(error));
  const renderTabsFromResponse = (body) => { state.tabs = body.tabs || [body]; state.activeTabId = (state.tabs.find((tab) => tab.active) || state.tabs[0] || {}).id || null; renderTabs(); };
  const refresh = async () => { await api("/api/browser/tabs").then(renderTabsFromResponse).catch(showError); };
  const activate = async (tabId) => { await api("/api/browser/tabs/" + tabId + "/activate", { method: "POST" }).then(renderTabsFromResponse).catch(showError); };
  const navigation = async (action, url) => {
    const tab = activeTab(); if (!tab) return;
    await api("/api/browser/tabs/" + tab.id + "/navigation", { method: "POST", body: JSON.stringify(action === "navigate" ? { action, url } : { action }) }).then(renderTabsFromResponse).catch(showError);
  };
  const connect = async () => {
    if (state.socket) { state.socket.close(); state.socket = null; }
    const { ticket } = await api("/api/browser/ws-ticket", { method: "POST", body: "{}" });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(protocol + "//" + location.host + "/ws/browser?ticket=" + encodeURIComponent(ticket));
    socket.binaryType = "arraybuffer";
    state.socket = socket;
    socket.onopen = () => setStatus("Connected");
    socket.onclose = () => { setStatus("Disconnected"); if (state.socket === socket) state.socket = null; };
    socket.onerror = () => setStatus("WebSocket error");
    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "ready" || message.type === "tabs") { state.tabs = message.tabs; state.activeTabId = message.activeTabId; renderTabs(); }
        if (message.type === "error") setStatus(message.error);
        return;
      }
      const bytes = new Uint8Array(event.data);
      const metadataLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
      const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength)));
      const image = new Image();
      image.onload = () => {
        const canvas = $("canvas"); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext("2d").drawImage(image, 0, 0); URL.revokeObjectURL(image.src);
        state.frame = metadata; setStatus("Frame " + metadata.frameId);
        socket.send(JSON.stringify({ type: "frame_ack", frameId: metadata.frameId, sessionId: metadata.sessionId }));
      };
      image.src = URL.createObjectURL(new Blob([bytes.subarray(4 + metadataLength)], { type: "image/jpeg" }));
    };
  };
  const point = (event) => {
    const canvas = $("canvas"); const frame = state.frame; if (!frame) return null;
    // canvas 使用 object-fit: contain；输入坐标必须扣除留白并按显示比例换算。
    const scale = Math.min(canvas.clientWidth / frame.width, canvas.clientHeight / frame.height);
    const x = (event.offsetX - (canvas.clientWidth - frame.width * scale) / 2) / scale;
    const y = (event.offsetY - (canvas.clientHeight - frame.height * scale) / 2) / scale;
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
    return { x, y };
  };
  const send = (message) => { if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); };
  $("login").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const body = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: $("accessKey").value }) });
      const value = await body.json(); if (!body.ok) throw new Error(value.error || "Login failed");
      state.token = value.token; sessionStorage.setItem("pi-muse-browser-token", value.token);
      await refresh(); await connect();
    } catch (error) { showError(error); }
  };
  $("newTab").onclick = async () => { await api("/api/browser/tabs", { method: "POST", body: "{}" }).then(renderTabsFromResponse).catch(showError); };
  $("address").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); const value = $("address").value.trim(); if (value) navigation("navigate", /^(https?:\\/\\/)/i.test(value) ? value : "https://" + value); } };
  $("go").onclick = () => $("address").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  $("back").onclick = () => navigation("back");
  $("forward").onclick = () => navigation("forward");
  $("reload").onclick = () => navigation("reload");
  const stage = $("keyboard");
  stage.onpointermove = (event) => { const now = performance.now(); if (now - state.lastMove < 30) return; state.lastMove = now; const p = point(event); if (p) { state.lastPointer = p; send({ type: "pointer_move", ...p }); } };
  stage.onpointerdown = (event) => { stage.setPointerCapture(event.pointerId); const p = point(event); if (p) { state.lastPointer = p; send({ type: "pointer_down", ...p }); } };
  stage.onpointerup = (event) => { const p = point(event) || state.lastPointer; if (p) send({ type: "pointer_up", ...p }); state.lastPointer = null; };
  stage.oncontextmenu = (event) => event.preventDefault();
  stage.onwheel = (event) => { event.preventDefault(); const p = point(event); if (p) state.lastPointer = p; send({ type: "wheel", ...(p || {}), deltaX: event.deltaX, deltaY: event.deltaY }); };
  stage.oncompositionstart = () => { state.composing = true; };
  stage.oncompositionend = (event) => { state.composing = false; stage.value = ""; if (event.data) send({ type: "insert_text", text: event.data }); };
  stage.onkeydown = (event) => {
    if (state.composing) return;
    const special = event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey;
    if (!special) { event.preventDefault(); send({ type: "insert_text", text: event.key }); return; }
    event.preventDefault(); send({ type: "key_down", key: event.key });
  };
  stage.onkeyup = (event) => { if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) send({ type: "key_up", key: event.key }); };
  (async () => { if (!state.token) return; try { await refresh(); await connect(); } catch { } })();
})();
</script>
</body>
</html>`;
