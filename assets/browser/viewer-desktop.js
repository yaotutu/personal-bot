import UI from './app/ui.js';
import KeyTable from './core/input/keysym.js';
import { createViewerBridge } from './viewer-bridge.js';
import { createViewerControls, viewerSetting } from './viewer-controls.js';

// 官方 noVNC UI 保持原样。本模块只桥接其公开 UI 方法、RFB 实例和 DOM 状态。
const style = document.createElement('style');
style.textContent = `
  html[data-pimuse-toolbar="hidden"] #noVNC_control_bar_anchor,
  html[data-pimuse-toolbar="hidden"] #noVNC_status,
  html[data-pimuse-toolbar="hidden"] #noVNC_transition,
  html[data-pimuse-toolbar="hidden"] #noVNC_fallback_error,
  html[data-pimuse-toolbar="hidden"] body > .noVNC_center,
  html[data-pimuse-toolbar="hidden"] body > .noVNC_connect_layer { display: none !important; }
`;
document.head.append(style);

const original = {
  connect: UI.connect.bind(UI),
  disconnect: UI.disconnect.bind(UI),
  updateVisualState: UI.updateVisualState.bind(UI),
  updateViewOnly: UI.updateViewOnly.bind(UI),
  updateViewDrag: UI.updateViewDrag.bind(UI),
  updateFullscreenButton: UI.updateFullscreenButton.bind(UI),
};
let reconnectPending = false;

function showError(error) {
  UI.showStatus(error?.message || '操作失败', 'error');
}

function syncRfb() {
  if (UI.rfb) controlsAdapter.bindRfb(UI.rfb);
}

function syncNativeState() {
  if (!UI.rfb) return;
  controlsAdapter.update({
    viewOnly: UI.rfb.viewOnly,
    viewportMode: UI.rfb.scaleViewport ? 'scale' : UI.rfb.clipViewport ? 'clip' : 'native',
    drag: UI.rfb.dragViewport,
    desktopName: UI.desktopName || controlsAdapter.getState().desktopName,
  });
}

const controlsAdapter = createViewerControls({
  viewportMode: viewerSetting('resize') === 'scale' ? 'scale' : 'native',
  connect() {
    original.connect();
    if (!UI.rfb) throw new Error('noVNC 未建立连接');
    syncRfb();
  },
  disconnect() { original.disconnect(); },
  reconnect() {
    reconnectPending = true;
    original.disconnect();
  },
  toolbar(visible) { document.documentElement.dataset.pimuseToolbar = visible ? 'visible' : 'hidden'; },
  keyboard(visible) { (visible ? UI.showVirtualKeyboard : UI.hideVirtualKeyboard).call(UI); },
  keyboardVisible() { return document.activeElement === document.getElementById('noVNC_keyboardinput'); },
  viewport(mode, drag) {
    const resize = document.getElementById('noVNC_setting_resize');
    if (resize) resize.value = mode === 'scale' ? 'scale' : 'off';
    const clip = document.getElementById('noVNC_setting_view_clip');
    if (clip) clip.checked = mode === 'clip';
    UI.saveSetting('resize');
    UI.saveSetting('view_clip');
    original.updateViewDrag();
  },
  viewOnly(enabled) {
    const input = document.getElementById('noVNC_setting_view_only');
    if (input) { input.checked = enabled; UI.saveSetting('view_only'); original.updateViewOnly(); }
  },
});
const bridge = createViewerBridge(controlsAdapter);
document.documentElement.dataset.pimuseToolbar = controlsAdapter.getState().toolbarVisible ? 'visible' : 'hidden';

// noVNC 自身会自动连接、断开和重连；每次 UI 创建 RFB 后重新订阅当前实例。
UI.connect = (...args) => {
  if (args.length > 1) {
    const result = original.connect(...args);
    syncRfb();
    return result;
  }
  return bridge.dispatch('connect').catch(showError);
};
UI.disconnect = () => bridge.dispatch('disconnect').catch(showError);
UI.updateVisualState = (visualState) => {
  const result = original.updateVisualState(visualState);
  syncRfb();
  const connection = visualState === 'reconnecting' ? 'connecting' : visualState;
  if (['connecting', 'connected', 'disconnecting', 'disconnected'].includes(connection)) {
    controlsAdapter.update({ connection, keyboardVisible: connection === 'connected' && controlsAdapter.getState().keyboardVisible });
  }
  if (visualState === 'disconnected' && reconnectPending) {
    reconnectPending = false;
    queueMicrotask(() => bridge.dispatch('connect').catch(showError));
  }
  return result;
};

// 事件监听可能在桥接模块加载前已由官方 UI 注册。捕获阶段接管共有命令，避免双重执行。
function routeNative(event, command, args = {}) {
  event.preventDefault();
  event.stopImmediatePropagation();
  bridge.dispatch(command, args).catch(showError);
}

document.addEventListener('click', (event) => {
  const id = event.target?.id;
  if (id === 'noVNC_connect_button' || event.target?.closest?.('#noVNC_connect_button')) routeNative(event, 'connect');
  else if (id === 'noVNC_disconnect_button') routeNative(event, 'disconnect');
  else if (id === 'noVNC_keyboard_button') routeNative(event, 'keyboard.set', { visible: !controlsAdapter.getState().keyboardVisible });
  else if (id === 'noVNC_view_drag_button') routeNative(event, 'viewport.set', { mode: controlsAdapter.getState().viewportMode, drag: !controlsAdapter.getState().drag });
  else if (id === 'noVNC_fullscreen_button') routeNative(event, 'fullscreen.set', { enabled: !Boolean(document.fullscreenElement) });
  else if (id === 'noVNC_send_tab_button') routeNative(event, 'key.send', { keysym: KeyTable.XK_Tab, code: 'Tab' });
  else if (id === 'noVNC_send_esc_button') routeNative(event, 'key.send', { keysym: KeyTable.XK_Escape, code: 'Escape' });
}, true);

document.addEventListener('change', (event) => {
  const id = event.target?.id;
  if (id === 'noVNC_setting_view_only') {
    UI.saveSetting('view_only');
    routeNative(event, 'viewOnly.set', { enabled: event.target.checked });
  } else if (id === 'noVNC_setting_resize' || id === 'noVNC_setting_view_clip') {
    const mode = document.getElementById('noVNC_setting_resize').value === 'scale' ? 'scale'
      : document.getElementById('noVNC_setting_view_clip').checked ? 'clip' : 'native';
    routeNative(event, 'viewport.set', { mode, drag: controlsAdapter.getState().drag });
  } else if (id === 'noVNC_clipboard_text') {
    routeNative(event, 'clipboard.set', { text: event.target.value });
  }
}, true);

document.addEventListener('focusin', (event) => {
  if (event.target?.id === 'noVNC_keyboardinput') {
    if (UI.rfb) UI.rfb.focusOnClick = false;
    controlsAdapter.update({ keyboardVisible: true });
  }
});
document.addEventListener('focusout', (event) => {
  if (event.target?.id === 'noVNC_keyboardinput') {
    if (UI.rfb) UI.rfb.focusOnClick = true;
    controlsAdapter.update({ keyboardVisible: false });
  }
});

// UI.prime/start 是异步的：模块安装时或 DOM ready 后都重新同步一次首个 RFB。
function syncInitial() {
  syncRfb();
  if (UI.connected) controlsAdapter.update({ connection: 'connected' });
  else if (document.documentElement.classList.contains('noVNC_connecting')) controlsAdapter.update({ connection: 'connecting' });
  syncNativeState();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncInitial, { once: true });
else syncInitial();
