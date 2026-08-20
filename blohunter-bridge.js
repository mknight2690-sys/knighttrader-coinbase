const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { BlohunterStorage } = require('./blohunter/storage');
const { createSseOffscreen } = require('./blohunter/sse-offscreen');
const { installNodeFetch } = require('./blohunter/node-https');
const { installEd25519Subtle } = require('./blohunter/ed25519-polyfill');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function resolveBlohunterConnectRoot() {
  const candidates = [
    path.join(__dirname, 'vendor', 'blohunter-connect'),
    path.join(require('os').homedir(), 'Downloads', 'blohunter-connect'),
  ];
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'src', 'dashboard', 'dashboard.html'))) return root;
  }
  return null;
}

function isPathInside(root, abs) {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Electron ships Node 18, which parses .js as CommonJS unless the nearest
// package.json declares "type": "module". System Node 22 auto-detects ESM,
// which is why smoke tests passed while the Trading tab showed
// "Unexpected token 'export'".
const ACCOUNT_EQUITY_HISTORY_KEY = 'accountEquityHistory';
const GROWTH_CANVAS_MIN_PX = 228;
const GROWTH_PANEL_MIN_PX = 340;
const EQUITY_DAY_MS = 24 * 60 * 60 * 1000;
const EQUITY_RANGE_OFFSETS_MS = [
  90 * EQUITY_DAY_MS,
  30 * EQUITY_DAY_MS,
  7 * EQUITY_DAY_MS,
  EQUITY_DAY_MS,
];

function normalizeEquityPoints(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((point) => ({
      at: Number.parseInt(point?.at, 10),
      equity: Number.parseFloat(point?.equity),
      baseline: Number.parseFloat(point?.baseline),
    }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.equity) && point.equity > 0)
    .sort((a, b) => a.at - b.at);
}

function equityAtTimestamp(history, timestamp, fallback) {
  const points = normalizeEquityPoints(history);
  if (!points.length) return fallback;
  if (timestamp <= points[0].at) return points[0].equity;
  if (timestamp >= points[points.length - 1].at) return points[points.length - 1].equity;
  const nextIndex = points.findIndex((point) => point.at >= timestamp);
  const previous = points[nextIndex - 1];
  const next = points[nextIndex];
  if (next.at === timestamp) return next.equity;
  const progress = (timestamp - previous.at) / Math.max(next.at - previous.at, 1);
  return previous.equity + (next.equity - previous.equity) * progress;
}

function mergeEquityRangeAnchors(history, liveEquity, settledEquity, now = Date.now()) {
  const byTimestamp = new Map();
  for (const point of normalizeEquityPoints(history)) {
    byTimestamp.set(point.at, {
      at: point.at,
      equity: point.equity,
      baseline: Number.isFinite(point.baseline) && point.baseline > 0 ? point.baseline : settledEquity,
    });
  }

  const anchors = [...EQUITY_RANGE_OFFSETS_MS.map((offset) => now - offset), now];
  for (const at of anchors) {
    const nearby = [...byTimestamp.values()].some((point) => Math.abs(point.at - at) <= 12 * 60 * 60 * 1000);
    if (nearby) continue;
    byTimestamp.set(at, {
      at,
      equity: at === now ? liveEquity : equityAtTimestamp(history, at, liveEquity),
      baseline: settledEquity,
    });
  }

  const current = byTimestamp.get(now);
  if (current) {
    current.equity = liveEquity;
    current.baseline = settledEquity;
  } else {
    byTimestamp.set(now, { at: now, equity: liveEquity, baseline: settledEquity });
  }

  return [...byTimestamp.values()]
    .sort((a, b) => a.at - b.at)
    .map((point) => ({
      at: point.at,
      equity: point.equity,
      baseline: Number.isFinite(point.baseline) && point.baseline > 0 ? point.baseline : settledEquity,
    }));
}

function ensureConnectEsmPackage(root) {
  if (!root) return;
  const pkgPath = path.join(root, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.type === 'module') return;
      pkg.type = 'module';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      return;
    }
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'blohunter-connect',
      private: true,
      type: 'module',
    }, null, 2));
  } catch (err) {
    throw new Error(`Could not mark BloHunter Connect as ESM: ${err.message}`);
  }
}

