/* ── KnightTrader App Logic v2 ─────────────────────────────── */

let currentTab = 'setup';
let autoScroll = true;
let newLogs = 0;
let hermesInstalled = false;
let dashboardRunning = false;
let dashboardStartInFlight = false;
let tradingVoiceEnabled = false;
let previousOpenPositionKeys = new Set();
let tradingPositionPollTimer = null;

function speakTradingVoice(message) {
  if (!message || !tradingVoiceEnabled) return;
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  } catch (_) {
    // Voice is optional; keep Trading silent if unavailable.
  }
}

function announceTradingPositionChanges(openPositions = []) {
  const nextKeys = new Set();
  const seen = new Set();
  for (const position of openPositions) {
    const symbol = String(position?.contract || position?.symbol || position?.pair || '').trim().toUpperCase();
    const side = String(position?.side || '').trim().toLowerCase();
    const key = `${symbol}:${side}`;
    if (!key || key === ':') continue;
    nextKeys.add(key);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!previousOpenPositionKeys.has(key)) {
      const label = symbol && side ? `${side} ${symbol}` : symbol || 'position';
      speakTradingVoice(`Opened ${label}`);
    }
  }
  for (const key of previousOpenPositionKeys) {
    if (!nextKeys.has(key)) {
      const label = key.includes(':') ? key.replace(':', ' ') : key;
      speakTradingVoice(`Closed ${label}`);
    }
  }
  previousOpenPositionKeys = nextKeys;
}

function updateTradingVoiceToggle() {
  if (el.tradingVoiceLabel) el.tradingVoiceLabel.textContent = tradingVoiceEnabled ? 'Voice On' : 'Voice Off';
}

function startTradingPositionAnnouncements() {
  stopTradingPositionAnnouncements();
  if (tradingPositionPollTimer) return;
  if (!window.kt?.getTradingStatus) return;
  updateTradingPositionAnnouncements();
  tradingPositionPollTimer = setInterval(updateTradingPositionAnnouncements, 1500);
}

function stopTradingPositionAnnouncements() {
  if (tradingPositionPollTimer) {
    clearInterval(tradingPositionPollTimer);
    tradingPositionPollTimer = null;
  }
}

async function updateTradingPositionAnnouncements() {
  try {
    const data = await window.kt.getTradingStatus();
    const positions = Array.isArray(data?.openPositions) ? data.openPositions : [];
    announceTradingPositionChanges(positions);
  } catch (_) {
    // Voice updates are non-blocking.
  }
}

// ── DOM shortcuts ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  minimize: $('btn-minimize'), maximize: $('btn-maximize'), close: $('btn-close'),
  navItems: document.querySelectorAll('.nav-item'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  statusPill: $('status-pill'), statusOrb: $('status-orb'), statusLabel: $('status-label'),
  logBadge: $('log-badge'), hermesNavBadge: $('hermes-nav-badge'),

  // Setup
  formSetup: $('form-setup'),
  nousApiKey: $('nous-api-key'), nousModel: $('nous-model'),
  btnLoadNousFile: $('btn-load-nous-file'), nousFilePath: $('nous-file-path'),
  btnTestNous: $('btn-test-nous'), nousTestStatus: $('nous-test-status'),
  coinbaseApiKey: $('coinbase-api-key'), coinbaseSecretKey: $('coinbase-secret-key'),
  coinbasePaperStartingValue: $('coinbase-paper-starting-value'),
  btnLoadCoinbaseFile: $('btn-load-coinbase-file'), coinbaseFilePath: $('coinbase-file-path'),
  btnTestCoinbase: $('btn-test-coinbase'), coinbaseTestStatus: $('coinbase-test-status'),
  saveStatus: $('save-status'), btnSave: $('btn-save'),

  // Hermes tab
  hermesInstallStatus: $('hermes-install-status'), btnInstallHermes: $('btn-install-hermes'), btnWipeHermes: $('btn-wipe-hermes'),
  hermesVersionTag: $('hermes-version-tag'), hermesHomeDisplay: $('hermes-home-display'),
  btnWriteCompendium: $('btn-write-compendium'), compendiumStatus: $('compendium-status'),
  compendiumPathDisplay: $('compendium-path-display'),
  btnStartDashboard: $('btn-start-dashboard'), btnStopDashboard: $('btn-stop-dashboard'),
  dashboardStatus: $('dashboard-status'),
  btnConfigureCron: $('btn-configure-cron'), cronStatus: $('cron-status'),
  manualPromptWrap: $('manual-prompt-wrap'), cronPromptText: $('cron-prompt-text'), btnCopyPrompt: $('btn-copy-prompt'),
  dashboardEmbedWrap: $('dashboard-embed-wrap'), dashUrl: $('dash-url'),
  hermesWebview: $('hermes-webview'),
  btnReloadDash: $('btn-reload-dash'), btnOpenDashExternal: $('btn-open-dash-external'),

  // Logs
  logContainer: $('log-container'), logList: $('log-list'), logEmpty: $('log-empty'),
  btnAutoscroll: $('btn-autoscroll'), btnClearLogs: $('btn-clear-logs'),

  // Settings
  aboutHermesVer: $('about-hermes-ver'),

  // Trading
  tradingWebview: $('trading-webview'),
  tradingWebviewWrap: $('trading-webview-wrap'),
  tradingStatusPill: $('trading-status-pill'),
  tradingError: $('trading-error'),
  btnReloadTrading: $('btn-reload-trading'),
  btnTradingVoice: $('btn-trading-voice'),
  tradingVoiceLabel: $('trading-voice-label'),
};

