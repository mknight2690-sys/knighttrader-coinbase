/*
 * Window System.
 *
 * Each dashboard panel becomes a movable / resizable window:
 *   - mousedown on a panel's drag region starts a drag
 *       - .panel-header on activity / growth / openPositions / recentClosed
 *       - a thin top band on the .summary-panel (which has no header)
 *   - drag updates a per-panel { dx, dy } offset applied via
 *     transform: translate3d(...) for performance
 *   - clicking anywhere in a panel raises it to the top of the focus
 *     stack (highest z-index)
 *   - corner / edge handles (n / ne / e / se / s / sw / w / nw) resize
 *     the panel via inline width / height
 *   - a minimize button (the small `—` in the top-right of each panel)
 *     hides the panel; clicking its taskbar entry restores it
 *   - layout persists to chrome.storage.local under
 *     `dashboard_window_layout`, keyed per panel id
 */

export const WINDOW_LAYOUT_STORAGE_KEY = 'dashboard_window_layout';
export const WINDOW_LAYOUT_VERSION = 2;
// Buffer above the taskbar — keeps a panel header band visible when a
// panel is dragged toward the bottom of the viewport.
const TITLE_BAR_HEIGHT_PX = 26;
const SUMMARY_DRAG_BAND_PX = 12;
const MIN_TITLE_VISIBLE_PX = 80;
const TASKBAR_HEIGHT_PX = 36;
const MINIMIZE_CONTROL_RESERVED_PX = 36;
const DRAG_THRESHOLD_PX = 2;
const MIN_PANEL_WIDTH_PX = 280;
const MIN_PANEL_HEIGHT_PX = 120;
const RESIZE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

const PANEL_IDS = [
  'summary',
  'activity',
  'growth',
  'closedTrades48h',
  'openPositions',
  'recentClosed',
];
const PANEL_LABELS = {
  summary: 'Account Summary',
  activity: 'Recent Activity',
  growth: 'Account Growth',
  closedTrades48h: 'Closed Trades 48H',
  openPositions: 'Open Positions',
  recentClosed: 'Recently Closed',
};

const state = {
  active: false,
  layout: { windows: {} },
  highestZ: 1,
  drag: null,
  resize: null,
  mouseDownHandler: null,
  mouseMoveHandler: null,
  mouseUpHandler: null,
  resizeMoveHandler: null,
  resizeUpHandler: null,
  clickHandler: null,
  storageChangeHandler: null,
};

export function panelIdForElement(el) {
  if (!el || !el.classList) return null;
  if (el.classList.contains('summary-panel')) return 'summary';
  if (el.classList.contains('activity-panel')) return 'activity';
  if (typeof el.getAttribute === 'function') {
    const key = el.getAttribute('data-resize-panel');
    if (key && PANEL_IDS.includes(key)) return key;
  }
  return null;
}

function findPanelElement(id) {
  if (id === 'summary') return document.querySelector('.summary-panel');
  if (id === 'activity') return document.querySelector('.activity-panel');
  return document.querySelector(`[data-resize-panel="${id}"]`);
}