function readJsonFileSafe(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function resolveLocalStreamEndpoint(port) {
  const url = new URL(`http://127.0.0.1:${port}`);
  url.pathname = '/api/gateway/v3/stream';
  return url.toString();
}

async function isLocalHermesDashboardReady(port) {
  try {
    const candidates = [
      `http://127.0.0.1:${port}/api/health`,
      `http://127.0.0.1:${port}/api/status`,
      `http://127.0.0.1:${port}/`,
    ];
    for (const urlString of candidates) {
      const url = new URL(urlString);
      const ok = await new Promise((resolve) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(1200, () => {
          req.destroy();
          resolve({ ok: false });
        });
      });
      if (ok?.ok) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function isLocalStreamReachable(port) {
  try {
    const endpoint = resolveLocalStreamEndpoint(port);
    const url = new URL(endpoint);
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        const streamLike = res.statusCode === 200 && /text\/event-stream/.test(res.headers?.['content-type'] || '');
        res.resume();
        resolve(streamLike);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    // Do not treat 401/404 HEAD responses as reachable — they cause the bridge
    // to prefer a broken local endpoint instead of the default public stream.
    return false;
  } catch {
    return false;
  }
}

function parseHermesRunTimestamp(text, fileName) {
  const fromBody = String(text || '').match(/\*\*Run Time:\*\*\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/i);
  if (fromBody?.[1]) {
    const parsed = Date.parse(fromBody[1].replace(' ', 'T'));
    if (Number.isFinite(parsed)) return parsed;
  }
  const fromName = String(fileName || '').match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (fromName) {
    const parsed = Date.parse(`${fromName[1]}T${fromName[2]}:${fromName[3]}:${fromName[4]}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function summarizeHermesCronMarkdown(text) {
  const head = String(text || '').split(/\r?\n/, 8).join('\n');
  const failed = /\(FAILED\)/i.test(head);
  const ok = /\((OK|SUCCESS|COMPLETED)\)/i.test(head);
  const errLine =
    String(text || '').match(/RuntimeError:\s*[^\n]+/i)?.[0] ||
    String(text || '').match(/HTTP\s+\d+:\s*[^\n]+/i)?.[0] ||
    '';
  const section =
    String(text || '').match(/##\s*(?:Response|Output|Result|Error|Delivery)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] ||
    '';
  let body = String(section || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\[SILENT\]$/i.test(body)) body = 'silent (nothing new)';
  if (body.length > 140) body = `${body.slice(0, 137)}...`;
  if (errLine) {
    const cleaned = errLine
      .replace(/\s+/g, ' ')
      .replace(/Please go visit the portal to sort that out:\s*https:\/\/portal\.nousresearch\.com\s*/i, '')
      .trim()
      .slice(0, 140);
    return { ok: false, summary: cleaned };
  }
  if (failed) return { ok: false, summary: body || 'cron tick failed' };
  if (ok) return { ok: true, summary: body || 'cron tick completed' };
  return { ok: !failed, summary: body || 'cron tick finished' };
}

function hermesActivityType(ok, summary) {
  const label = String(summary || '').replace(/\s+/g, ' ').trim() || (ok ? 'cron tick' : 'cron error');
  // Put the full line in `type` so formatActivityLabel shows it verbatim
  // (ACTIVITY_LABELS falls through to entry.type).
  return ok ? `Hermes · ${label}` : `Hermes error · ${label}`;
}

function createChromeMock(storage, { dispatchRuntimeMessage, log = () => {} }) {
  const runtimeListeners = new Set();
  const alarmListeners = new Set();
  const alarms = new Map();

  const localApi = {
    get: (keys, callback) => {
      const value = Promise.resolve(storage.pick('local', keys));
      if (typeof callback === 'function') {
        value.then((result) => callback(result));
        return undefined;
      }
      return value;
    },
    set: (items, callback) => {
      const value = Promise.resolve(storage.setArea('local', items));
      if (typeof callback === 'function') {
        value.then(() => callback());
        return undefined;
      }
      return value;
    },
    remove: (keys, callback) => {
      const value = Promise.resolve(storage.removeArea('local', keys));
      if (typeof callback === 'function') {
        value.then(() => callback());
        return undefined;
      }
      return value;
    },
    clear: () => Promise.resolve(storage.setArea('local', Object.fromEntries(Object.keys(storage.local).map((k) => [k, undefined])))),
  };

  const sessionApi = {
    get: (keys, callback) => {
      const value = Promise.resolve(storage.pick('session', keys));
      if (typeof callback === 'function') {
        value.then((result) => callback(result));
        return undefined;
      }
      return value;
    },
    set: (items, callback) => {
      const value = Promise.resolve(storage.setArea('session', items));
      if (typeof callback === 'function') {
        value.then(() => callback());
        return undefined;
      }
      return value;
    },
    remove: (keys, callback) => {
      const value = Promise.resolve(storage.removeArea('session', keys));
      if (typeof callback === 'function') {
        value.then(() => callback());
        return undefined;
      }
      return value;
    },
    clear: () => Promise.resolve(storage.removeArea('session', Object.keys(storage.session))),
  };

  const runtime = {
    id: 'knight-trader-blohunter',
    sendMessage: (msg) => dispatchRuntimeMessage(msg, { id: 'renderer' }),
    onMessage: {
      addListener(fn) { runtimeListeners.add(fn); },
      removeListener(fn) { runtimeListeners.delete(fn); },
      hasListener(fn) { return runtimeListeners.has(fn); },
    },
    getURL(relativePath) {
      const rel = String(relativePath || '').replace(/^\/+/, '');
      return `bh://local/${rel}`;
    },
  };

  const offscreen = {
    async hasDocument() { return false; },
    async createDocument() { return true; },
    async closeDocument() { return true; },
  };

  const chromeAlarms = {
    create(name, info = {}) {
      const delay = Number(info.delayInMinutes || 0) * 60 * 1000;
      const period = Number(info.periodInMinutes || 0) * 60 * 1000;
      const when = Number(info.when || 0);
      alarms.set(name, {
        scheduledTime: when > 0 ? when : Date.now() + (delay || period || 60000),
        periodInMinutes: info.periodInMinutes || null,
      });
    },
    get(name) {
      const alarm = alarms.get(name);
      return Promise.resolve(alarm ? { name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes } : undefined);
    },
    getAll() {
      return Promise.resolve([...alarms.entries()].map(([name, alarm]) => ({
        name,
        scheduledTime: alarm.scheduledTime,
        periodInMinutes: alarm.periodInMinutes,
      })));
    },
    clear(name) {
      const existed = alarms.delete(name);
      return Promise.resolve(existed);
    },
    onAlarm: {
      addListener(fn) { alarmListeners.add(fn); },
      removeListener(fn) { alarmListeners.delete(fn); },
    },
  };

  setInterval(() => {
    const now = Date.now();
    for (const [name, alarm] of alarms.entries()) {
      if (alarm.scheduledTime <= now) {
        for (const fn of alarmListeners) {
          try { fn({ name }); } catch (err) { log('[alarms]', err.message); }
        }
        if (alarm.periodInMinutes) {
          alarm.scheduledTime = now + alarm.periodInMinutes * 60 * 1000;
        } else {
          alarms.delete(name);
        }
      }
    }
  }, 1000).unref?.();

  async function invokeRuntimeListener(listener, msg, sender) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const sendResponse = (response) => finish(response);
      let keepOpen;
      try {
        keepOpen = listener(msg, sender, sendResponse);
      } catch (err) {
        reject(err);
        return;
      }
      if (keepOpen && typeof keepOpen.then === 'function') {
        Promise.resolve(keepOpen).then((value) => {
          if (value === true) return;
          if (!settled) finish(value);
        }).catch(reject);
        return;
      }
      if (keepOpen === true) return;
      // Chrome still delivers a synchronous sendResponse after a `return;` —
      // wait a tick before treating the listener as silent.
      queueMicrotask(() => {
        if (!settled) {
          if (msg?.type === 'get-dashboard-data') {
            log(`[runtime] silent listener type=${msg.type} keepOpen=${keepOpen}`);
          }
          finish(undefined);
        }
      });
    });
  }

  async function dispatchToListeners(msg, sender) {
    let lastResponse;
    const listeners = [...runtimeListeners];
    if (!listeners.length) {
      log(`[runtime] no listeners for ${msg?.type || 'unknown'}`);
    }
    for (const listener of listeners) {
      try {
        const result = await invokeRuntimeListener(listener, msg, sender);
        if (result !== undefined) lastResponse = result;
      } catch (err) {
        log('[runtime listener]', err.message);
        lastResponse = { ok: false, msg: err.message };
      }
    }
    return lastResponse;
  }

  const noopEmitter = () => ({
    addListener() {},
    removeListener() {},
    hasListener() { return false; },
  });

  const chrome = {
    runtime,
    storage: {
      local: localApi,
      session: sessionApi,
      onChanged: {
        addListener(fn) { storage.on('changed', fn); },
        removeListener(fn) { storage.off('changed', fn); },
      },
    },
    offscreen,
    alarms: chromeAlarms,
    tabs: { onRemoved: noopEmitter() },
    windows: { onRemoved: noopEmitter() },
  };

  return { chrome, dispatchToListeners, messageListenerCount: () => runtimeListeners.size };
}