// ── Init ──────────────────────────────────────────────────────
async function populateNousModels() {
  if (!el.nousModel) return;
  const previous = el.nousModel.value;
  try {
    const catalog = await window.kt.getNousModels();
    if (!catalog?.free?.length) return;
    el.nousModel.innerHTML = '';
    const freeGroup = document.createElement('optgroup');
    freeGroup.label = 'Free tier';
    for (const model of catalog.free) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      freeGroup.appendChild(opt);
    }
    el.nousModel.appendChild(freeGroup);
    if (catalog.paid?.length) {
      const paidGroup = document.createElement('optgroup');
      paidGroup.label = 'Paid / subscription';
      for (const model of catalog.paid) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.label || model.id;
        paidGroup.appendChild(opt);
      }
      el.nousModel.appendChild(paidGroup);
    }
    setNousModelValue(previous || catalog.defaultModel || 'tencent/hy3:free');
  } catch (_) {}
}

async function init() {
  await populateNousModels();
  // Load creds
  try {
    const creds = await window.kt.getCredentials();
    if (creds.nous) {
      el.nousApiKey.value = creds.nous.apiKey || '';
      setNousModelValue(creds.nous.model || 'tencent/hy3:free');
    } else if (creds.nouse) {
      el.nousApiKey.value = creds.nouse.apiKey || '';
      setNousModelValue(creds.nouse.model || 'tencent/hy3:free');
    }
    if (creds.coinbase) {
      el.coinbaseApiKey.value = creds.coinbase.apiKey || '';
      el.coinbaseSecretKey.value = creds.coinbase.secretKey || '';
      if (el.coinbasePaperStartingValue && creds.coinbase.paperStartingValue != null) {
        el.coinbasePaperStartingValue.value = String(creds.coinbase.paperStartingValue);
      }
    }
  } catch (e) {}

  // Compendium path
  try {
    const p = await window.kt.getCompendiumPath();
    el.compendiumPathDisplay.textContent = p;
  } catch (e) {}

  // Hermes sandboxed home path
  try {
    const h = await window.kt.getHermesHome();
    if (el.hermesHomeDisplay) el.hermesHomeDisplay.textContent = h;
  } catch (e) {}

  try { syncWebviewParking('setup'); } catch (_) {}

  // Load existing logs
  try {
    const logs = await window.kt.getLogs();
    logs.forEach(appendLogLine);
  } catch (e) {}

  // Check hermes install
  checkHermesStatus();

  // Check dashboard status — only restore UI if gateway is actually ready.
  // A leftover listener on old ports used to hide the start button forever.
  try {
    const ds = await window.kt.getDashboardStatus();
    if (ds.ready) {
      setDashboardState(true, true, !!ds.gatewayRunning);
      loadDashboard(ds.url || 'http://127.0.0.1:9130');
    } else {
      setDashboardState(false, false);
    }
  } catch (e) {}

  // Live events
  window.kt.onLogLine((entry) => {
    appendLogLine(entry);
    if (currentTab !== 'logs') { newLogs++; updateLogBadge(); }
  });

  window.kt.onDashboardReady((d) => {
    setDashboardState(true, true, d.gatewayRunning);
    loadDashboard(d.url);
  });

  window.kt.onDashboardStopped(() => {
    setDashboardState(false, false);
  });

  updateNousTestButton();
  updateCoinbaseTestButton();
}

