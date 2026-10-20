'use strict';
const path = require('path');
const { panelCloseDelay } = require('./config');

function contains(rect, point, margin = 0) {
  return point.x >= rect.x - margin && point.x < rect.x + rect.width + margin &&
    point.y >= rect.y - margin && point.y < rect.y + rect.height + margin;
}

function previewBounds(panel, workArea, anchorY = 0, kind = 'prompt') {
  const width = Math.min(kind === 'skill' ? 380 : 344, workArea.width);
  const height = Math.min(kind === 'skill' ? 680 : 530, workArea.height);
  const left = panel.x - width - 6;
  const right = panel.x + panel.width + 6;
  let x = left >= workArea.x ? left : right + width <= workArea.x + workArea.width ? right : panel.x;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  const top = panel.y + (Number.isFinite(anchorY) ? anchorY : 0);
  const y = Math.max(workArea.y, Math.min(top, workArea.y + workArea.height - height));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

// A separate, small native window avoids a full-height transparent hit area
// to the left of the drawer. The six-pixel crossing gap is kept alive by the
// shared cursor monitor; no mouse-event passthrough is necessary.
function createPreviewController({ BrowserWindow, screen, getPanel, getConfig, sendPanel, onOutside }) {
  let win = null, ready = false, payload = null, monitor = null, leftAt = 0, editing = false;
  const send = (channel, data) => {
    if (win && !win.isDestroyed() && ready) win.webContents.send(channel, data);
  };
  const isOpen = () => !!payload;
  function pointerInside() {
    const panel = getPanel();
    const point = screen.getCursorScreenPoint();
    if (panel && !panel.isDestroyed() && contains(panel.getBounds(), point)) return true;
    return !!(payload && win && !win.isDestroyed() && contains(win.getBounds(), point, 8));
  }
  function hide() {
    payload = null; leftAt = 0; editing = false;
    if (monitor) clearInterval(monitor);
    monitor = null;
    send('preview:hide');
    if (win && !win.isDestroyed()) win.hide();
    sendPanel('panel:preview-closed');
  }
  function startMonitor() {
    if (monitor) return;
    monitor = setInterval(() => {
      if (editing || pointerInside()) { leftAt = 0; return; }
      if (!leftAt) leftAt = Date.now();
      if (Date.now() - leftAt < panelCloseDelay(getConfig().panel.autoCollapseMs)) return;
      hide(); onOutside();
    }, 16);
  }
  function present() {
    if (!payload || !ready || !win || win.isDestroyed()) return;
    const panel = getPanel();
    if (!panel || panel.isDestroyed()) { hide(); return; }
    const bounds = panel.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    win.setBounds(previewBounds(bounds, area, payload.top, payload.kind));
    send('preview:item', payload);
    win.showInactive();
    if (payload.focus) win.focus();
    const shownWindow = win;
    // A background Windows launcher can swallow the first show operation.
    setImmediate(() => {
      if (payload && win === shownWindow && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    });
    sendPanel('panel:preview-active', { id: payload.item.id });
    leftAt = 0; startMonitor();
  }
  function show(next) {
    // 输入中不因掠过另一张卡片丢失当前编辑；失焦后草稿仍由渲染层保留。
    if (editing && payload?.item.id !== next.item.id) return false;
    // Avoid restarting video / resetting text selection on repeated hover.
    if (payload?.item.id === next.item.id && payload.kind === next.kind && !next.play && ready && win && !win.isDestroyed() && win.isVisible()) { leftAt = 0; if (next.focus) win.focus(); return true; }
    editing = false;
    payload = next;
    if (!win || win.isDestroyed()) {
      ready = false;
      win = new BrowserWindow({
        width: 344, height: 530, show: false, frame: false, transparent: true,
        resizable: false, movable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: true, backgroundColor: '#00000000',
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.once('closed', () => { win = null; ready = false; hide(); });
      win.webContents.once('did-finish-load', () => { ready = true; present(); });
      win.loadFile(path.join(__dirname, '..', 'src', 'preview.html')).catch(() => hide());
    } else present();
    return true;
  }
  function refresh(view, appearance) {
    if (!payload) return;
    const items = payload.kind === 'skill' ? view.skills || [] : view.prompts;
    const item = items.find((p) => p.id === payload.item.id);
    if (!item) { hide(); return; }
    payload = { ...payload, item, appearance, categories: view.skillState?.categories || [], play: false };
    send('preview:refresh', payload);
  }
  function destroy() { hide(); if (win && !win.isDestroyed()) win.destroy(); }
  function setEditing(state) {
    if (payload?.kind !== 'skill' || payload.item.id !== state?.id) return false;
    editing = !!state.active; leftAt = 0;
    sendPanel('panel:preview-editing', { id: payload.item.id, active: editing });
    return true;
  }
  function updateStats(state) {
    if (payload?.item.id !== state.id) return;
    payload.item.copyCount = state.count; send('stats:updated', state);
  }
  return { show, hide, isOpen, pointerInside, refresh, destroy, setEditing, updateStats, isEditing: () => editing };
}

module.exports = { createPreviewController, previewBounds, contains };