class BlohunterBridge {
  constructor({ userDataPath, hermesHome, hermesDashboardPort = 9130, deskHttpPort = 9140, log = () => {} }) {
    this.log = log;
    this.userDataPath = userDataPath;
    this.hermesHome = hermesHome || path.join(userDataPath, 'hermes-coinbase');
    this.hermesDashboardPort = hermesDashboardPort;
    this.deskHttpPort = deskHttpPort;
    this.storagePath = path.join(userDataPath, 'blohunter-storage-coinbase.json');
    this.storage = new BlohunterStorage(this.storagePath);
    this.connectRoot = resolveBlohunterConnectRoot();
    this.runtime = null;
    this.sse = null;
    this.backgroundReady = false;
    this.backgroundPromise = null;
    this.webContents = null;
    this.started = false;
    this.demoMode = false;
    this.httpServer = null;
    this.httpPort = 0;
    this.gateTimer = null;
    this.handshakeTimer = null;
    this.dashboardFetchTail = Promise.resolve();
    this.lastKnownOpenPositions = [];
    this.lastKnownOpenPositionKeys = new Set();
  }

  getConnectRoot() {
    return this.connectRoot;
  }

  getDashboardUrl() {
    if (!this.connectRoot || !this.httpPort) return null;
    return `http://127.0.0.1:${this.httpPort}/src/dashboard/dashboard.html`;
  }

  setWebContents(webContents) {
    this.webContents = webContents;
  }

  broadcastStorageChanged(changes, area) {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    this.webContents.send('bh-storage-changed', changes, area);
  }

  async syncCredentials({ apiKey, secretKey, passphrase, demoMode = false }) {
    this.demoMode = !!demoMode;
    this.storage.load();
    const now = Date.now();
    await this.storage.setArea('session', {
      apiKey: String(apiKey || '').trim(),
      secret: String(secretKey || '').trim(),
      passphrase: String(passphrase || '').trim(),
      vault_unlocked: true,
      vault_unlocked_at: now,
    });
    await this.storage.setArea('local', {
      blofin_vault_configured: true,
      enabled: true,
      gateway_sse_v3_execute_enabled: true,
      gateway_sse_v3_close_risk_enabled: true,
      gateway_sse_v3_open_dca_enabled: true,
      gateway_sse_version: 'v3',
      dashboard_sound_enabled: true,
    });
    await this.applyDesktopTradingGate();
  }