// ── Hermes install check ──────────────────────────────────────
async function checkHermesStatus() {
  el.hermesInstallStatus.textContent = 'Checking...';
  try {
    const result = await window.kt.checkHermes();
    hermesInstalled = result.installed;
    if (result.installed) {
      el.hermesInstallStatus.textContent = '✓ Installed';
      el.hermesInstallStatus.style.color = 'var(--good)';
      el.hermesVersionTag.textContent = result.version;
      el.hermesVersionTag.classList.remove('hidden');
      el.btnInstallHermes.textContent = '✓ Already Installed';
      el.btnInstallHermes.disabled = true;
      el.btnWipeHermes.style.display = 'inline-flex';
      el.aboutHermesVer.textContent = result.version;
    } else if (result.partial) {
      el.hermesInstallStatus.textContent = '⚠ Broken/partial install — use Wipe & Reinstall';
      el.hermesInstallStatus.style.color = 'var(--warn)';
      el.btnInstallHermes.textContent = 'Install Hermes';
      el.btnInstallHermes.disabled = false;
      el.btnWipeHermes.style.display = 'inline-flex';
      el.btnStartDashboard.disabled = true;
      el.dashboardStatus.textContent = 'Wipe & Reinstall Hermes first (Step 1 above)';
      el.dashboardStatus.style.color = 'var(--warn)';
      el.aboutHermesVer.textContent = 'Partial install';
    } else {
      el.hermesInstallStatus.textContent = '✗ Not installed — click Install Hermes first';
      el.hermesInstallStatus.style.color = 'var(--error)';
      el.btnInstallHermes.disabled = false;
      el.btnWipeHermes.style.display = 'none';
      el.hermesNavBadge.classList.remove('hidden');
      el.aboutHermesVer.textContent = 'Not installed';
      el.btnStartDashboard.disabled = true;
      el.dashboardStatus.textContent = 'Install Hermes first (Step 1 above)';
      el.dashboardStatus.style.color = 'var(--warn)';
    }
  } catch (e) {
    el.hermesInstallStatus.textContent = 'Check failed';
  }
}

// ── Dashboard state ───────────────────────────────────────────
function setDashboardState(running, ready, gatewayRunning) {
  dashboardRunning = !!(running && ready);
  el.btnStartDashboard.classList.toggle('hidden', running && ready);
  el.btnStartDashboard.disabled = dashboardStartInFlight;
  el.btnStopDashboard.classList.toggle('hidden', !running);
  el.statusPill.classList.toggle('running', running && ready);
  el.statusLabel.textContent = running ? (ready ? 'Running' : 'Starting…') : 'Stopped';

  if (ready) {
    el.dashboardStatus.textContent = gatewayRunning === false
      ? '✓ Dashboard ready — starting gateway…'
      : '✓ Dashboard + gateway ready — cron can fire';
    el.dashboardStatus.style.color = 'var(--good)';
    el.btnConfigureCron.disabled = false;
    el.dashboardEmbedWrap.classList.remove('hidden');
  } else if (running) {
    el.dashboardStatus.textContent = '⏳ Starting dashboard + gateway…';
    el.dashboardStatus.style.color = 'var(--accent)';
    el.btnConfigureCron.disabled = true;
  } else {
    el.dashboardStatus.textContent = 'Not running';
    el.dashboardStatus.style.color = 'var(--text3)';
    el.btnConfigureCron.disabled = true;
    el.dashboardEmbedWrap.classList.add('hidden');
  }
}

async function startHermesDashboardUi() {
  if (dashboardStartInFlight) return;
  if (!hermesInstalled) {
    el.dashboardStatus.textContent = '✗ Install Hermes first (Step 1 above)';
    el.dashboardStatus.style.color = 'var(--error)';
    switchTab('hermes');
    return;
  }
  dashboardStartInFlight = true;
  setDashboardState(true, false);
  el.dashboardStatus.textContent = '⏳ Starting dashboard + gateway…';
  el.dashboardStatus.style.color = 'var(--accent)';
  try {
    const result = await window.kt.startDashboard();
    if (!result.ok) {
      setDashboardState(false, false);
      el.dashboardStatus.textContent = '✗ ' + (result.msg || result.error || 'Failed to start');
      el.dashboardStatus.style.color = 'var(--error)';
      return;
    }
    setDashboardState(true, true, !!result.gatewayRunning);
    loadDashboard(result.url || 'http://127.0.0.1:9130');
  } catch (e) {
    setDashboardState(false, false);
    el.dashboardStatus.textContent = '✗ ' + (e.message || 'Failed to start');
    el.dashboardStatus.style.color = 'var(--error)';
  } finally {
    dashboardStartInFlight = false;
    el.btnStartDashboard.disabled = false;
  }
}

function loadDashboard(url) {
  el.dashUrl.textContent = url;
  el.hermesWebview.src = url;
}

// ── Credentials save ──────────────────────────────────────────
async function saveAndWriteCompendium() {
  const data = {
    nous: {
      apiKey: el.nousApiKey.value.trim(),
      model: el.nousModel.value
    },
    coinbase: {
      apiKey: el.coinbaseApiKey.value.trim(),
      secretKey: el.coinbaseSecretKey.value.trim(),
    }
  };
  try {
    await window.kt.saveCredentials(data);
    const comp = await window.kt.writeCompendium();
    if (comp.ok) {
      showSaveStatus('✓ Saved & compendium written', false);
      el.compendiumStatus.classList.remove('hidden');
    } else {
      showSaveStatus('Saved (compendium failed: ' + comp.error + ')', true);
    }
    if (tradingLoaded) {
      window.kt.startTradingDashboard().catch(() => {});
    }
  } catch (e) {
    showSaveStatus('✗ Error: ' + e.message, true);
  }
}

