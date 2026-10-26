// 桌面官方 UI 和手机页共用的 RFB 控制边界；连接由各自页面建立，本模块只使用公开 RFB API。
const COMMANDS = [
  'state.get', 'connect', 'disconnect', 'reconnect', 'focus', 'toolbar.set',
  'keyboard.set', 'key.send', 'text.send', 'clipboard.set', 'viewport.set',
  'viewOnly.set', 'fullscreen.set',
];

export function viewerError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function viewerSetting(name) {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return query.get(name) ?? hash.get(name);
}

export function createViewerControls(options) {
  const listeners = new Set();
  const state = {
    connection: 'disconnected',
    toolbarVisible: viewerSetting('toolbar') !== 'hidden',
    keyboardVisible: false,
    viewportMode: options.viewportMode ?? 'scale',
    drag: false,
    viewOnly: false,
    fullscreen: Boolean(document.fullscreenElement),
    desktopName: '',
    capabilities: { commands: COMMANDS, keyboardRequiresGesture: true, fullscreenRequiresGesture: true },
  };
  let rfb;
  let removeRfbListeners = () => {};

  function publish(event = 'state', data = getState()) {
    for (const listener of listeners) listener({ event, data });
  }

  function getState() {
    return { ...state, capabilities: { ...state.capabilities, commands: [...COMMANDS] } };
  }

  function update(patch) {
    Object.assign(state, patch);
    publish();
  }

  // 每次重连都解绑旧实例的事件，迟到的旧连接不会污染新页面状态。
  function bindRfb(nextRfb) {
    if (rfb === nextRfb) return;
    removeRfbListeners();
    rfb = nextRfb;
    if (!rfb) return;
    const bound = rfb;
    const onConnect = () => { if (rfb === bound) update({ connection: 'connected' }); };
    const onDisconnect = (event) => {
      if (rfb === bound) update({ connection: event.detail?.clean ? 'disconnected' : 'error', keyboardVisible: false });
    };
    const onDesktopName = (event) => {
      if (rfb === bound) update({ desktopName: event.detail?.name ?? '' });
    };
    const onClipboard = (event) => {
      if (rfb === bound) publish('clipboard', { text: event.detail?.text ?? '' });
    };
    const handlers = [['connect', onConnect], ['disconnect', onDisconnect], ['desktopname', onDesktopName], ['clipboard', onClipboard]];
    for (const [event, listener] of handlers) bound.addEventListener(event, listener);
    removeRfbListeners = () => {
      for (const [event, listener] of handlers) bound.removeEventListener(event, listener);
    };
    update({
      viewOnly: bound.viewOnly,
      viewportMode: bound.scaleViewport ? 'scale' : bound.clipViewport ? 'clip' : 'native',
      drag: bound.dragViewport,
      desktopName: '',
    });
  }

  function connectedRfb() {
    if (state.connection !== 'connected' || !rfb) throw viewerError('NOT_CONNECTED', 'VNC 未连接');
    return rfb;
  }

  function requireGesture() {
    // Safari/WebView 可能没有 UserActivation API；有实现时才硬性拒绝跨窗口命令。
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw viewerError('USER_GESTURE_REQUIRED', '需要直接点击页面按钮');
    }
  }

  function execute(command, args = {}) {
    switch (command) {
      case 'connect':
        if (state.connection === 'connected' || state.connection === 'connecting') return getState();
        update({ connection: 'connecting' });
        try { options.connect(); } catch (error) { update({ connection: 'error' }); throw error; }
        return getState();
      case 'disconnect':
        connectedRfb();
        update({ connection: 'disconnecting' });
        options.disconnect();
        return getState();
      case 'reconnect':
        if (rfb && state.connection === 'connected') {
          update({ connection: 'disconnecting' });
          return options.reconnect();
        }
        update({ connection: 'connecting' });
        try { options.connect(); } catch (error) { update({ connection: 'error' }); throw error; }
        return getState();
      case 'focus':
        connectedRfb().focus();
        return getState();
      case 'toolbar.set':
        if (typeof args.visible !== 'boolean') throw viewerError('INVALID_ARGUMENT', 'visible 必须是布尔值');
        options.toolbar(args.visible);
        update({ toolbarVisible: args.visible });
        return getState();
      case 'keyboard.set': {
        if (typeof args.visible !== 'boolean') throw viewerError('INVALID_ARGUMENT', 'visible 必须是布尔值');
        if (args.visible) { connectedRfb(); requireGesture(); }
        options.keyboard(args.visible);
        update({ keyboardVisible: options.keyboardVisible() });
        return getState();
      }
      case 'key.send':
        if (!Number.isInteger(args.keysym) || args.keysym < 0) throw viewerError('INVALID_ARGUMENT', 'keysym 必须是非负整数');
        connectedRfb().sendKey(args.keysym, args.code ?? null, args.down);
        return getState();
      case 'text.send': {
        if (typeof args.text !== 'string') throw viewerError('INVALID_ARGUMENT', 'text 必须是字符串');
        const target = connectedRfb();
        for (const character of args.text) {
          const codePoint = character.codePointAt(0);
          target.sendKey(codePoint <= 0xff ? codePoint : 0x01000000 | codePoint, null);
        }
        return getState();
      }
      case 'clipboard.set':
        if (typeof args.text !== 'string') throw viewerError('INVALID_ARGUMENT', 'text 必须是字符串');
        connectedRfb().clipboardPasteFrom(args.text);
        return getState();
      case 'viewport.set': {
        if (!['scale', 'clip', 'native'].includes(args.mode)) throw viewerError('INVALID_ARGUMENT', '无效的 viewport mode');
        const target = connectedRfb();
        target.scaleViewport = args.mode === 'scale';
        target.clipViewport = args.mode === 'clip';
        target.dragViewport = args.mode === 'clip' && (args.drag ?? state.drag);
        options.viewport?.(args.mode, target.dragViewport);
        update({ viewportMode: args.mode, drag: target.dragViewport });
        return getState();
      }
      case 'viewOnly.set':
        if (typeof args.enabled !== 'boolean') throw viewerError('INVALID_ARGUMENT', 'enabled 必须是布尔值');
        connectedRfb().viewOnly = args.enabled;
        options.viewOnly?.(args.enabled);
        update({ viewOnly: args.enabled });
        return getState();
      case 'fullscreen.set': {
        if (typeof args.enabled !== 'boolean') throw viewerError('INVALID_ARGUMENT', 'enabled 必须是布尔值');
        requireGesture();
        const action = args.enabled ? document.documentElement.requestFullscreen?.bind(document.documentElement) : document.exitFullscreen?.bind(document);
        if (!action) throw viewerError('UNSUPPORTED', '浏览器不支持全屏');
        return action().then(() => { update({ fullscreen: Boolean(document.fullscreenElement) }); return getState(); });
      }
      default:
        throw viewerError('UNSUPPORTED', `不支持命令：${command}`);
    }
  }

  const onFullscreen = () => update({ fullscreen: Boolean(document.fullscreenElement) });
  document.addEventListener('fullscreenchange', onFullscreen);
  return {
    execute, getState, bindRfb, update,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { removeRfbListeners(); document.removeEventListener('fullscreenchange', onFullscreen); listeners.clear(); },
  };
}