  async clearGatewayReplayCursor(reason = 'desktop-start') {
    this.storage.load();
    await this.storage.setArea('local', {
      // Clearing the replay cursor must not fake a gateway `resync-required`
      // event — that freezes the Signal pill on "resync required" even after
      // a verified snapshot arrives.
      gateway_v3_resync_required: false,
      gateway_v3_trusted_event_id: '',
      gateway_v3_transport_last_event_id: '',
      gateway_v3_transport_last_event_id_at: 0,
      gateway_v3_recovery_active: false,
      gateway_v3_recovery_requested_at: 0,
      gateway_v3_recovery_requested_cursor_event_id: '',
      gateway_v3_recovery_cursor_source: '',
      gateway_v3_recovery_cursor_query_used: false,
      gateway_v3_recovery_cursor_query_event_id: '',
      gateway_v3_recovery_cursor_query_source: '',
      gateway_v3_recovery_query_suppressed_reason: '',
      gateway_sse_endpoint: '',
      sse_awaiting_snapshot: false,
      sse_snapshot_wait_reason: '',
      sse_snapshot_wait_started_at: 0,
      sse_signal_phase: 'reconnecting',
    });
    this.log(`[BloHunter] Cleared SSE replay cursor (${reason})`);
  }

  async refreshGatewaySignal(reason = 'desktop-resync') {
    await this.clearGatewayReplayCursor(reason);
    if (this.sse) {
      await this.sse.restart(reason);
    }
  }

  async applyDesktopTradingGate() {
    const now = Date.now();
    const current = this.storage.pick('local', ['apilock_last_verified_ip', 'apilock_route_last_ip']);
    const verifiedIp = String(current.apilock_last_verified_ip || current.apilock_route_last_ip || '127.0.0.1').trim()
      || '127.0.0.1';
    await this.storage.setArea('local', {
      enabled: true,
      apilock_country: '',
      apilock_violated: false,
      apilock_violated_at: 0,
      runtime_apilock_gate_armed: true,
      apilock_gate_boot_at: now - 1000,
      apilock_last_verified_at: now,
      apilock_last_verified_country: '',
      apilock_last_verified_ip: verifiedIp,
      apilock_route_last_country: '',
      apilock_route_last_ip: verifiedIp,
      apilock_route_last_checked_at: now,
      apilock_exchange_blocked_route_unverified_at: 0,
      apilock_recovery_observed_mismatch_at: 0,
      apilock_recovery_trusted_candidate_since: 0,
      apilock_recovery_trusted_confirmation_count: 0,
      blofin_cooldown_until: 0,
    });
    if (!this.connectRoot) return;
    try {
      const clientPath = path.join(this.connectRoot, 'src', 'blofin', 'client.js');
      const client = await import(pathToFileURL(clientPath).href);
      client.setRuntimeApilockGateArmed?.(true, { persist: true });
    } catch (err) {
      this.log('[BloHunter] API lock bypass:', err.message);
    }
  }

  ensureGrowthChartLayout() {
    const current = this.storage.pick('local', ['dashboard_panel_layout', 'dashboard_window_layout']);
    const layout = current.dashboard_panel_layout && typeof current.dashboard_panel_layout === 'object'
      ? current.dashboard_panel_layout
      : { version: 1, panels: {} };
    const panels = { ...(layout.panels || {}) };
    const growthHeight = Number(panels.growth);
    if (!Number.isFinite(growthHeight) || growthHeight < GROWTH_CANVAS_MIN_PX) {
      panels.growth = GROWTH_CANVAS_MIN_PX;
    }

    const patch = {
      dashboard_panel_layout: {
        version: Number(layout.version) || 1,
        panels,
      },
    };

    const windows = current.dashboard_window_layout?.windows;
    if (windows?.growth && Number(windows.growth.h) > 0 && Number(windows.growth.h) < GROWTH_PANEL_MIN_PX) {
      patch.dashboard_window_layout = {
        ...current.dashboard_window_layout,
        windows: {
          ...windows,
          growth: { ...windows.growth, h: GROWTH_PANEL_MIN_PX },
        },
      };
    }

    this.storage.setArea('local', patch);
  }

  startDesktopGateKeeper() {
    if (this.gateTimer) return;
    this.applyDesktopTradingGate().catch(() => {});
    this.gateTimer = setInterval(() => {
      this.applyDesktopTradingGate().catch((err) => {
        this.log('[BloHunter] API lock refresh:', err.message);
      });
    }, 8000);
    this.gateTimer.unref?.();
  }

  startHandshakeWatchdog() {
    if (this.handshakeTimer) return;
    let attempts = 0;
    const tick = () => {
      this.ensureGatewayHandshake(`watchdog-${attempts + 1}`).then((ok) => {
        if (ok && this.handshakeTimer) {
          clearInterval(this.handshakeTimer);
          this.handshakeTimer = null;
        }
      }).catch((err) => {
        this.log('[BloHunter] Handshake watchdog:', err.message);
      });
      attempts += 1;
      if (attempts >= 5 && this.handshakeTimer) {
        clearInterval(this.handshakeTimer);
        this.handshakeTimer = null;
      }
    };
    this.handshakeTimer = setInterval(tick, 10000);
    this.handshakeTimer.unref?.();
  }