function showSaveStatus(msg, err) {
  el.saveStatus.textContent = msg;
  el.saveStatus.classList.toggle('error', err);
  el.saveStatus.classList.add('show');
  setTimeout(() => el.saveStatus.classList.remove('show'), 3000);
}

function updateNousTestButton() {
  const ready = el.nousApiKey.value.trim().length > 0 && el.nousModel.value.trim().length > 0;
  el.btnTestNous.disabled = !ready;
}

function setNousTestStatus(msg, state) {
  el.nousTestStatus.textContent = msg;
  el.nousTestStatus.className = 'nous-test-status' + (state ? ` ${state}` : '');
}

function setCredFilePath(span, filePath) {
  if (!span) return;
  if (!filePath) {
    span.textContent = '';
    span.classList.remove('loaded');
    return;
  }
  span.textContent = filePath;
  span.classList.add('loaded');
}

function setNousModelValue(model) {
  if (!model || !el.nousModel) return;
  const exists = [...el.nousModel.options].some((opt) => opt.value === model);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = `${model} (from file)`;
    el.nousModel.insertBefore(opt, el.nousModel.firstChild);
  }
  el.nousModel.value = model;
}

function applyNousFromFile(data) {
  if (data.apiKey) el.nousApiKey.value = data.apiKey;
  if (data.model) setNousModelValue(data.model);
  updateNousTestButton();
  setNousTestStatus('', '');
}

function applyCoinbaseFromFile(data) {
  if (data.apiKey) el.coinbaseApiKey.value = data.apiKey;
  if (data.secretKey) el.coinbaseSecretKey.value = data.secretKey;
  if (el.coinbaseDemoMode && data.demoMode != null) el.coinbaseDemoMode.checked = !!data.demoMode;
  updateCoinbaseTestButton();
  setCoinbaseTestStatus('', '');
}

function updateCoinbaseTestButton() {
  const ready = el.coinbaseApiKey.value.trim().length > 0
    && el.coinbaseSecretKey.value.trim().length > 0;
  el.btnTestCoinbase.disabled = !ready;
}

function setCoinbaseTestStatus(msg, state) {
  el.coinbaseTestStatus.textContent = msg;
  el.coinbaseTestStatus.className = 'nous-test-status' + (state ? ` ${state}` : '');
}

// ── Logs ─────────────────────────────────────────────────────
function appendLogLine(entry) {
  el.logEmpty.style.display = 'none';
  const d = document.createElement('div');
  d.className = `log-line ${entry.type || 'info'}`;
  const ts = new Date(entry.ts).toTimeString().slice(0, 8);
  d.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg">${esc(entry.msg)}</span>`;
  el.logList.appendChild(d);
  if (autoScroll) el.logContainer.scrollTop = el.logContainer.scrollHeight;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateLogBadge() {
  if (newLogs > 0) {
    el.logBadge.textContent = newLogs > 99 ? '99+' : newLogs;
    el.logBadge.classList.remove('hidden');
  } else {
    el.logBadge.classList.add('hidden');
  }
}

let tradingLoaded = false;
let tradingPreloadPath = '';
let tradingInitPromise = null;

function guestHasPage(webview) {
  if (!webview) return false;
  const src = String(webview.getAttribute('src') || webview.src || '');
  return !!src && src !== 'about:blank';
}

function parkWebview(webview, parked) {
  if (!webview) return;
  try {
    webview.classList.toggle('webview-parked', !!parked);
  } catch (_) {}
  if (parked || !guestHasPage(webview)) return;
  try {
    webview.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  } catch (_) {}
}

function syncWebviewParking(activeTab) {
  parkWebview(el.tradingWebview, activeTab !== 'trading');
  parkWebview(el.hermesWebview, activeTab !== 'hermes');
}

function attachTradingGuest(webview) {
  if (!webview) return;
  try {
    const wcId = webview.getWebContentsId();
    window.kt.attachTradingWebview(wcId).catch((e) => console.warn('attachTradingWebview:', e));
  } catch (e) {
    console.warn('attachTradingWebview:', e);
  }
}

function bindTradingWebview(webview) {
  if (!webview || webview.dataset.bound === '1') return webview;
  webview.dataset.bound = '1';
  webview.addEventListener('did-attach', () => attachTradingGuest(webview));
  webview.addEventListener('dom-ready', () => {
    attachTradingGuest(webview);
    parkWebview(webview, currentTab !== 'trading');
  });
  webview.addEventListener('did-finish-load', async () => {
    try {
      await window.kt.getTradingStatus();
    } catch (_) {}
  });
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return;
  });
  return webview;
}