function findEnclosingPanel(target) {
  let node = target;
  while (node && node !== document.body) {
    if (panelIdForElement(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function panelHeaderElement(panelEl) {
  if (!panelEl) return null;
  return panelEl.querySelector(':scope > .panel-header') || null;
}

function isOnDragRegion(panelEl, event) {
  if (!panelEl) return false;
  const rect = panelEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  // Reserve the right edge for the minimize button so a click on the
  // button never starts a drag.
  if (x > rect.width - MINIMIZE_CONTROL_RESERVED_PX && x < rect.width - 4) return false;
  const header = panelHeaderElement(panelEl);
  if (header) {
    const hRect = header.getBoundingClientRect();
    return event.clientY >= hRect.top && event.clientY <= hRect.bottom;
  }
  // .summary-panel has no header — use a thin top band.
  const y = event.clientY - rect.top;
  return y >= 0 && y <= SUMMARY_DRAG_BAND_PX;
}

export function clampWindowDelta({
  rect,
  currentDx,
  currentDy,
  requestedDx,
  requestedDy,
  viewport,
}) {
  const baseLeft = rect.left - currentDx;
  const baseTop = rect.top - currentDy;
  const minDx = MIN_TITLE_VISIBLE_PX - rect.width - baseLeft;
  const maxDx = viewport.width - MIN_TITLE_VISIBLE_PX - baseLeft;
  const minDy = -baseTop;
  const maxDy = viewport.height - TASKBAR_HEIGHT_PX - TITLE_BAR_HEIGHT_PX - baseTop;
  return {
    dx: Math.max(minDx, Math.min(maxDx, requestedDx)),
    dy: Math.max(minDy, Math.min(maxDy, requestedDy)),
  };
}

export function computeResize({
  edge,
  startW,
  startH,
  startDx,
  startDy,
  deltaX,
  deltaY,
  minW = MIN_PANEL_WIDTH_PX,
  minH = MIN_PANEL_HEIGHT_PX,
}) {
  let w = startW;
  let h = startH;
  let dx = startDx;
  let dy = startDy;
  if (edge.includes('e')) {
    w = Math.max(minW, startW + deltaX);
  }
  if (edge.includes('w')) {
    const proposedW = startW - deltaX;
    if (proposedW < minW) {
      dx = startDx + (startW - minW);
      w = minW;
    } else {
      dx = startDx + deltaX;
      w = proposedW;
    }
  }
  if (edge.includes('s')) {
    h = Math.max(minH, startH + deltaY);
  }
  if (edge.includes('n')) {
    const proposedH = startH - deltaY;
    if (proposedH < minH) {
      dy = startDy + (startH - minH);
      h = minH;
    } else {
      dy = startDy + deltaY;
      h = proposedH;
    }
  }
  return { w, h, dx, dy };
}

function ensureResizeHandles(panelEl) {
  if (!panelEl) return;
  if (panelEl.querySelector(':scope > .window-resize-handle')) return;
  for (const edge of RESIZE_EDGES) {
    const handle = document.createElement('div');
    handle.className = `window-resize-handle window-resize-${edge}`;
    handle.dataset.resizeEdge = edge;
    panelEl.appendChild(handle);
  }
}

function ensureMinimizeControl(panelEl) {
  if (!panelEl) return;
  if (panelEl.querySelector(':scope > .window-controls')) return;
  const wrap = document.createElement('div');
  wrap.className = 'window-controls';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'window-control window-minimize';
  btn.dataset.windowAction = 'minimize';
  btn.setAttribute('aria-label', 'Minimize');
  btn.title = 'Minimize';
  btn.textContent = '—';
  wrap.appendChild(btn);
  panelEl.appendChild(wrap);
}

function applyPanelState(panelEl, windowState) {
  if (!panelEl) return;
  if (!windowState) {
    panelEl.style.transform = '';
    panelEl.style.zIndex = '';
    panelEl.style.display = '';
    return;
  }
  if (windowState.minimized) {
    panelEl.style.display = 'none';
    return;
  }
  panelEl.style.display = '';
  const { dx = 0, dy = 0, z = 0, w = 0, h = 0 } = windowState;
  panelEl.style.transform = dx === 0 && dy === 0 ? '' : `translate3d(${dx}px, ${dy}px, 0)`;
  panelEl.style.zIndex = z ? String(z) : '';
  if (w) panelEl.style.width = `${w}px`;
  if (h) panelEl.style.height = `${h}px`;
}

function applyAllLayout() {
  for (const id of PANEL_IDS) {
    const el = findPanelElement(id);
    if (el) applyPanelState(el, state.layout.windows[id]);
  }
}

function getOrCreateWindow(id) {
  let win = state.layout.windows[id];
  if (!win) {
    win = { dx: 0, dy: 0, z: 0 };
    state.layout.windows[id] = win;
  }
  return win;
}

function bringToFront(id) {
  state.highestZ += 1;
  const win = getOrCreateWindow(id);
  win.z = state.highestZ;
  const el = findPanelElement(id);
  if (el) el.style.zIndex = String(state.highestZ);
  renderTaskbarEntries();
}

function activeVisiblePanelId() {
  let bestId = null;
  let bestZ = -1;
  for (const id of PANEL_IDS) {
    const win = state.layout.windows[id];
    if (!win || win.minimized) continue;
    const z = win.z || 0;
    if (z > bestZ) {
      bestZ = z;
      bestId = id;
    }
  }
  return bestId;
}

function renderTaskbarEntries() {
  if (!state.active) return;
  const container = document.getElementById('taskbarEntries');
  if (!container) return;
  const fragment = document.createDocumentFragment();
  for (const id of PANEL_IDS) {
    const win = state.layout.windows[id] || {};
    if (!findPanelElement(id)) continue;
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'taskbar-entry';
    if (win.minimized) entry.classList.add('is-minimized');
    entry.dataset.panelId = id;
    entry.textContent = PANEL_LABELS[id] || id;
    entry.title = PANEL_LABELS[id] || id;
    fragment.appendChild(entry);
  }
  container.replaceChildren(fragment);
}

function handleTaskbarEntryClick(id) {
  if (!id || !PANEL_IDS.includes(id)) return;
  const panel = findPanelElement(id);
  if (!panel) return;
  const scroller = document.querySelector('.page-shell') || document.documentElement;
  const top = panel.getBoundingClientRect().top + (scroller.scrollTop || document.documentElement.scrollTop || document.body.scrollTop);
  scroller.scrollTo({ top, behavior: 'smooth' });
}

function handleMinimizeClick(id) {
  if (!id || !PANEL_IDS.includes(id)) return;
  const win = getOrCreateWindow(id);
  win.minimized = true;
  applyAllLayout();
  renderTaskbarEntries();
  persistLayout().catch(() => {});
}

function onDocumentClick(event) {
  if (!state.active) return;
  const target = event.target;
  if (typeof target.closest !== 'function') return;
  const control = target.closest('.window-control');
  if (control) {
    const panelEl = findEnclosingPanel(control);
    const id = panelIdForElement(panelEl);
    if (id && control.dataset.windowAction === 'minimize') handleMinimizeClick(id);
    event.preventDefault();
    return;
  }
  const taskbarEntry = target.closest('.taskbar-entry');
  if (taskbarEntry) {
    handleTaskbarEntryClick(taskbarEntry.dataset.panelId);
    event.preventDefault();
    return;
  }
}

function persistLayout() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return Promise.resolve();
  return chrome.storage.local.set({
    [WINDOW_LAYOUT_STORAGE_KEY]: {
      version: WINDOW_LAYOUT_VERSION,
      windows: state.layout.windows,
    },
  });
}

function onMouseDown(event) {
  if (!state.active) return;
  if (event.button !== 0) return;

  const handle =
    typeof event.target.closest === 'function'
      ? event.target.closest('.window-resize-handle')
      : null;
  if (handle) {
    const panelEl = findEnclosingPanel(handle);
    const id = panelIdForElement(panelEl);
    if (!panelEl || !id) return;
    bringToFront(id);
    event.preventDefault();
    const rect = panelEl.getBoundingClientRect();
    const win = getOrCreateWindow(id);
    state.resize = {
      id,
      panelEl,
      edge: handle.dataset.resizeEdge,
      startX: event.clientX,
      startY: event.clientY,
      startW: win.w || rect.width,
      startH: win.h || rect.height,
      startDx: win.dx || 0,
      startDy: win.dy || 0,
      moved: false,
    };
    panelEl.classList.add('window-resizing');
    document.body.classList.add('is-resizing-window');
    window.addEventListener('mousemove', state.resizeMoveHandler);
    window.addEventListener('mouseup', state.resizeUpHandler);
    window.addEventListener('blur', state.resizeUpHandler);
    return;
  }

  const panelEl = findEnclosingPanel(event.target);
  if (!panelEl) return;
  const id = panelIdForElement(panelEl);
  if (!id) return;
  bringToFront(id);
  if (event.target.closest?.('.window-control')) return;
  if (!isOnDragRegion(panelEl, event)) return;
  event.preventDefault();
  const win = getOrCreateWindow(id);
  state.drag = {
    id,
    panelEl,
    startX: event.clientX,
    startY: event.clientY,
    startDx: win.dx || 0,
    startDy: win.dy || 0,
    moved: false,
  };
  panelEl.classList.add('window-dragging');
  document.body.classList.add('is-dragging-window');
  window.addEventListener('mousemove', state.mouseMoveHandler);
  window.addEventListener('mouseup', state.mouseUpHandler);
  window.addEventListener('blur', state.mouseUpHandler);
}

function onResizeMove(event) {
  const resize = state.resize;
  if (!resize) return;
  if (event.buttons === 0) {
    onResizeUp();
    return;
  }
  const deltaX = event.clientX - resize.startX;
  const deltaY = event.clientY - resize.startY;
  const result = computeResize({
    edge: resize.edge,
    startW: resize.startW,
    startH: resize.startH,
    startDx: resize.startDx,
    startDy: resize.startDy,
    deltaX,
    deltaY,
  });
  const win = getOrCreateWindow(resize.id);
  win.w = result.w;
  win.h = result.h;
  win.dx = result.dx;
  win.dy = result.dy;
  applyPanelState(resize.panelEl, win);
  if (
    !resize.moved &&
    (Math.abs(deltaX) > DRAG_THRESHOLD_PX || Math.abs(deltaY) > DRAG_THRESHOLD_PX)
  ) {
    resize.moved = true;
  }
}

function onResizeUp() {
  const resize = state.resize;
  if (!resize) return;
  resize.panelEl.classList.remove('window-resizing');
  document.body.classList.remove('is-resizing-window');
  window.removeEventListener('mousemove', state.resizeMoveHandler);
  window.removeEventListener('mouseup', state.resizeUpHandler);
  window.removeEventListener('blur', state.resizeUpHandler);
  const moved = resize.moved;
  state.resize = null;
  if (moved) {
    persistLayout().catch(() => {});
  }
}

function onMouseMove(event) {
  const drag = state.drag;
  if (!drag) return;
  if (event.buttons === 0) {
    onMouseUp();
    return;
  }
  const requestedDx = drag.startDx + (event.clientX - drag.startX);
  const requestedDy = drag.startDy + (event.clientY - drag.startY);
  const rect = drag.panelEl.getBoundingClientRect();
  const win = getOrCreateWindow(drag.id);
  const clamped = clampWindowDelta({
    rect,
    currentDx: win.dx || 0,
    currentDy: win.dy || 0,
    requestedDx,
    requestedDy,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  win.dx = clamped.dx;
  win.dy = clamped.dy;
  applyPanelState(drag.panelEl, win);
  if (
    !drag.moved &&
    (Math.abs(clamped.dx - drag.startDx) > DRAG_THRESHOLD_PX ||
      Math.abs(clamped.dy - drag.startDy) > DRAG_THRESHOLD_PX)
  ) {
    drag.moved = true;
  }
}

function onMouseUp() {
  const drag = state.drag;
  if (!drag) return;
  drag.panelEl.classList.remove('window-dragging');
  document.body.classList.remove('is-dragging-window');
  window.removeEventListener('mousemove', state.mouseMoveHandler);
  window.removeEventListener('mouseup', state.mouseUpHandler);
  window.removeEventListener('blur', state.mouseUpHandler);
  const moved = drag.moved;
  state.drag = null;
  if (moved) {
    persistLayout().catch(() => {});
  }
}

function migrateStoredWindows(stored) {
  // v1 carried minimized + maximized + closed + prevState; v2 only keeps
  // dx / dy / w / h / z / minimized. Close + maximize were removed with
  // the light theme. Strip the dropped fields so they don't leak into
  // subsequent writes.
  const migrated = {};
  for (const [id, win] of Object.entries(stored.windows || {})) {
    if (!win || typeof win !== 'object') continue;
    migrated[id] = {
      dx: Number.isFinite(Number(win.dx)) ? Number(win.dx) : 0,
      dy: Number.isFinite(Number(win.dy)) ? Number(win.dy) : 0,
      z: Number.isFinite(Number(win.z)) ? Number(win.z) : 0,
      w: Number.isFinite(Number(win.w)) && Number(win.w) > 0 ? Number(win.w) : 0,
      h: Number.isFinite(Number(win.h)) && Number(win.h) > 0 ? Number(win.h) : 0,
      minimized: !!win.minimized,
    };
  }
  return migrated;
}

async function loadStoredLayout() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { windows: {} };
  }
  try {
    const data = await chrome.storage.local.get(WINDOW_LAYOUT_STORAGE_KEY);
    const stored = data[WINDOW_LAYOUT_STORAGE_KEY];
    if (!stored || !stored.windows) return { windows: {} };
    return { windows: migrateStoredWindows(stored) };
  } catch {
    return { windows: {} };
  }
}

function highestZFromLayout(windows) {
  return Math.max(1, ...Object.values(windows || {}).map((w) => Number(w?.z) || 0));
}

function onStorageChange(changes, areaName) {
  if (areaName !== 'local') return;
  if (!state.active) return;
  if (state.drag || state.resize) return;
  const change = changes[WINDOW_LAYOUT_STORAGE_KEY];
  if (!change) return;
  const next = change.newValue;
  if (!next || !next.windows) {
    state.layout.windows = {};
  } else {
    state.layout.windows = migrateStoredWindows(next);
  }
  state.highestZ = highestZFromLayout(state.layout.windows);
  applyAllLayout();
  renderTaskbarEntries();
}

export async function initWindowSystem() {
  if (state.active) return;
  state.active = true;
  state.mouseDownHandler = onMouseDown;
  state.mouseMoveHandler = onMouseMove;
  state.mouseUpHandler = onMouseUp;
  state.resizeMoveHandler = onResizeMove;
  state.resizeUpHandler = onResizeUp;
  state.clickHandler = onDocumentClick;
  const stored = await loadStoredLayout();
  state.layout.windows = stored.windows;
  state.highestZ = highestZFromLayout(state.layout.windows);
  for (const id of PANEL_IDS) {
    const el = findPanelElement(id);
    if (!el) continue;
    ensureResizeHandles(el);
    ensureMinimizeControl(el);
  }
  applyAllLayout();
  renderTaskbarEntries();
  document.addEventListener('mousedown', state.mouseDownHandler, true);
  document.addEventListener('click', state.clickHandler, true);
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    state.storageChangeHandler = onStorageChange;
    chrome.storage.onChanged.addListener(state.storageChangeHandler);
  }
}

export async function resetWindowLayout() {
  state.layout.windows = {};
  state.highestZ = 1;
  if (state.active) {
    for (const id of PANEL_IDS) {
      const el = findPanelElement(id);
      if (!el) continue;
      el.style.width = '';
      el.style.height = '';
    }
    applyAllLayout();
    renderTaskbarEntries();
  }
  return persistLayout();
}

/**
 * Returns true if the user has dragged a corner / edge handle to give
 * the panel an explicit height. Used by the open-positions auto-fit
 * loop in dashboard.js / render-positions.js to skip auto-resizing
 * when the user is in manual control. h gets stored only when the
 * user actually resizes; reset clears it.
 */
export function isWindowPanelHeightManual(panelId) {
  const win = state.layout.windows?.[panelId];
  return Boolean(win && Number.isFinite(Number(win.h)) && Number(win.h) > 0);
}

export function __windowSystemStateForTests() {
  return state;
}