  async ensureGatewayHandshake(reason = 'handshake') {
    this.storage.load();
    const state = this.storage.pick('local', [
      'gateway_v3_snapshot_status',
      'gateway_v3_capabilities_status',
      'server_policy_status',
      'sse_awaiting_snapshot',
      'sse_signal_phase',
    ]);
    const snapshotVerified = state.gateway_v3_snapshot_status === 'verified';
    const capabilitiesVerified = state.gateway_v3_capabilities_status === 'verified';
    const policyValid = state.server_policy_status === 'valid';
    if (snapshotVerified && capabilitiesVerified && policyValid) {
      if (state.sse_awaiting_snapshot === true) {
        await this.storage.setArea('local', {
          sse_awaiting_snapshot: false,
          sse_snapshot_wait_reason: '',
          sse_signal_phase: 'connected',
        });
      }
      return true;
    }
    this.log(`[BloHunter] Gateway handshake incomplete (${reason}): snapshot=${state.gateway_v3_snapshot_status || 'none'} capabilities=${state.gateway_v3_capabilities_status || 'none'} policy=${state.server_policy_status || 'none'}`);
    await this.clearGatewayReplayCursor(reason);
    if (this.sse) await this.sse.restart(reason);
    return false;
  }

  async seedEquityCurveFromAccount() {
    if (!this.connectRoot) return;
    this.storage.load();
    const keys = this.storage.pick('session', ['apiKey']);
    if (!String(keys.apiKey || '').trim()) {
      this.ensureGrowthChartLayout();
      this.log('[BloHunter] Equity curve: waiting for Blofin keys');
      return;
    }
    await this.applyDesktopTradingGate();
    for (let i = 0; i < 25 && !this.sse?.isConnected?.(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    let snapshot = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      snapshot = await this.dispatchRuntimeMessage({ type: 'get-dashboard-data' });
      if (snapshot?.ok && Number(snapshot.data?.balances?.totalEquity) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 800));
      await this.applyDesktopTradingGate();
    }
    const equity = Number(snapshot?.data?.balances?.totalEquity || 0);
    const settled = Number(snapshot?.data?.balances?.settledEquity || equity);
    this.ensureGrowthChartLayout();
    if (!(equity > 0)) {
      this.log('[BloHunter] Equity curve: no account value yet', snapshot?.msg || '');
      return;
    }
    const statePath = path.join(this.connectRoot, 'src', 'trading', 'state.js');
    const state = await import(pathToFileURL(statePath).href);
    const existing = await state.getAccountEquityHistory();
    const now = Date.now();
    const merged = mergeEquityRangeAnchors(existing, equity, settled, now);
    this.storage.setArea('local', { [ACCOUNT_EQUITY_HISTORY_KEY]: merged });
    this.log(`[BloHunter] Equity curve seeded at ${equity.toFixed(2)} USDT across 1D/1W/1M/3M (${merged.length} points)`);
    this.nudgeEquityChart();
  }

  nudgeEquityChart() {
    const wc = this.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  }

  readHermesActivityEntries(limit = 24) {
    const entries = [];
    const jobsPath = path.join(this.hermesHome, 'cron', 'jobs.json');
    const jobNames = new Map();
    try {
      if (fs.existsSync(jobsPath)) {
        const jobsDoc = readJsonFileSafe(jobsPath);
        for (const job of jobsDoc.jobs || []) {
          const id = String(job.id || '').trim();
          const name = String(job.name || id || 'hermes').trim();
          if (id) jobNames.set(id, name);
          const at = Date.parse(job.last_run_at || '') || 0;
          if (!at) continue;
          const status = String(job.last_status || '').toLowerCase();
          const ok = status && !['error', 'failed', 'fail'].includes(status);
          const err = String(job.last_error || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const summary = ok
            ? `${name} ${status || 'ok'}`
            : `${name} ${status || 'error'}${err ? `: ${err}` : ''}`;
          entries.push({
            type: hermesActivityType(ok, summary),
            loggedAt: at,
            symbol: '',
            side: '',
            reason: '',
          });
        }
      }
    } catch (err) {
      this.log('[BloHunter] Hermes jobs read:', err.message);
    }

    const outputRoot = path.join(this.hermesHome, 'cron', 'output');
    try {
      if (fs.existsSync(outputRoot)) {
        const files = [];
        for (const jobDir of fs.readdirSync(outputRoot, { withFileTypes: true })) {
          if (!jobDir.isDirectory()) continue;
          const jobId = jobDir.name;
          const dir = path.join(outputRoot, jobId);
          for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.md')) continue;
            const full = path.join(dir, name);
            let mtime = 0;
            try {
              mtime = fs.statSync(full).mtimeMs;
            } catch {
              mtime = 0;
            }
            files.push({ full, name, jobId, mtime });
          }
        }
        files.sort((a, b) => b.mtime - a.mtime);
        for (const file of files.slice(0, limit)) {
          let text = '';
          try {
            text = fs.readFileSync(file.full, 'utf8');
          } catch {
            continue;
          }
          const { ok, summary } = summarizeHermesCronMarkdown(text);
          const jobName = jobNames.get(file.jobId) || file.jobId;
          const loggedAt = parseHermesRunTimestamp(text, file.name) || file.mtime || Date.now();
          entries.push({
            type: hermesActivityType(ok, `${jobName}: ${summary}`),
            loggedAt,
            symbol: '',
            side: '',
            reason: '',
          });
        }
      }
    } catch (err) {
      this.log('[BloHunter] Hermes output read:', err.message);
    }

    const byKey = new Map();
    for (const entry of entries) {
      const key = `${entry.loggedAt}|${entry.type}`;
      if (!byKey.has(key)) byKey.set(key, entry);
    }
    return [...byKey.values()]
      .sort((a, b) => Number(b.loggedAt || 0) - Number(a.loggedAt || 0))
      .slice(0, limit);
  }