function ensureTradingWebview(preloadPath) {
  const wrap = el.tradingWebviewWrap;
  if (!wrap) return null;
  const preload = String(preloadPath || '').trim();
  let webview = el.tradingWebview;
  if (webview && (!preload || webview.getAttribute('preload') === preload)) {
    return bindTradingWebview(webview);
  }

  const next = document.createElement('webview');
  next.id = 'trading-webview';
  if (preload) next.setAttribute('preload', preload);
  next.setAttribute('partition', 'persist:blohunter-trading');
  next.setAttribute('allowpopups', '');
  next.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no');
  if (webview) webview.replaceWith(next);
  else wrap.appendChild(next);
  el.tradingWebview = next;
  return bindTradingWebview(next);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name) {
  currentTab = name;
  el.navItems.forEach(i => i.classList.toggle('active', i.dataset.tab === name));
  el.tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  try { syncWebviewParking(name); } catch (_) {}
  if (name === 'logs') { newLogs = 0; updateLogBadge(); }
  if (name === 'trading') {
    initTradingTab();
    if (tradingVoiceEnabled) startTradingPositionAnnouncements();
  }
  if (name !== 'trading') {
    stopTradingPositionAnnouncements();
  }
  if (name === 'hermes' && hermesInstalled && !dashboardRunning && !dashboardStartInFlight) {
    startHermesDashboardUi();
  }
}

async function loadTradingDesk(forceReload = false) {
  if (!tradingPreloadPath) {
    tradingPreloadPath = await window.kt.getBlohunterPreloadPath();
  }
  const webview = ensureTradingWebview(tradingPreloadPath);
  if (!webview) return;

  parkWebview(webview, false);

  const result = await withTimeout(
    window.kt.startTradingDashboard(),
    90000,
    'Trading desk startup timed out. Check Logs, then click Reload.'
  );
  if (!result?.ok || !result.url) return;

  const nextUrl = forceReload ? `${result.url}${result.url.includes('?') ? '&' : '?'}t=${Date.now()}` : result.url;
  if (webview.src !== nextUrl) webview.src = nextUrl;
  tradingLoaded = true;
}

async function initTradingTab() {
  if (tradingInitPromise) return tradingInitPromise;
  if (tradingLoaded && guestHasPage(el.tradingWebview)) {
    parkWebview(el.tradingWebview, false);
    tradingInitPromise = (async () => {
      try {
        await window.kt.startTradingDashboard();
      } catch (_) {
      } finally {
        tradingInitPromise = null;
      }
    })();
    return tradingInitPromise;
  }

  tradingInitPromise = (async () => {
    try {
      await loadTradingDesk(false);
    } catch (_) {
    } finally {
      tradingInitPromise = null;
    }
  })();

  return tradingInitPromise;
}

if (el.btnReloadTrading) {
  el.btnReloadTrading.addEventListener('click', async () => {
    await loadTradingDesk(true);
  });
}

if (el.btnTradingVoice) {
  el.btnTradingVoice.addEventListener('click', () => {
    tradingVoiceEnabled = !tradingVoiceEnabled;
    updateTradingVoiceToggle();
    if (tradingVoiceEnabled) {
      startTradingPositionAnnouncements();
    } else {
      stopTradingPositionAnnouncements();
    }
  });
}

// ── Event listeners ───────────────────────────────────────────
if (el.minimize) el.minimize.addEventListener('click', () => window.kt.minimize());
if (el.maximize) el.maximize.addEventListener('click', () => window.kt.maximize());
if (el.close) el.close.addEventListener('click', () => window.kt.close());

el.navItems.forEach(item => item.addEventListener('click', () => switchTab(item.dataset.tab)));

// Setup form
el.formSetup.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.btnSave.disabled = true;
  await saveAndWriteCompendium();
  el.btnSave.disabled = false;
});

// Password toggles
document.querySelectorAll('.toggle-vis').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = document.getElementById(btn.dataset.target);
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });
});

el.nousApiKey.addEventListener('input', () => {
  updateNousTestButton();
  setNousTestStatus('', '');
});
el.nousModel.addEventListener('change', () => {
  updateNousTestButton();
  setNousTestStatus('', '');
});

el.btnLoadNousFile.addEventListener('click', async () => {
  el.btnLoadNousFile.disabled = true;
  try {
    const result = await window.kt.pickNousCredentialFile();
    if (result.cancelled) return;
    if (!result.ok) {
      setNousTestStatus(`✗ ${result.error || 'Could not load file'}`, 'error');
      return;
    }
    applyNousFromFile(result.nous);
    setCredFilePath(el.nousFilePath, result.path);
    try {
      await window.kt.saveCredentials({ nous: result.nous || {} });
    } catch {}
  } catch (e) {
    setNousTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    el.btnLoadNousFile.disabled = false;
  }
});

