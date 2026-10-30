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
    .login input { min-width: 0; flex: 1; }
    input, button {
      border: 1px solid var(--line); background: #111718; color: var(--text);
      border-radius: 7px; padding: 8px 10px; font: inherit;
    }
    button { cursor: pointer; background: var(--panel-2); }
    button:disabled { cursor: not-allowed; opacity: .5; }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.danger:hover { border-color: var(--danger); color: var(--danger); }
    .shell { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0 12px 12px; }
    .toolbar { display: flex; gap: 6px; align-items: center; padding: 8px; background: rgba(25,31,33,.94); border: 1px solid var(--line); border-radius: 10px 10px 0 0; }
    .toolbar input { flex: 1; min-width: 0; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; padding: 8px; background: var(--panel); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
    .tab { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; background: #121819; color: var(--muted); }
    .tab.active { color: var(--text); border-color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
    .tab button { padding: 1px 5px; border: 0; background: transparent; color: inherit; }
    .stage { position: relative; flex: 1; min-height: 420px; border: 1px solid var(--line); border-top: 0; border-radius: 0 0 10px 10px; overflow: hidden; background: #050708; }
    canvas, textarea { position: absolute; inset: 0; width: 100%; height: 100%; }
    canvas { object-fit: contain; background: #050708; }
    textarea { opacity: 0; resize: none; border: 0; background: transparent; color: transparent; caret-color: transparent; }
    .status { position: absolute; left: 10px; bottom: 10px; padding: 5px 8px; border-radius: 6px; background: rgba(16,19,20,.82); color: var(--muted); font-size: 12px; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); pointer-events: none; text-align: center; padding: 16px; }
    @media (max-width: 700px) { .toolbar { flex-wrap: wrap; } .toolbar input { flex-basis: 100%; order: 3; } .shell { min-width: 0; } }
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
      <button id="reconnect" type="button">Reconnect</button>
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
  // 旧分享链接中的密钥绝不读取；尽早从地址栏和浏览器历史当前条目移除。
  const url = new URL(location.href);
  if (url.searchParams.has("accessKey") || url.searchParams.has("key")) {
    url.searchParams.delete("accessKey"); url.searchParams.delete("key");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
  const state = { token: sessionStorage.getItem("pi-muse-browser-token") || "", tabs: [], activeTabId: null, tabsVersion: 0, frame: null, socket: null, connected: false, connectionId: 0, composing: false, pressedPointer: null, heldKeys: new Set(), lastMove: 0, lastPointer: null, frameId: 0 };
  const setStatus = (value) => { $("status").textContent = value; };
  const updateControls = () => {
    const ready = state.connected && state.socket?.readyState === WebSocket.OPEN;
    for (const id of ["back", "forward", "reload", "go", "newTab", "address", "keyboard"]) $(id).disabled = !ready;
    $("reconnect").disabled = !state.token;
    $("tabs").style.pointerEvents = ready ? "auto" : "none";
    $("tabs").style.opacity = ready ? "1" : ".5";
    $("empty").textContent = !state.token ? "Login to start Chrome" : ready ? "No browser tab" : "Disconnected — reconnect to control Chrome";
    $("empty").style.display = ready && state.tabs.length ? "none" : "grid";
  };
  const clearFrame = () => { state.frame = null; state.frameId++; $("canvas").getContext("2d").clearRect(0, 0, $("canvas").width, $("canvas").height); };
  // 仅主动放弃当前连接或窗口失焦时释放输入；已断开的 socket 不宣称释放成功。
  const releaseHeldInput = () => {
    const socket = state.socket;
    if (state.connected && socket?.readyState === WebSocket.OPEN) {
      const pressed = state.pressedPointer;
      if (pressed) socket.send(JSON.stringify({ type: "pointer_up", ...pressed.point, button: pressed.button }));
      for (const key of [...state.heldKeys].reverse()) socket.send(JSON.stringify({ type: "key_up", key }));
    }
    state.pressedPointer = null; state.heldKeys.clear(); state.lastPointer = null;
  };
  const disconnect = (message, releaseInput = false) => {
    if (releaseInput) releaseHeldInput();
    state.connectionId++;
    const socket = state.socket; state.socket = null; state.connected = false;
    if (socket) socket.close();
    state.pressedPointer = null; state.heldKeys.clear(); state.lastPointer = null; clearFrame();
    setStatus(message); updateControls();
  };
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), ...(state.token ? { Authorization: "Bearer " + state.token } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    if (response.status === 401) { state.token = ""; sessionStorage.removeItem("pi-muse-browser-token"); disconnect("Login required"); throw new Error("unauthorized"); }
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
      close.onclick = (event) => { event.stopPropagation(); writeAndRefresh("/api/browser/tabs/" + tab.id, { method: "DELETE" }); };
      item.appendChild(close);
      return item;
    }));
    const tab = activeTab();
    if (tab && document.activeElement !== $("address")) $("address").value = tab.url === "about:blank" ? "" : tab.url;
    updateControls();
  };
  const showError = (error) => setStatus(error.message || String(error));
  const renderTabsFromResponse = (body) => { const previous = state.activeTabId; state.tabs = body.tabs; state.activeTabId = (state.tabs.find((tab) => tab.active) || {}).id || null; if (previous !== state.activeTabId) clearFrame(); renderTabs(); };
  const refresh = async () => {
    const version = state.tabsVersion;
    const body = await api("/api/browser/tabs");
    // WS ready/tabs 比并发中的旧 GET 更权威，不能用迟到快照覆盖它。
    if (version === state.tabsVersion) renderTabsFromResponse(body);
  };
  // 写请求即使网络失败也可能已执行：只读列表核对结果，绝不自动重发写请求。
  const writeAndRefresh = async (path, options) => {
    try { await api(path, options); } catch (error) { showError(error); }
    try { await refresh(); } catch (error) { showError(error); }
  };
  const activate = (tabId) => writeAndRefresh("/api/browser/tabs/" + tabId + "/activate", { method: "POST" });
  const navigation = async (action, url) => {
    const tab = activeTab(); if (!tab) return;
    await writeAndRefresh("/api/browser/tabs/" + tab.id + "/navigation", { method: "POST", body: JSON.stringify(action === "navigate" ? { action, url } : { action }) });
  };
  const connect = async () => {
    disconnect("Connecting…", true);
    const connectionId = state.connectionId;
    try {
      const { ticket } = await api("/api/browser/ws-ticket", { method: "POST", body: "{}" });
      if (connectionId !== state.connectionId) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + location.host + "/ws/browser?ticket=" + encodeURIComponent(ticket));
      socket.binaryType = "arraybuffer";
      state.socket = socket;
      const current = () => state.socket === socket && state.connectionId === connectionId;
      socket.onopen = () => { if (current()) setStatus("Synchronizing…"); };
      socket.onclose = () => { if (current()) disconnect("Disconnected — use Reconnect"); };
      socket.onerror = () => { if (current()) disconnect("Connection failed — use Reconnect"); };
      socket.onmessage = (event) => {
      if (!current()) return;
      if (typeof event.data === "string") {
        let message;
        try { message = JSON.parse(event.data); } catch { disconnect("Invalid browser message — use Reconnect"); return; }
        if (message.type === "ready" || message.type === "tabs") {
          if (!Array.isArray(message.tabs)) return;
          const oldTab = state.activeTabId;
          state.tabs = message.tabs; state.activeTabId = message.activeTabId; state.tabsVersion++;
          if (oldTab !== state.activeTabId) clearFrame();
          if (message.type === "ready") { state.connected = true; setStatus("Connected"); }
          renderTabs();
        }
        if (message.type === "error") setStatus(message.error);
        return;
      }
      let metadata, bytes, metadataLength;
      try {
        bytes = new Uint8Array(event.data);
        if (bytes.byteLength < 5) throw new Error("short frame");
        metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        if (metadataLength > bytes.byteLength - 4) throw new Error("invalid metadata length");
        metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength)));
      } catch { disconnect("Invalid frame — use Reconnect"); return; }
      let acknowledged = false;
      const ackFrame = () => {
        if (acknowledged || !current() || socket.readyState !== WebSocket.OPEN) return;
        acknowledged = true;
        socket.send(JSON.stringify({ type: "frame_ack", frameId: metadata.frameId, sessionId: metadata.sessionId }));
      };
      // 当前 socket 的有效帧即使不绘制，也必须释放服务端 pendingFrame。
      if (!state.connected || metadata.tabId !== state.activeTabId) { ackFrame(); return; }
      const frameId = ++state.frameId;
      const image = new Image();
      const imageUrl = URL.createObjectURL(new Blob([bytes.subarray(4 + metadataLength)], { type: "image/jpeg" }));
      image.onload = () => {
        URL.revokeObjectURL(imageUrl);
        if (!current() || socket.readyState !== WebSocket.OPEN) return;
        try {
          if (state.connected && frameId === state.frameId && metadata.tabId === state.activeTabId) {
            const canvas = $("canvas"); canvas.width = image.width; canvas.height = image.height;
            canvas.getContext("2d").drawImage(image, 0, 0);
            state.frame = metadata; setStatus("Frame " + metadata.frameId);
          }
        } finally { ackFrame(); }
      };
      image.onerror = () => { URL.revokeObjectURL(imageUrl); if (current()) { ackFrame(); setStatus("Frame decode failed"); } };
      image.src = imageUrl;
      };
    } catch (error) { if (connectionId === state.connectionId) disconnect(error.message || "Connection failed"); }
  };
  const point = (event) => {
    const canvas = $("canvas"); const frame = state.frame; if (!state.connected || !frame) return null;
    // canvas 使用 object-fit: contain；输入坐标必须扣除留白并按显示比例换算。
    const scale = Math.min(canvas.clientWidth / frame.width, canvas.clientHeight / frame.height);
    const x = (event.offsetX - (canvas.clientWidth - frame.width * scale) / 2) / scale;
    const y = (event.offsetY - (canvas.clientHeight - frame.height * scale) / 2) / scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
    return { x, y };
  };
  const send = (message) => { if (state.connected && state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); };
  $("login").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const body = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: $("accessKey").value }) });
      const value = await body.json(); if (!body.ok) throw new Error(value.error || "Login failed");
      state.token = value.token; sessionStorage.setItem("pi-muse-browser-token", value.token);
      $("accessKey").value = ""; updateControls();
      await refresh(); await connect();
    } catch (error) { showError(error); }
  };
  $("newTab").onclick = () => writeAndRefresh("/api/browser/tabs", { method: "POST", body: "{}" });
  $("reconnect").onclick = () => connect();
  $("address").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); const value = $("address").value.trim(); if (value) navigation("navigate", /^(https?:\\/\\/)/i.test(value) ? value : "https://" + value); } };
  $("go").onclick = () => $("address").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  $("back").onclick = () => navigation("back");
  $("forward").onclick = () => navigation("forward");
  $("reload").onclick = () => navigation("reload");
  const stage = $("keyboard");
  const button = (number) => ({ 0: "left", 1: "middle", 2: "right" })[number];
  const releasePointer = (event) => {
    const pressed = state.pressedPointer; if (!pressed || pressed.pointerId !== event.pointerId) return;
    const p = point(event) || state.lastPointer || pressed.point;
    send({ type: "pointer_up", ...p, button: pressed.button });
    state.pressedPointer = null; state.lastPointer = null;
  };
  stage.onpointermove = (event) => { const now = performance.now(); if (now - state.lastMove < 30) return; state.lastMove = now; const p = point(event); if (p) { state.lastPointer = p; send({ type: "pointer_move", ...p }); } };
  stage.onpointerdown = (event) => {
    const p = point(event), mapped = button(event.button);
    if (!p || !mapped || state.pressedPointer) return;
    if (mapped !== "left") event.preventDefault();
    stage.setPointerCapture(event.pointerId); state.lastPointer = p;
    state.pressedPointer = { pointerId: event.pointerId, button: mapped, point: p };
    send({ type: "pointer_down", ...p, button: mapped });
  };
  stage.onpointerup = releasePointer;
  stage.onpointercancel = releasePointer;
  stage.onlostpointercapture = releasePointer;
  stage.oncontextmenu = (event) => event.preventDefault();
  stage.onauxclick = (event) => event.preventDefault();
  stage.onwheel = (event) => { if (!state.connected) return; event.preventDefault(); const p = point(event); if (p) state.lastPointer = p; send({ type: "wheel", ...(p || {}), deltaX: Math.max(-100000, Math.min(100000, event.deltaX)), deltaY: Math.max(-100000, Math.min(100000, event.deltaY)) }); };
  // 普通字符（含粘贴）只从 input 取实际文本；组合键与特殊键按 Playwright 键名逐键发送。
  const keyName = (event) => {
    const names = { " ": "Space", Escape: "Escape", Esc: "Escape", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Control: "Control", Shift: "Shift", Alt: "Alt", Meta: "Meta" };
    if (names[event.key]) return names[event.key];
    if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return event.key;
    if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toLowerCase();
    const codes = { Backquote: "Backquote", Minus: "Minus", Equal: "Equal", BracketLeft: "BracketLeft", BracketRight: "BracketRight", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", Comma: "Comma", Period: "Period", Slash: "Slash" };
    return codes[event.code] || null;
  };
  const insertText = (value) => { for (let offset = 0; offset < value.length; offset += 2000) send({ type: "insert_text", text: value.slice(offset, offset + 2000) }); };
  let suppressInput = "";
  stage.oncompositionstart = () => { state.composing = true; };
  stage.oncompositionend = (event) => { state.composing = false; stage.value = ""; suppressInput = event.data || ""; insertText(event.data || ""); };
  stage.oninput = (event) => {
    if (state.composing) return;
    const value = stage.value || event.data || ""; stage.value = "";
    if (suppressInput && (value === suppressInput || event.data === suppressInput)) { suppressInput = ""; return; }
    suppressInput = "";
    insertText(value);
  };
  stage.onkeydown = (event) => {
    if (!state.connected || state.composing || event.isComposing || event.key === "Process" || event.key === "Dead") return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    const special = modified || event.key.length !== 1;
    if (!special) return;
    // 粘贴由本地 textarea 的 input 事件取得真实文字，避免远端再执行一次快捷键。
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    const key = keyName(event); if (!key) return;
    event.preventDefault();
    if (!state.heldKeys.has(key)) { state.heldKeys.add(key); send({ type: "key_down", key }); }
  };
  stage.onkeyup = (event) => { const key = keyName(event); if (key && state.heldKeys.delete(key)) { event.preventDefault(); send({ type: "key_up", key }); } };
  window.addEventListener("blur", releaseHeldInput);
  (async () => {
    updateControls();
    if (!state.token) return;
    try { await refresh(); await connect(); } catch (error) { showError(error); }
  })();
})();
</script>
</body>
</html>`;