  async markBlofinApiHealthy() {
    const now = Date.now();
    await this.storage.setArea('local', {
      blofin_api_ok: true,
      blofin_api_msg: '',
      blofin_api_checked_at: now,
    });
    return now;
  }

  liveAvailableFromSnapshot(data) {
    const stated = Number(data?.balances?.totalAvailable);
    if (Number.isFinite(stated) && stated > 0) return stated;
    const rows = Array.isArray(data?.balances?.account) ? data.balances.account : [];
    let sum = 0;
    for (const row of rows) {
      const n = Number.parseFloat(
        row?.available ?? row?.availableBalance ?? row?.availableEquity ?? row?.availBal
      );
      if (Number.isFinite(n)) sum += n;
    }
    return sum;
  }

  async enrichDashboardSnapshot(result) {
    if (!result || typeof result !== 'object') return result;
    if (!result.ok || !result.data || typeof result.data !== 'object') {
      return result;
    }

    const data = result.data;
    if (!data.balances || typeof data.balances !== 'object') {
      data.balances = {};
    }
    const accountRows = Array.isArray(data.balances.account) ? data.balances.account : [];
    const liveAvailable = this.liveAvailableFromSnapshot(data);
    if (!(Number(data.balances.totalAvailable) > 0) && liveAvailable > 0) {
      data.balances.totalAvailable = liveAvailable;
    }
    const equity = Number(data.balances.totalEquity);
    const liveBalance = accountRows.length > 0 || liveAvailable > 0 || equity > 0;
    if (liveBalance && accountRows.length > 0) {
      const now = await this.markBlofinApiHealthy();
      if (data.profile && typeof data.profile === 'object') {
        data.profile.blofinApiOk = true;
        data.profile.blofinApiKnown = true;
        data.profile.blofinApiFresh = true;
        data.profile.blofinApiCheckedAt = now;
        data.profile.blofinApiMsg = '';
        data.profile.blofinMonitoringSuspended = false;
      }
    }

    if (data.profile && typeof data.profile === 'object') {
      const snapshotVerified = String(data.profile.gatewayV3SnapshotStatus || '') === 'verified';
      const connected = data.profile.signalConnected === true
        || String(data.profile.syncHealth?.signalPhase || '') === 'connected';
      if (snapshotVerified && connected) {
        data.profile.gatewayV3ResyncRequired = false;
        await this.storage.setArea('local', { gateway_v3_resync_required: false });
      }
    }

    // Flaky positions reads should not red-banner a desk that already has equity.
    if (
      data.errorMessage &&
      /open positions/i.test(String(data.errorMessage)) &&
      Number.isFinite(equity)
    ) {
      data.errorMessage = '';
      data.openPositionsUnavailable = false;
      if (!Array.isArray(data.openPositions)) data.openPositions = [];
    }

    if (Array.isArray(data.openPositions)) {
      this.lastKnownOpenPositions = data.openPositions.slice();
      this.lastKnownOpenPositionKeys = new Set(
        this.lastKnownOpenPositions.map((p) => {
          const symbol = String(p?.contract || p?.symbol || p?.pair || '').trim().toUpperCase();
          const side = String(p?.side || '').trim().toLowerCase();
          return `${symbol}:${side}`;
        }),
      );
    }

    data.recentActivity = this.readHermesActivityEntries();
    return result;
  }