el.btnLoadCoinbaseFile.addEventListener('click', async () => {
  el.btnLoadCoinbaseFile.disabled = true;
  try {
    const result = await window.kt.pickCoinbaseCredentialFile();
    if (result.cancelled) return;
    if (!result.ok) {
      setCoinbaseTestStatus(`✗ ${result.error || 'Could not load file'}`, 'error');
      return;
    }
    applyCoinbaseFromFile(result.coinbase);
    setCredFilePath(el.coinbaseFilePath, result.path);
    try {
      await window.kt.saveCredentials({ coinbase: result.coinbase || {} });
    } catch {}
  } catch (e) {
    setCoinbaseTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    el.btnLoadCoinbaseFile.disabled = false;
  }
});

el.btnTestNous.addEventListener('click', async () => {
  const apiKey = el.nousApiKey.value.trim();
  const model = el.nousModel.value;
  if (!apiKey || !model) return;

  el.btnTestNous.disabled = true;
  setNousTestStatus('Testing…', 'pending');
  try {
    const result = await window.kt.testNousCredentials({ apiKey, model });
    if (result.ok) {
      const preview = result.reply ? ` — "${result.reply.slice(0, 60)}"` : '';
      setNousTestStatus(`✓ Connected to ${result.model}${preview}`, 'ok');
    } else {
      setNousTestStatus(`✗ ${result.error || 'Test failed'}`, 'error');
    }
  } catch (e) {
    setNousTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    updateNousTestButton();
  }
});

function bindCoinbaseTestInputs() {
  const reset = () => {
    updateCoinbaseTestButton();
    setCoinbaseTestStatus('', '');
  };
  el.coinbaseApiKey.addEventListener('input', reset);
  el.coinbaseSecretKey.addEventListener('input', reset);
  if (el.coinbaseDemoMode) el.coinbaseDemoMode.addEventListener('change', reset);
}
bindCoinbaseTestInputs();

el.btnTestCoinbase.addEventListener('click', async () => {
  const creds = {
    apiKey: el.coinbaseApiKey.value.trim(),
    secretKey: el.coinbaseSecretKey.value.trim(),
    demoMode: !!(el.coinbaseDemoMode && el.coinbaseDemoMode.checked),
  };
  if (!creds.apiKey || !creds.secretKey) return;

  el.btnTestCoinbase.disabled = true;
  setCoinbaseTestStatus('Testing…', 'pending');
  try {
    const result = await window.kt.testCoinbaseCredentials(creds);
    if (result.ok) {
      setCoinbaseTestStatus(`✓ ${result.mode} connected — ${result.summary}`, 'ok');
    } else {
      setCoinbaseTestStatus(`✗ ${result.error || 'Test failed'}`, 'error');
    }
  } catch (e) {
    setCoinbaseTestStatus(`✗ ${e.message}`, 'error');
  } finally {
    updateCoinbaseTestButton();
  }
});

// Defender exclusion (Step 0)
const btnAddExclusion    = $('btn-add-exclusion');
const exclusionStatus    = $('exclusion-status');
const exclusionManual    = $('exclusion-manual');
const exclusionPathDisp  = $('exclusion-path-display');

btnAddExclusion.addEventListener('click', async () => {
  btnAddExclusion.disabled = true;
  exclusionStatus.textContent = '⏳ Adding exclusion… (approve the UAC prompt)';
  exclusionStatus.style.color = 'var(--accent)';
  const res = await window.kt.addDefenderExclusion();
  if (res.ok) {
    exclusionStatus.textContent = '✅ Exclusion added — now safe to install';
    exclusionStatus.style.color = 'var(--good)';
  } else {
    exclusionStatus.textContent = '⚠ Failed — add manually (see below)';
    exclusionStatus.style.color = 'var(--warn)';
    exclusionManual.classList.remove('hidden');
    if (res.manual && exclusionPathDisp) exclusionPathDisp.textContent = res.manual;
    btnAddExclusion.disabled = false;
  }
});

// Hermes install
el.btnInstallHermes.addEventListener('click', async () => {
  el.btnInstallHermes.disabled = true;
  el.hermesInstallStatus.textContent = '⏳ Installing Hermes, then starting dashboard…';
  el.hermesInstallStatus.style.color = 'var(--accent)';
  switchTab('logs');
  const result = await window.kt.installHermes();
  if (result.ok) {
    hermesInstalled = true;
    el.hermesInstallStatus.textContent = '✓ Installed: ' + result.version;
    el.hermesInstallStatus.style.color = 'var(--good)';
    el.hermesNavBadge.classList.add('hidden');
    el.btnInstallHermes.textContent = '✓ Already Installed';
    el.btnStartDashboard.disabled = false;
    el.dashboardStatus.textContent = 'Ready — click Start Dashboard + Gateway';
    el.dashboardStatus.style.color = 'var(--text3)';
    try {
      const ds = await window.kt.getDashboardStatus();
      if (ds.running || ds.ready) {
        setDashboardState(!!ds.running, !!ds.ready, !!ds.gatewayRunning);
        if (ds.ready) loadDashboard(ds.url || 'http://127.0.0.1:9130');
      }
    } catch (e) {}
  } else if (result.partial) {
    el.hermesInstallStatus.textContent = '⚠ Partial install — click Install to resume (see Logs)';
    el.hermesInstallStatus.style.color = 'var(--warn)';
    el.btnInstallHermes.textContent = 'Resume Hermes Install';
    el.btnInstallHermes.disabled = false;
  } else {
    el.hermesInstallStatus.textContent = '✗ Install failed — check Logs tab';
    el.hermesInstallStatus.style.color = 'var(--error)';
    el.btnInstallHermes.disabled = false;
  }
});

// Wipe & Reinstall
el.btnWipeHermes.addEventListener('click', async () => {
  if (!confirm('This will delete the Hermes install and let you reinstall fresh. Continue?')) return;
  el.btnWipeHermes.disabled = true;
  el.hermesInstallStatus.textContent = '🗑 Wiping...';
  el.hermesInstallStatus.style.color = 'var(--warn)';
  await window.kt.wipeHermes();
  hermesInstalled = false;
  el.btnInstallHermes.textContent = 'Install Hermes';
  el.btnInstallHermes.disabled = false;
  el.btnWipeHermes.style.display = 'none';
  el.btnWipeHermes.disabled = false;
  el.btnStartDashboard.disabled = true;
  el.hermesInstallStatus.textContent = '✗ Wiped — click Install Hermes';
  el.hermesInstallStatus.style.color = 'var(--error)';
  el.dashboardStatus.textContent = 'Install Hermes first (Step 1 above)';
  el.dashboardStatus.style.color = 'var(--warn)';
  el.hermesNavBadge.classList.remove('hidden');
});

// Write compendium
el.btnWriteCompendium.addEventListener('click', async () => {
  const res = await window.kt.writeCompendium();
  if (res.ok) {
    el.compendiumStatus.textContent = '✓ Written to: ' + res.path;
    el.compendiumStatus.classList.remove('hidden');
    el.compendiumStatus.style.color = 'var(--good)';
  } else {
    el.compendiumStatus.textContent = '✗ ' + res.error;
    el.compendiumStatus.classList.remove('hidden');
    el.compendiumStatus.style.color = 'var(--error)';
  }
});

// Start / stop dashboard
el.btnStartDashboard.addEventListener('click', () => startHermesDashboardUi());

el.btnStopDashboard.addEventListener('click', async () => {
  await window.kt.stopDashboard();
  setDashboardState(false, false);
});

// Configure cron
el.btnConfigureCron.addEventListener('click', async () => {
  el.btnConfigureCron.disabled = true;
  el.cronStatus.textContent = '⏳ Configuring…';
  el.cronStatus.style.color = 'var(--accent)';
  const result = await window.kt.configureCron();
  if (result.ok) {
    el.cronStatus.textContent = result.updated
      ? '✅ Cron updated — every 5 minutes!'
      : '✅ Cron active — every 5 minutes!';
    el.cronStatus.style.color = 'var(--good)';
    el.manualPromptWrap.classList.add('hidden');
  } else {
    el.cronStatus.textContent = result.msg ? `⚠ ${result.msg}` : '⚠ Manual setup needed';
    el.cronStatus.style.color = 'var(--warn)';
    const prompt = result.prompt || await window.kt.getCronPrompt();
    el.cronPromptText.textContent = prompt;
    el.manualPromptWrap.classList.remove('hidden');
    el.btnConfigureCron.disabled = false;
  }
});

// Copy prompt
el.btnCopyPrompt.addEventListener('click', () => {
  navigator.clipboard.writeText(el.cronPromptText.textContent).then(() => {
    el.btnCopyPrompt.textContent = '✓ Copied!';
    setTimeout(() => el.btnCopyPrompt.textContent = 'Copy Prompt', 2000);
  });
});

// Dashboard controls
el.btnReloadDash.addEventListener('click', () => { el.hermesWebview.reload(); });
el.btnOpenDashExternal.addEventListener('click', () => window.kt.openExternal('http://127.0.0.1:9130'));