  async loadDashboardSnapshot(msg, sender) {
    const listenerCount = this.runtime.messageListenerCount?.() ?? 0;
    const request = {
      ...(msg && typeof msg === 'object' ? msg : {}),
      type: 'get-dashboard-data',
      source: 'blohunter-popup',
    };
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      result = await this.runtime.dispatchToListeners(request, sender);
      if (result !== undefined) break;
      this.log(`[BloHunter] get-dashboard-data got no response (${listenerCount} listeners, try ${attempt + 1})`);
    }
    const positionsFailed =
      result?.ok &&
      result?.data?.errorMessage &&
      /open positions/i.test(String(result.data.errorMessage));
    if (positionsFailed) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      const retry = await this.runtime.dispatchToListeners(msg, sender);
      if (retry?.ok) result = retry;
    }
    return this.enrichDashboardSnapshot(result);
  }

  async dispatchRuntimeMessage(msg, sender = { id: 'dashboard' }) {
    if (!this.runtime) {
      return { ok: false, msg: 'BloHunter runtime not started' };
    }
    if (msg?.type === 'restart-sse') {
      await this.sse?.restart(msg.reason || 'manual');
      return { ok: true };
    }
    if (msg?.type === 'get-dashboard-data') {
      const run = this.dashboardFetchTail.then(
        () => this.loadDashboardSnapshot(msg, sender),
        () => this.loadDashboardSnapshot(msg, sender)
      );
      this.dashboardFetchTail = run.catch(() => {});
      return run;
    }
    return this.runtime.dispatchToListeners(msg, sender);
  }

  async ensureBackground() {
    if (this.backgroundReady) return true;
    if (this.backgroundPromise) return this.backgroundPromise;
    this.backgroundPromise = this._loadBackground().catch((err) => {
      this.backgroundPromise = null;
      throw err;
    });
    return this.backgroundPromise;
  }

  async _loadBackground() {
    if (!this.connectRoot) {
      throw new Error('BloHunter Connect source not found. Install blohunter-connect under Downloads.');
    }
    installNodeFetch();
    installEd25519Subtle();
    ensureConnectEsmPackage(this.connectRoot);
    this.storage.load();

    const sendToBackground = async (msg) => this.runtime.dispatchToListeners(msg, { id: 'blohunter-offscreen' });

    this.runtime = createChromeMock(this.storage, {
      dispatchRuntimeMessage: (msg) => this.dispatchRuntimeMessage(msg),
      log: this.log,
    });
    globalThis.chrome = this.runtime.chrome;
    global.chrome = this.runtime.chrome;

    this.storage.on('changed', (changes, area) => {
      this.broadcastStorageChanged(changes, area);
    });

    const gatewayModulePath = path.join(this.connectRoot, 'src', 'shared', 'gatewaySse.js');
    const gatewayModule = await import(pathToFileURL(gatewayModulePath).href);
    const baseReadGatewaySseConfig = gatewayModule.readGatewaySseConfig;
    const dashboardPort = this.hermesDashboardPort;
    const readGatewaySseConfig = async () => {
      this.log('[BloHunter] readGatewaySseConfig called');
      try {
        const dashboardReady = await isLocalHermesDashboardReady(dashboardPort);
        this.log(`[BloHunter] Local Hermes dashboard ready=${dashboardReady} (port ${dashboardPort})`);
        if (!dashboardReady) {
          this.log(`[BloHunter] Local Hermes dashboard not reachable on 127.0.0.1:${dashboardPort}, using default stream config`);
          return baseReadGatewaySseConfig();
        }

        const localReachable = await isLocalStreamReachable(dashboardPort);
        this.log(`[BloHunter] Local Hermes stream reachable=${localReachable}`);
        if (localReachable) {
          const endpoint = resolveLocalStreamEndpoint(dashboardPort);
          this.log(`[BloHunter] Using local Hermes stream: ${endpoint}`);
          return {
            version: 'v3',
            endpoint,
            v3ReplayCursor: {
              eventId: '',
              source: '',
              suppressed: false,
              suppressedReason: '',
              cursorUsed: false,
            },
          };
        }

        this.log('[BloHunter] Local Hermes dashboard reachable, but local stream endpoint not reachable/authorized; using default stream config');
      } catch (err) {
        this.log(`[BloHunter] Local stream probe failed: ${err.message}`);
      }
      return baseReadGatewaySseConfig();
    };

    this.sse = createSseOffscreen({
      sendToBackground,
      readGatewaySseConfig,
      log: this.log,
    });

    const bgEntry = path.join(this.connectRoot, 'src', 'background', 'index.js');
    this.log('[BloHunter] Loading background runtime…');
    await import(pathToFileURL(bgEntry).href);
    this.log(`[BloHunter] Runtime listeners: ${this.runtime.messageListenerCount?.() ?? 0}`);
    await this.applyDesktopTradingGate();
    // Stale lastEventId cursors (kept "fresh" by heartbeats) block policy+snapshot
    // handshake and leave the desk stuck on "awaiting snapshot".
    await this.clearGatewayReplayCursor('bridge-startup');
    await this.sse.start('bridge-startup');
    this.backgroundReady = true;
    this.log('[BloHunter] Background runtime ready');
    return true;
  }

  async start(creds) {
    const runSeed = () => this.seedEquityCurveFromAccount().catch((err) => {
      this.log('[BloHunter] Equity seed:', err.message);
    });
    if (this.started) {
      if (creds) await this.syncCredentials(creds);
      await this.ensureHttpServer();
      this.startDesktopGateKeeper();
      this.startHandshakeWatchdog();
      const signal = this.storage.pick('local', [
        'sse_awaiting_snapshot',
        'sse_signal_phase',
        'gateway_v3_snapshot_status',
      ]);
      const snapshotVerified = signal.gateway_v3_snapshot_status === 'verified';
      if (
        !snapshotVerified && (
          signal.sse_awaiting_snapshot === true
          || signal.sse_signal_phase === 'handshaking'
          || signal.sse_signal_phase === 'reconnecting'
        )
      ) {
        await this.refreshGatewaySignal('trading-tab-resync');
      }
      runSeed();
      return { ok: true, url: this.getDashboardUrl(), already: true };
    }
    if (!this.connectRoot) {
      return {
        ok: false,
        error: 'BloHunter Connect not found. Expected Downloads\\blohunter-connect with src\\dashboard\\dashboard.html',
      };
    }
    try {
      await this.syncCredentials(creds || {});
      await this.ensureHttpServer();
      await this.ensureBackground();
      this.startDesktopGateKeeper();
      this.startHandshakeWatchdog();
      this.ensureGrowthChartLayout();
      this.started = true;
      runSeed();
      return { ok: true, url: this.getDashboardUrl(), root: this.connectRoot };
    } catch (err) {
      this.log('[BloHunter] start failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  async stop() {
    if (this.handshakeTimer) {
      clearInterval(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.gateTimer) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    this.sse?.stop();
    if (this.httpServer) {
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 1500);
        this.httpServer.close(() => {
          clearTimeout(timer);
          done();
        });
        this.httpServer.closeAllConnections?.();
      });
      this.httpServer = null;
      this.httpPort = 0;
    }
    this.started = false;
    this.backgroundReady = false;
    this.backgroundPromise = null;
    return { ok: true };
  }

  getStatus() {
    return {
      started: this.started,
      backgroundReady: this.backgroundReady,
      connectRoot: this.connectRoot,
      dashboardUrl: this.getDashboardUrl(),
      sseConnected: this.sse?.isConnected?.() || false,
      openPositions: Array.isArray(this.lastKnownOpenPositions) ? this.lastKnownOpenPositions : [],
    };
  }

  injectDashboardHtml(html) {
    html = html.replace(/<title>BloHunter Connect<\/title>/i, '<title>KnightTrader</title>');
    if (!html.includes('__kt__/chrome-shim.js')) {
      html = html.replace(
        /<head([^>]*)>/i,
        '<head$1>\n    <script src="/__kt__/chrome-shim.js"></script>',
      );
    }
    if (html.includes('__kt__/kt-skin.css')) return html;
    return html.replace(
      '</head>',
      [
        '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
        '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
        '    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />',
        '    <link rel="stylesheet" href="/__kt__/kt-skin.css" />',
        '    <script src="/__kt__/kt-skin.js" defer></script>',
        '  </head>',
      ].join('\n'),
    );
  }

  serveLocalAsset(rel) {
    const clean = String(rel || '').replace(/^\/+/, '').replace(/\\/g, '/');
    if (clean.startsWith('__kt__/')) {
      const name = path.basename(clean);
      if (!['kt-skin.css', 'kt-skin.js', 'chrome-shim.js'].includes(name)) {
        return { ok: false, status: 404 };
      }
      const filePath = path.join(__dirname, 'blohunter', name);
      if (!fs.existsSync(filePath)) return { ok: false, status: 404 };
      return {
        ok: true,
        filePath,
        contentType: MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      };
    }
    if (!this.connectRoot) return { ok: false, status: 404 };
    const abs = path.normalize(path.join(this.connectRoot, clean));
    if (!isPathInside(this.connectRoot, abs)) return { ok: false, status: 404 };
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, status: 404 };
    return {
      ok: true,
      filePath: abs,
      contentType: MIME_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      injectSkin: path.basename(abs) === 'dashboard.html',
    };
  }

  ensureHttpServer() {
    if (this.httpServer && this.httpPort) return Promise.resolve(this.httpPort);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const parsed = new URL(req.url, 'http://127.0.0.1');
          const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
          const served = this.serveLocalAsset(rel);
          if (!served.ok) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }
          let body = fs.readFileSync(served.filePath);
          if (served.injectSkin) {
            body = Buffer.from(this.injectDashboardHtml(body.toString('utf8')), 'utf8');
          }
          res.writeHead(200, {
            'Content-Type': served.contentType,
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(err.message || 'Server error');
        }
      });

      const preferredPort = this.deskHttpPort || 9140;
      const listen = (port) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && port === preferredPort) {
            listen(0);
            return;
          }
          reject(err);
        });
        server.listen(port, '127.0.0.1', () => {
          this.httpServer = server;
          this.httpPort = server.address().port;
          this.log(`[BloHunter] Desk server http://127.0.0.1:${this.httpPort}`);
          resolve(this.httpPort);
        });
      };
      listen(preferredPort);
    });
  }

  resolveProtocolPath(urlString) {
    if (!this.connectRoot) return null;
    const url = new URL(urlString);
    if (url.hostname !== 'local') return null;
    let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const abs = path.normalize(path.join(this.connectRoot, rel));
    if (!isPathInside(this.connectRoot, abs)) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  }

  serveProtocolRequest(urlString) {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return { ok: false, status: 404, body: 'Not found' };
    }
    if (url.hostname !== 'local') return { ok: false, status: 404, body: 'Not found' };

    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (rel.startsWith('__kt__/')) {
      const name = path.basename(rel);
      if (!['kt-skin.css', 'kt-skin.js', 'chrome-shim.js'].includes(name)) {
        return { ok: false, status: 404, body: 'Not found' };
      }
      const filePath = path.join(__dirname, 'blohunter', name);
      if (!fs.existsSync(filePath)) return { ok: false, status: 404, body: 'Not found' };
      const ext = path.extname(filePath).toLowerCase();
      return {
        ok: true,
        status: 200,
        filePath,
        contentType: MIME_TYPES[ext] || 'application/octet-stream',
      };
    }

    const filePath = this.resolveProtocolPath(urlString);
    if (!filePath) return { ok: false, status: 404, body: 'Not found' };
    const ext = path.extname(filePath).toLowerCase();
    return {
      ok: true,
      status: 200,
      filePath,
      contentType: MIME_TYPES[ext] || 'application/octet-stream',
      injectSkin: path.basename(filePath) === 'dashboard.html',
    };
  }
}

module.exports = { BlohunterBridge, resolveBlohunterConnectRoot };