// Autoscroll toggle
el.btnAutoscroll.addEventListener('click', () => {
  autoScroll = !autoScroll;
  el.btnAutoscroll.classList.toggle('active', autoScroll);
});

// Clear logs
el.btnClearLogs.addEventListener('click', async () => {
  await window.kt.clearLogs();
  el.logList.innerHTML = '';
  el.logEmpty.style.display = '';
});

// Log scroll pause
el.logContainer.addEventListener('scroll', () => {
  const atBottom = el.logContainer.scrollHeight - el.logContainer.scrollTop <= el.logContainer.clientHeight + 40;
  if (!atBottom && autoScroll) { autoScroll = false; el.btnAutoscroll.classList.remove('active'); }
});

// Quick links
const NOUS_PORTAL_URL = 'https://portal.nousresearch.com/manage-subscription';

const LINKS = {
  'link-coinbase-dashboard': 'https://trade.coinbase.com/advanced',
  'link-coinbase-api-page': 'https://www.coinbase.com/orders',
  'link-nous-portal-settings': NOUS_PORTAL_URL,
  'link-hermes-dashboard': 'http://127.0.0.1:9130',
  'link-hermes-docs': 'https://hermes-agent.nousresearch.com/docs/integrations/nous-portal',
  'link-nous-portal': NOUS_PORTAL_URL,
  'link-coinbase-api': 'https://www.coinbase.com/orders',
  'btn-open-coinbase': 'https://trade.coinbase.com/advanced'
};
Object.entries(LINKS).forEach(([id, url]) => {
  const elem = document.getElementById(id);
  if (elem) elem.addEventListener('click', (e) => { e.preventDefault(); window.kt.openExternal(url); });
});

// ── Updates UI ──────────────────────────────────────────────
const updateBanner = $('#update-banner');
const updateBannerTitle = $('#update-banner-title');
const updateBannerDetail = $('#update-banner-detail');
const btnCheckUpdates = $('#btn-check-updates');
const btnInstallUpdate = $('#btn-install-update');
const btnInstallUpdateAction = $('#btn-install-update-action');
const btnHideUpdate = $('#btn-hide-update');

function showUpdateBanner(title, detail, showInstall = false) {
  if (!updateBanner) return;
  if (updateBannerTitle) updateBannerTitle.textContent = title;
  if (updateBannerDetail) updateBannerDetail.textContent = detail;
  if (btnInstallUpdate) btnInstallUpdate.classList.toggle('hidden', !showInstall);
  if (btnInstallUpdateAction) btnInstallUpdateAction.classList.toggle('hidden', !showInstall);
  updateBanner.classList.remove('hidden');
}

function hideUpdateBanner() {
  if (updateBanner) updateBanner.classList.add('hidden');
}

if (btnCheckUpdates) {
  btnCheckUpdates.addEventListener('click', async () => {
    btnCheckUpdates.disabled = true;
    showUpdateBanner('Checking…', 'Looking for updates', false);
    try {
      await window.kt.checkForUpdates();
    } finally {
      btnCheckUpdates.disabled = false;
    }
  });
}

if (btnInstallUpdate) {
  btnInstallUpdate.addEventListener('click', async () => {
    const res = await window.kt.installUpdateNow();
    if (res?.ok) hideUpdateBanner();
  });
}

if (btnInstallUpdateAction) {
  btnInstallUpdateAction.addEventListener('click', async () => {
    const res = await window.kt.installUpdateNow();
    if (res?.ok) hideUpdateBanner();
  });
}

if (btnHideUpdate) {
  btnHideUpdate.addEventListener('click', () => hideUpdateBanner());
}

window.kt.onUpdateStatus((payload) => {
  const type = String(payload?.type || '');
  const detail = payload?.detail || {};
  if (type === 'update-available') {
    const version = String(detail?.version || '');
    showUpdateBanner(`Update available: ${version}`, 'Downloading…', false);
    if (btnCheckUpdates) btnCheckUpdates.disabled = true;
  } else if (type === 'update-not-available') {
    hideUpdateBanner();
    if (btnCheckUpdates) btnCheckUpdates.disabled = false;
  } else if (type === 'download-progress') {
    const percent = Math.floor(detail?.percent || 0);
    const speed = Math.floor(detail?.speed || 0);
    showUpdateBanner('Downloading update…', `${percent}% • ${speed} B/s`, false);
  } else if (type === 'update-downloaded') {
    const version = String(detail?.version || '');
    showUpdateBanner(`Update ready: ${version}`, 'Restart to install', true);
    if (btnCheckUpdates) btnCheckUpdates.disabled = true;
  } else if (type === 'update-error') {
    hideUpdateBanner();
    if (btnCheckUpdates) btnCheckUpdates.disabled = false;
  }
});

// ── Boot ─────────────────────────────────────────────────────
init().catch(console.error);
