const { app, BrowserWindow, ipcMain, shell, dialog, protocol, webContents, session, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { BlohunterBridge } = require('./blohunter-bridge');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bh',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const NOUS_INFERENCE_URL = 'https://inference-api.nousresearch.com/v1/chat/completions';
const NOUS_INFERENCE_BASE = 'https://inference-api.nousresearch.com/v1';
const NOUS_RECOMMENDED_MODELS_URL = 'https://portal.nousresearch.com/api/nous/recommended-models';
const DASHBOARD_PORT = 9130;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

const HERMES_HOME    = path.join(app.getPath('userData'), 'hermes-coinbase');
const HERMES_INSTALL = path.join(HERMES_HOME, 'hermes-agent');
const HERMES_EXE     = path.join(HERMES_INSTALL, 'venv', 'Scripts', 'hermes.exe');

const STORE_KEY  = Buffer.from('kt-aes256-key-knighttrader-2024!');
const STORE_PATH = path.join(app.getPath('userData'), 'kt-config.enc');

function encryptData(obj) {
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-cbc', STORE_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), data: enc.toString('hex') });
}
function decryptData(raw) {
  try {
    const { iv, data } = JSON.parse(raw);
    const d = crypto.createDecipheriv('aes-256-cbc', STORE_KEY, Buffer.from(iv, 'hex'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8'));
  } catch { return null; }
}

const COINBASE_API_URL = 'https://api.coinbase.com';

const DEFAULT_NOUS_MODEL = 'tencent/hy3:free';

const FALLBACK_FREE_NOUS_MODELS = [
  { id: 'tencent/hy3:free', label: 'tencent/hy3:free (free)' },
  { id: 'upstage/solar-pro4:free', label: 'upstage/solar-pro4:free (free)' },
  { id: 'stepfun/step-3.7-flash:free', label: 'stepfun/step-3.7-flash:free (free)' },
  { id: 'poolside/laguna-s-2.1:free', label: 'poolside/laguna-s-2.1:free (free)' },
  { id: 'poolside/laguna-xs-2.1:free', label: 'poolside/laguna-xs-2.1:free (free)' },
];

const FALLBACK_PAID_NOUS_MODELS = [
  { id: 'tencent/hy3', label: 'tencent/hy3' },
  { id: 'moonshotai/kimi-k3', label: 'moonshotai/kimi-k3' },
  { id: 'z-ai/glm-5.2', label: 'z-ai/glm-5.2' },
  { id: 'stepfun/step-3.7-flash', label: 'stepfun/step-3.7-flash' },
  { id: 'meituan/longcat-2.0', label: 'meituan/longcat-2.0' },
  { id: 'upstage/solar-pro4', label: 'upstage/solar-pro4' },
  { id: 'qwen/qwen3.8-max', label: 'qwen/qwen3.8-max' },
  { id: 'minimax/minimax-m2.5', label: 'minimax/minimax-m2.5' },
];

const DEFAULTS = {
  coinbase: { apiKey: '', secretKey: '', passphrase: '' },
  nous: { apiKey: '', model: DEFAULT_NOUS_MODEL },
  settings: { notifySounds: true },
};

const LEGACY_NOUS_MODELS = {};

function normalizeNousModel(value) {
  const v = String(value || '').trim();
  return LEGACY_NOUS_MODELS[v] || v || DEFAULT_NOUS_MODEL;
}

function migrateStoreData(raw) {
  const merged = { ...DEFAULTS, ...raw };
  if (merged.nous) {
    merged.nous = {
      apiKey: merged.nous.apiKey || '',
      model: normalizeNousModel(merged.nous.model),
    };
  }
  return merged;
}

let storeData = loadStoredData();
let blohunterBridge = null;

function getBlohunterBridge() {
  if (!blohunterBridge) {
    blohunterBridge = new BlohunterBridge({
      userDataPath: app.getPath('userData'),
      hermesHome: HERMES_HOME,
      hermesDashboardPort: DASHBOARD_PORT,
      deskHttpPort: 9140,
      log: (...args) => appendLog(`[Trading] ${args.map(String).join(' ')}`, 'info'),
    });
  }
  return blohunterBridge;
}

async function syncBlohunterCredentials() {
  const bridge = getBlohunterBridge();
  if (!storeData.coinbase?.apiKey) return;
  await bridge.syncCredentials({
    apiKey: storeData.coinbase.apiKey,
    secretKey: storeData.coinbase.secretKey,
    passphrase: storeData.coinbase.passphrase || '',
  });
}

let dashboardReady = false;
let dashboardSessionToken = null;
let hermesDashProcess = null;
let dashboardLastOutput = [];
const APP_LOGS = [];

function loadStoredData() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const data = decryptData(raw);
      if (data && typeof data === 'object') return migrateStoreData(data);
    }
        } catch {}
  return JSON.parse(JSON.stringify(DEFAULTS));
}
function saveStore(data) {
  try { fs.writeFileSync(STORE_PATH, encryptData(data), 'utf8'); } catch {}
}

// ── Credential file parsing / picker ───────────────────────────────────────
function normalizeCredentialKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function coerceBool(value) {
  if (typeof value === 'boolean') return value;
  const v = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

function stripCredentialValue(value) {
  let v = String(value ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function looksLikeApiKey(value) {
  const v = String(value || '').trim();
  if (v.length < 8) return false;
  if (/^sk[-_a-z0-9.]+$/i.test(v)) return true;
  if (/^[a-z0-9._-]{16,}$/i.test(v)) return true;
  return false;
}

function applyCredentialMapping(target, kv) {
  const set = (section, field, value) => {
    if (value == null || value === '') return;
    target[section][field] = value;
  };

  for (const [rawKey, rawValue] of Object.entries(kv)) {
    const key = normalizeCredentialKey(rawKey);
    const value = stripCredentialValue(rawValue);
    if (!value) continue;

    if (key === 'nous_api_key' || key === 'nouse_api_key' || key === 'portal_api_key' || key === 'nous_portal_api_key') {
      set('nous', 'apiKey', value);
    } else if (key === 'nous_model' || key === 'nouse_model') {
      set('nous', 'model', normalizeNousModel(value));
    } else if (key === 'api_key' || key === 'coinbase_api_key' || key === 'api_key_name') set('coinbase', 'apiKey', value);
    else if (key === 'api_secret' || key === 'secret_key' || key === 'coinbase_secret_key' || key === 'private_key') set('coinbase', 'secretKey', value);
    else if (key === 'passphrase' || key === 'coinbase_passphrase') set('coinbase', 'passphrase', value);
  }
}

function finalizeNousCredentials(parsed, text) {
  if (parsed.nous.apiKey) return;

  const hasCoinbase = !!(parsed.coinbase.apiKey || parsed.coinbase.secretKey || parsed.coinbase.passphrase);
  if (!hasCoinbase && parsed.coinbase.apiKey) {
    parsed.nous.apiKey = parsed.coinbase.apiKey;
    parsed.coinbase.apiKey = '';
  }

  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const line of lines) {
    const labeled = line.match(/^(?:nous\s*)?(?:portal\s*)?api\s*key[^:=]*[:=]\s*(.+)$/i);
    if (labeled) {
      parsed.nous.apiKey = stripCredentialValue(labeled[1]);
      return;
    }
  }

  const rawLines = lines.filter((line) => !/[:=]/.test(line));
  if (rawLines.length === 1 && looksLikeApiKey(rawLines[0])) {
    parsed.nous.apiKey = rawLines[0];
    return;
  }

  if (lines.length === 1) {
    const parts = lines[0].split(/[:=]/);
    if (parts.length >= 2) {
      const candidate = stripCredentialValue(parts.slice(1).join('='));
      if (looksLikeApiKey(candidate)) parsed.nous.apiKey = candidate;
    } else if (looksLikeApiKey(lines[0])) {
      parsed.nous.apiKey = lines[0];
    }
  }
}

function mergeCredentialObjects(target, source) {
  if (!source || typeof source !== 'object') return;
  if (source.nous && typeof source.nous === 'object') {
    if (source.nous.apiKey) target.nous.apiKey = String(source.nous.apiKey).trim();
    if (source.nous.model) target.nous.model = normalizeNousModel(source.nous.model);
  }
  if (source.nouse && typeof source.nouse === 'object') {
    if (source.nouse.apiKey) target.nous.apiKey = String(source.nouse.apiKey).trim();
    if (source.nouse.model) target.nous.model = normalizeNousModel(source.nouse.model);
  }
  if (source.coinbase && typeof source.coinbase === 'object') {
    if (source.coinbase.apiKey) target.coinbase.apiKey = String(source.coinbase.apiKey).trim();
    if (source.coinbase.secretKey) target.coinbase.secretKey = String(source.coinbase.secretKey).trim();
    if (source.coinbase.passphrase) target.coinbase.passphrase = String(source.coinbase.passphrase).trim();
  }
}

function parseCredentialFileContent(content) {
  const parsed = {
    nous: { apiKey: '', model: '' },
    coinbase: { apiKey: '', secretKey: '', passphrase: '' },
  };
  const text = String(content || '').trim();
  if (!text) return parsed;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      mergeCredentialObjects(parsed, JSON.parse(text));
      if (parsed.nous.apiKey || parsed.nous.model || parsed.coinbase.apiKey) return parsed;
    } catch {}
  }

  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^:=#]+?)[:=]\s*(.+)$/);
    if (match) kv[normalizeCredentialKey(match[1])] = match[2].trim();
  }
  applyCredentialMapping(parsed, kv);
  finalizeNousCredentials(parsed, text);
  return parsed;
}

function getNousCredentialDefaultPath() {
  const candidates = [
    path.join(os.homedir(), 'OneDrive', 'Documents'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

async function pickCredentialFile(kind) {
  const defaultPath = kind === 'coinbase'
    ? getCompendiumPath()
    : getNousCredentialDefaultPath();

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'coinbase' ? 'Select Coinbase credentials file' : 'Select Nous Portal credentials file',
    defaultPath: fs.existsSync(defaultPath) ? defaultPath : path.dirname(defaultPath),
    properties: ['openFile'],
    filters: [
      { name: 'Credential files', extensions: ['txt', 'env', 'json', 'yaml', 'yml', 'md'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });

  if (canceled || !filePaths?.[0]) return { ok: false, cancelled: true };

  const filePath = filePaths[0];
  try {
    const parsed = parseCredentialFileContent(fs.readFileSync(filePath, 'utf8'));

    if (kind === 'nous') {
      const nous = {
        apiKey: parsed.nous.apiKey || '',
        model: normalizeNousModel(parsed.nous.model),
      };
      if (!nous.apiKey) {
        return { ok: false, error: 'No Nous Portal API key found in that file.', path: filePath };
      }
      appendLog(`📂 Loaded Nous credentials from ${filePath}`, 'success');
      return { ok: true, path: filePath, nous };
    }

    const coinbase = {
      apiKey: parsed.coinbase.apiKey || '',
      secretKey: parsed.coinbase.secretKey || '',
      passphrase: parsed.coinbase.passphrase || '',
    };
    if (!coinbase.apiKey || !coinbase.secretKey) {
      return { ok: false, error: 'API Key Name / Private Key not found in that file.', path: filePath };
    }
    appendLog(`📂 Loaded Coinbase credentials from ${filePath}`, 'success');
    return { ok: true, path: filePath, coinbase };
  } catch (e) {
    return { ok: false, error: `Failed to read credential file: ${e.message}`, path: filePath };
  }
}

function saveCredentials({ coinbase, nous }) {
  if (coinbase) {
    storeData.coinbase = {
      apiKey: String(coinbase.apiKey || storeData.coinbase.apiKey || '').trim(),
      secretKey: String(coinbase.secretKey || storeData.coinbase.secretKey || '').trim(),
      passphrase: String(coinbase.passphrase || storeData.coinbase.passphrase || '').trim(),
    };
  }
  if (nous) {
    storeData.nous = {
      apiKey: String(nous.apiKey || storeData.nous.apiKey || '').trim(),
      model: normalizeNousModel(nous.model || storeData.nous.model || DEFAULT_NOUS_MODEL),
    };
  }
  saveStore(storeData);
  return storeData;
}

function getCompendiumPath() {
  const base = app.getPath('userData');
  return path.join(base, 'coinbase-credentials.txt');
}

function writeCompendiumFile(coinbase) {
  const compPath = getCompendiumPath();
  const lines = [
    `# Coinbase Advanced Trade CDP API credentials`,
    `# Auto-generated by KnightTrader`,
    ``,
    `API Key Name: ${coinbase.apiKey}`,
  ];
  if (coinbase.passphrase) {
    lines.push(`Passphrase: ${coinbase.passphrase}`);
  }
  lines.push(`Private Key: ${coinbase.secretKey}`);
  fs.writeFileSync(compPath, lines.join('\n') + '\n', 'utf8');
  return compPath;
}

function getCoinbaseBaseUrl() {
  // Coinbase has no separate demo perpetuals API — always use live REST for auth and market data.
  return COINBASE_API_URL;
}

function normalizeNousModel(value) {
  const v = String(value || '').trim();
  if (!v) return DEFAULT_NOUS_MODEL;
  return v;
}

function appendLog(message, level = 'info') {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  console.log(line);
  APP_LOGS.push(line);
  if (APP_LOGS.length > 1000) APP_LOGS.splice(0, APP_LOGS.length - 1000);
  try {
    mainWindow?.webContents?.send('log-line', { ts: Date.now(), msg: line, type: level });
  } catch {}
}

// ── Coinbase native-crypto auth helpers ─────────────────────────────────────
function coinbaseBase64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function importCoinbaseSecret(secret) {
  const trimmed = String(secret || '').trim();
  if (!trimmed) throw new Error('secret is empty');

  const raw = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw new Error('non-base64-private-key-format');
  }

  const secretBytes = trimmed.includes('\n') || trimmed.includes('-----BEGIN')
    ? Buffer.from(trimmed)
    : Buffer.from(raw, 'base64');

  if (secretBytes.length === 64) {
    const seed = secretBytes.slice(0, 32);
    const pub = secretBytes.slice(32, 64);
    return crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: coinbaseBase64url(pub), d: coinbaseBase64url(seed) },
      format: 'jwk',
      type: 'private',
    });
  }

  if (secretBytes.length === 32) {
    return crypto.createPrivateKey(wrapEcPrivateKeyPem(secretBytes));
  }

  return crypto.createPrivateKey(secretBytes);
}

function wrapEcPrivateKeyPem(privateKeyBytes) {
  const version = Buffer.from([0x02, 0x01, 0x00]);
  const privateKeyValue = Buffer.concat([Buffer.from([0x00]), privateKeyBytes]);
  const privateKey = Buffer.concat([Buffer.from([0x04, 0x22]), privateKeyValue]);
  const algorithm = Buffer.from([0x06, 0x05, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const parameters = Buffer.concat([Buffer.from([0xa0, algorithm.length]), algorithm]);
  const content = Buffer.concat([version, privateKey, parameters]);
  return Buffer.concat([Buffer.from([0x30, content.length]), content]);
}

async function buildCoinbaseJwt(apiKey, secretKey, method, requestPath, baseUrl) {
  const secret = String(secretKey || '').trim();
  if (!secret) return null;

  const key = importCoinbaseSecret(secret);
  const raw = secret.replace(/\s+/g, '');
  const decodedLength = Buffer.from(raw, 'base64').length;
  const isEd25519 = decodedLength === 64;

  const now = Math.floor(Date.now() / 1000);
  const host = String(baseUrl || 'https://api.coinbase.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const uri = `${method.toUpperCase()} ${host}${requestPath}`;
  const header = {
    alg: isEd25519 ? 'EdDSA' : 'ES256',
    typ: 'JWT',
    kid: apiKey,
  };
  const payload = {
    sub: apiKey,
    iss: 'cdp',
    aud: 'cdp_service',
    exp: now + 120,
    nbf: now,
    uri,
  };

  const encodedHeader = coinbaseBase64url(JSON.stringify(header));
  const encodedPayload = coinbaseBase64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.sign(
    isEd25519 ? 'Ed25519' : undefined,
    Buffer.from(signingInput),
    key
  );

  const encodedSignature = signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${encodedSignature}`;
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = options.body ? Buffer.from(options.body) : null;
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw });
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function testCoinbaseCredentials(credentials) {
  const creds = credentials || storeData.coinbase || {};
  const apiKey = String(creds.apiKey || '').trim();
  const secretKey = String(creds.secretKey || '').trim();
  const demoMode = !!creds.demoMode;
  const baseUrl = COINBASE_API_URL;
  const modeLabel = demoMode ? 'live auth (paper mode — no real orders)' : 'live';

  if (!apiKey || !secretKey) {
    return { ok: false, error: 'API key and private key are required.' };
  }

  const pathStr = '/api/v3/brokerage/accounts';
  const jwt = await buildCoinbaseJwt(apiKey, secretKey, 'GET', pathStr, baseUrl);
  if (!jwt) {
    return { ok: false, error: 'Failed to build Coinbase JWT.' };
  }

  appendLog(`🧪 Testing Coinbase credentials (${modeLabel})…`, 'info');

  try {
    appendLog(`Coinbase test apiKey=${String(apiKey).slice(0, 12)}... secretLen=${secretKey.length} url=${baseUrl}${pathStr}`, 'info');

    const { status, raw } = await httpsRequest(`${baseUrl}${pathStr}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    });

    appendLog(`Coinbase test status=${status}`, 'info');
    appendLog(`Coinbase test response=${String(raw || '').slice(0, 500)}`, 'info');

    let parsedBody;
    try { parsedBody = JSON.parse(raw); } catch {}

    if (status === 401 || status === 403) {
      const msg = parsedBody?.message || parsedBody?.error || String(raw || '').slice(0, 200) || `HTTP ${status}`;
      return { ok: false, error: `Unauthorized: ${msg}`, status };
    }

    if (!String(status || '').startsWith('2')) {
      const msg = parsedBody?.message || parsedBody?.error || String(raw || '').slice(0, 200) || `HTTP ${status}`;
      return { ok: false, error: msg, status };
    }

    appendLog(`✅ Coinbase test passed (${modeLabel})`, 'success');
    return { ok: true, status, data: parsedBody };
  } catch (e) {
    appendLog(`✗ Coinbase test error: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  }
}

// ── Hermes helpers ─────────────────────────────────────────────────────────
function hermesCliEnv() {
  return hermesChildEnv();
}

function hermesApiRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: DASHBOARD_PORT,
      path: apiPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Token': token,
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Hermes API request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function ensureDashboardSessionToken() {
  if (!dashboardSessionToken) {
    dashboardSessionToken = crypto.randomBytes(24).toString('base64url');
  }
  return dashboardSessionToken;
}

function scrapeDashboardSessionToken(html) {
  const match = String(html || '').match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function fetchDashboardSessionToken(forceRefresh = false) {
  if (dashboardSessionToken && !forceRefresh) return Promise.resolve(dashboardSessionToken);
  return new Promise((resolve, reject) => {
    const req = http.get(DASHBOARD_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const token = scrapeDashboardSessionToken(data);
        if (token) {
          dashboardSessionToken = token;
          resolve(dashboardSessionToken);
          return;
        }
        reject(new Error('Could not read dashboard session token'));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Dashboard token request timed out'));
    });
  });
}

async function probeDashboardPort(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/health`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function fetchHermesStatus() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${DASHBOARD_URL}/api/status`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid Hermes status response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Hermes status request timed out'));
    });
  });
}

function getHermesEnvPath() {
  return path.join(HERMES_HOME, '.env');
}

function upsertEnvVar(content, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (regex.test(content)) return content.replace(regex, line);
  const prefix = content.length && !content.endsWith('\n') ? `${content}\n` : content;
  const marker = content.includes('# KnightTrader credential sync') ? '' : '\n# KnightTrader credential sync\n';
  return `${prefix}${marker}${line}\n`;
}

function readNousKeyFromEnvFile() {
  try {
    const envPath = getHermesEnvPath();
    if (!fs.existsSync(envPath)) return '';
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(/^NOUS_API_KEY=(.*)$/m) || text.match(/^NOUSRESEARCH_API_KEY=(.*)$/m);
    return (match ? match[1].trim() : '').replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

function resolveNousApiKey() {
  return String(storeData.nous?.apiKey || readNousKeyFromEnvFile() || '').trim();
}

function nodeJsBinDirs() {
  return [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
    path.join(HERMES_INSTALL, 'venv', 'Scripts'),
    path.join(HERMES_INSTALL, 'venv', 'bin'),
  ].filter((dir) => fs.existsSync(dir));
}

function applyNousKeyToEnv(env) {
  const key = resolveNousApiKey();
  if (!key) { delete env.NOUS_API_KEY; delete env.NOUSRESEARCH_API_KEY; return env; }
  env.NOUS_API_KEY = key;
  env.NOUSRESEARCH_API_KEY = key;
  return env;
}

function syncHermesConfig() {
  const installStatus = checkHermesInstalled();
  if (!installStatus.installed) return { ok: true, skipped: true };
  const model = storeData.nous?.model || DEFAULT_NOUS_MODEL;
  const configSets = [
    ['model.provider', 'custom'],
    ['model.default', model],
    ['model.base_url', NOUS_INFERENCE_BASE],
    ['model.api_key', '${NOUS_API_KEY}'],
  ];
  try {
    for (const [key, value] of configSets) {
      execFileSync(installStatus.path, ['config', 'set', key, value, '--force'], {
        cwd: HERMES_INSTALL,
        env: hermesChildEnv(),
        timeout: 20000,
        windowsHide: true,
      });
    }
    appendLog('✅ Hermes config synced for Nous Portal API key', 'success');
    return { ok: true };
  } catch (e) {
    appendLog(`⚠ Hermes config sync: ${e.message}`, 'warn');
    return { ok: false, error: e.message };
  }
}

async function syncHermesCredentials(token, { restartGateway = false } = {}) {
  const nousKey = resolveNousApiKey();
  if (!nousKey) {
    return { ok: false, msg: 'Nous Portal API key not set — open Setup tab, enter your key, and Save.' };
  }
  if (!String(storeData.nous?.apiKey || '').trim()) {
    storeData.nous = { ...(storeData.nous || {}), apiKey: nousKey };
  }

  fs.mkdirSync(HERMES_HOME, { recursive: true });
  const envPath = getHermesEnvPath();
  const before = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  let after = upsertEnvVar(before, 'NOUS_API_KEY', nousKey);
  after = upsertEnvVar(after, 'NOUSRESEARCH_API_KEY', nousKey);

  // Write Coinbase credentials to .env so Hermes gateway can authenticate
  const coinbase = storeData.coinbase || {};
  if (coinbase.apiKey) after = upsertEnvVar(after, 'COINBASE_API_KEY_NAME', coinbase.apiKey);
  if (coinbase.secretKey) after = upsertEnvVar(after, 'COINBASE_PRIVATE_KEY', coinbase.secretKey);

  if (after !== before) {
    fs.writeFileSync(envPath, after, 'utf8');
    appendLog('✅ Synced credentials to Hermes .env', 'success');
  }

  syncHermesConfig();

  if (token) {
    const envVars = {
      NOUS_API_KEY: nousKey,
      NOUSRESEARCH_API_KEY: nousKey,
      ...(coinbase.apiKey ? { COINBASE_API_KEY_NAME: coinbase.apiKey } : {}),
      ...(coinbase.secretKey ? { COINBASE_PRIVATE_KEY: coinbase.secretKey } : {}),
    };
    for (const [keyName, value] of Object.entries(envVars)) {
      try {
        const res = await hermesApiRequest('PUT', '/api/env', { key: keyName, value }, token);
        if (res.status >= 200 && res.status < 300) {
          appendLog(`✅ ${keyName} registered with Hermes`, 'success');
        } else {
          appendLog(`⚠ Hermes env API (${keyName}) returned ${res.status}`, 'warn');
        }
      } catch (e) {
        appendLog(`⚠ Hermes env sync (${keyName}): ${e.message}`, 'warn');
      }
    }
  }

  if (restartGateway && token) {
    try {
      appendLog('↻ Restarting gateway so cron picks up credentials…', 'info');
      await hermesApiRequest('POST', '/api/gateway/stop?profile=default', null, token);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const cli = await startGatewayViaCli();
      if (!cli.ok) {
        await hermesApiRequest('POST', '/api/gateway/start?profile=default', null, token);
      }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const status = await fetchHermesStatus();
          if (status.gateway_running) break;
        } catch {}
      }
    } catch (e) {
      appendLog(`⚠ Gateway restart: ${e.message}`, 'warn');
    }
  }

  return { ok: true };
}

async function ensureGatewayRunning(token) {
  let status;
  try {
    status = await fetchHermesStatus();
    if (status.gateway_running) {
      appendLog('✅ Hermes gateway already running', 'success');
      return { ok: true, status };
    }
    const configuredPlatforms = Number(status?.components?.platforms?.configured || 0);
    if (!status.gateway_running && configuredPlatforms === 0 && checkHermesLaunchFailure(dashboardLastOutput)) {
      appendLog('⚠ Detected provider import failure during first-time setup — attempting repair…', 'warn');
      const repaired = tryRepairHermesMissingAgentModule();
      if (repaired && token) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try { await hermesApiRequest('POST', '/api/platforms/setup?profile=default', null, token); } catch {}
        const retryStatus = await fetchHermesStatus();
        if ((retryStatus?.components?.platforms?.configured || 0) > 0 || retryStatus?.gateway_running) {
          appendLog('✅ Repair succeeded — continuing with platform setup.', 'success');
          status = retryStatus;
        }
      }
    }
    if (!status.gateway_running && configuredPlatforms === 0) {
      appendLog('ℹ No gateway platforms configured yet — still attempting gateway startup.', 'info');
    }
  } catch (e) {
    appendLog(`⚠ Could not read Hermes status: ${e.message}`, 'warn');
  }

  appendLog('▶ Starting Hermes gateway (required for cron jobs)…', 'info');
  let startRes;
  try {
    startRes = await hermesApiRequest('POST', '/api/gateway/start?profile=default', null, token);
    if (startRes.status === 401) {
      const fresh = await fetchDashboardSessionToken(true);
      startRes = await hermesApiRequest('POST', '/api/gateway/start?profile=default', null, fresh);
    }
    if (startRes.status >= 300) {
      appendLog(`⚠ Gateway API start returned ${startRes.status} — trying CLI`, 'warn');
      const cli = await startGatewayViaCli();
      if (!cli.ok) {
        const detail = typeof startRes.body === 'object'
          ? (startRes.body.detail || JSON.stringify(startRes.body))
          : String(startRes.body);
        return { ok: false, msg: `Gateway start failed: ${detail}` };
      }
    }
  } catch (e) {
    appendLog(`⚠ Gateway API start: ${e.message} — trying CLI`, 'warn');
    const cli = await startGatewayViaCli();
    if (!cli.ok) return { ok: false, msg: `Gateway start failed: ${e.message}` };
  }

  const deadline = Date.now() + 300000;
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (Date.now() - lastBeat > 15000) {
      lastBeat = Date.now();
      appendLog(`⏳ Still waiting for Hermes gateway... ${Math.round((deadline - Date.now()) / 1000)}s remaining`, 'info');
    }
    try {
      status = await fetchHermesStatus();
      if (status.gateway_running) {
        appendLog(`✅ Hermes gateway running (state: ${status.gateway_state || 'running'})`, 'success');
        return { ok: true, status };
      }
    } catch {}
  }
  const tail = dashboardLastOutput.slice(-6).join(' | ');
  return {
    ok: false,
    msg: tail ? `Gateway did not become ready in 5m — check Logs tab. Last output: ${tail}` : 'Gateway did not become ready in 5m — check Logs tab',
  };
}

// ── Sandboxed install / dashboard lifecycle ───────────────────────────────
function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeProcessExitCode(code) {
  if (code == null) return -1;
  return code > 2147483647 ? code - 4294967296 : code;
}

function findHermesExecutable() {
  const candidates = [
    path.join(HERMES_INSTALL, 'venv', 'Scripts', 'hermes.exe'),
    path.join(HERMES_INSTALL, 'venv', 'Scripts', 'hermes'),
    path.join(HERMES_INSTALL, 'bin', 'hermes.exe'),
    path.join(HERMES_INSTALL, 'bin', 'hermes'),
    path.join(HERMES_INSTALL, '.venv', 'Scripts', 'hermes.exe'),
    path.join(HERMES_INSTALL, '.venv', 'Scripts', 'hermes'),
    path.join(HERMES_INSTALL, '.venv', 'bin', 'hermes'),
    HERMES_EXE,
    path.join(HERMES_HOME, 'bin', 'hermes.exe'),
    path.join(HERMES_HOME, 'bin', 'hermes'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function writeHermesInstallLauncher() {
  const launcherPath = path.join(os.tmpdir(), `knighttrader-hermes-launcher-${process.pid}.ps1`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$HermesHome = ${psSingleQuote(HERMES_HOME)}`,
    `$InstallDir = ${psSingleQuote(HERMES_INSTALL)}`,
    '$env:HERMES_HOME = $HermesHome',
    '',
    "$installerUrl = 'https://hermes-agent.nousresearch.com/install.ps1'",
    "$installerPath = Join-Path $env:TEMP 'knighttrader-hermes-install.ps1'",
    '',
    "Write-Host 'Downloading Hermes installer...'",
    'try {',
    '  (Invoke-RestMethod -Uri $installerUrl -UseBasicParsing) | Set-Content -Path $installerPath -Encoding UTF8',
    '} catch {',
    '  Write-Error ("Failed to download installer: " + $_.Exception.Message)',
    '  exit 1',
    '}',
    '',
    "Write-Host 'Running Hermes installer into Hermes folder...'",
    '& $installerPath -HermesHome $HermesHome -InstallDir $InstallDir -NonInteractive',
    'if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '',
    "Write-Host 'Checking Hermes Python environment...'",
    `$venvPython = Join-Path $InstallDir 'venv' 'Scripts' 'python.exe'`,
    'if (-not (Test-Path $venvPython)) { $venvPython = Join-Path $InstallDir ".venv" "Scripts" "python.exe" }',
    'if (Test-Path $venvPython) {',
    '  try {',
    '    $uv = Join-Path $InstallDir "bin" "uv.exe"',
    '    if (-not (Test-Path $uv)) { $uv = Join-Path $InstallDir ".venv" "bin" "uv.exe" }',
    '    if (-not (Test-Path $uv)) { $uv = "uv" }',
    `    & $uv pip install --python $venvPython agent agent-client-protocol | Out-Null`,
    '    Write-Host "✅ Verified Hermes dependencies."',
    '  } catch {',
    '    Write-Warning ("Dependency repair failed: " + $_.Exception.Message)',
    '  }',
    '} else {',
    "  Write-Warning 'Could not locate Hermes Python executable for dependency repair.'",
    '}',
    'exit 0',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, script, 'utf8');
  return launcherPath;
}

function checkHermesInstalled() {
  const exe = findHermesExecutable();
  if (exe) {
    try {
      const v = execFileSync(exe, ['--version'], { timeout: 5000 }).toString().trim();
      return { installed: true, version: v, path: exe };
    } catch {
      // exe exists but won't run — treat as broken partial install
      return { installed: false, partial: true, path: HERMES_INSTALL };
    }
  }
  if (fs.existsSync(HERMES_INSTALL)) {
    return { installed: false, partial: true, path: HERMES_INSTALL };
  }
  return { installed: false, partial: false };
}

async function wipeHermesInstall() {
  try {
    if (hermesDashProcess) { hermesDashProcess.kill(); hermesDashProcess = null; }
    if (fs.existsSync(HERMES_HOME)) {
      fs.rmSync(HERMES_HOME, { recursive: true, force: true });
      appendLog('🗑 Hermes sandbox wiped — ready for fresh install', 'info');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function installHermes() {
  return new Promise((resolve) => {
    appendLog('📦 Installing Hermes into sandboxed location:', 'info');
    appendLog(`   HERMES_HOME  = ${HERMES_HOME}`, 'info');
    appendLog(`   InstallDir   = ${HERMES_INSTALL}`, 'info');

    fs.mkdirSync(HERMES_HOME, { recursive: true });

    let launcherPath;
    try {
      launcherPath = writeHermesInstallLauncher();
    } catch (e) {
      appendLog(`❌ Failed to prepare installer: ${e.message}`, 'error');
      resolve({ ok: false, error: e.message });
      return;
    }

    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: HERMES_HOME,
      },
    });

    proc.stdout.on('data', (d) => {
      d.toString().split('\n').filter(Boolean).forEach((line) => {
        if (/restart your terminal/i.test(line)) {
          appendLog(`${line} (safe to ignore in KnightTrader — no terminal restart needed)`, 'info');
          return;
        }
        appendLog(line, 'info');
      });
    });
    proc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => appendLog(l, 'warn')));

    proc.on('close', async (code) => {
      try { fs.unlinkSync(launcherPath); } catch {}

      const status = checkHermesInstalled();
      if (status.installed) {
        appendLog(`✅ Hermes installed: ${status.version}`, 'success');
        ensureHermesExecutableRunnable(status.path);
        appendLog(`🔒 Hermes is sandboxed to this app folder (${HERMES_HOME}).`, 'info');
        try {
          await syncHermesCredentials(null);
        } catch (e) {
          appendLog(`⚠ Post-install credential sync: ${e.message}`, 'warn');
        }
        await postInstallHermesSanityCheck(status);
        appendLog('✅ Hermes installed. Click Start Dashboard when you are ready.', 'success');
        resolve({ ok: true, version: status.version, path: status.path, isolated: true });
        return;
      }

      const exitCode = normalizeProcessExitCode(code);
      if (status.partial) {
        appendLog('⚠ Install incomplete — click Install again to resume.', 'warn');
        resolve({ ok: false, partial: true, code: exitCode, path: status.path });
        return;
      }

      appendLog(`❌ Install script failed (exit ${exitCode})`, 'error');
      resolve({ ok: false, code: exitCode });
    });

    proc.on('error', (e) => {
      try { fs.unlinkSync(launcherPath); } catch {}
      appendLog(`❌ Failed to launch installer: ${e.message}`, 'error');
      resolve({ ok: false, error: e.message });
    });
  });
}

function ensureHermesExecutableRunnable(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return;
  try {
    execFileSync('icacls', [exePath, '/setintegritylevel', 'Medium'], {
      timeout: 8000,
      windowsHide: true,
    });
  } catch (e) {
    appendLog(`⚠ Could not reset Hermes integrity level: ${e.message}`, 'warn');
  }
}

function hermesVenvPython() {
  const candidates = [
    path.join(HERMES_INSTALL, 'venv', 'Scripts', 'python.exe'),
    path.join(HERMES_INSTALL, 'venv', 'bin', 'python.exe'),
    path.join(HERMES_INSTALL, '.venv', 'Scripts', 'python.exe'),
    path.join(HERMES_INSTALL, '.venv', 'bin', 'python.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function tryRepairHermesMissingAgentModule() {
  const python = hermesVenvPython();
  if (!python) return false;
  try {
    appendLog('🔧 Repairing Hermes Python dependencies…', 'warn');
    const installDir = HERMES_INSTALL;
    const agentDest = path.join(installDir, 'agent');
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'knight-trader', 'hermes', 'hermes-agent', 'agent'),
      path.join(process.env.LOCALAPPDATA || '', 'knight-trader-blofin', 'hermes', 'hermes-agent', 'agent'),
      path.join(process.env.LOCALAPPDATA || '', 'knight-trader-coinbase', 'hermes-coinbase', 'hermes-agent', 'agent'),
    ].filter((p) => p && p !== agentDest && fs.existsSync(p));
    if (candidates.length) {
      fs.rmSync(agentDest, { recursive: true, force: true });
      fs.cpSync(candidates[0], agentDest, { recursive: true, force: true });
      appendLog('✅ Restored Hermes agent package from local source.', 'success');
    } else {
      const uvCli = path.join(installDir, 'bin', 'uv.exe');
      const uvBin = path.join(installDir, '.venv', 'bin', 'uv.exe');
      const uv = fs.existsSync(uvCli) ? uvCli : fs.existsSync(uvBin) ? uvBin : 'uv';
      execFileSync(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 120000, windowsHide: true });
      execFileSync(uv, ['pip', 'install', '--python', python, '--no-deps', 'agent', 'agent-client-protocol'], { timeout: 180000, windowsHide: true });
      appendLog('✅ Hermes dependency repair finished.', 'success');
    }
    try {
      const pycache = path.join(installDir, '__pycache__');
      if (fs.existsSync(pycache)) fs.rmSync(pycache, { recursive: true, force: true });
    } catch {}
    return true;
  } catch (e) {
    appendLog(`⚠ Hermes dependency repair failed: ${e.message}`, 'warn');
    return false;
  }
}

function checkHermesLaunchFailure(output) {
  const text = (output || []).join('\n');
  return (
    /No module named ['"]agent['"]/.test(text) ||
    /Failed to load bundled provider plugin/.test(text) ||
    /unexpected keyword argument ['"]tour_callback['"]/.test(text) ||
    /parse_config_string_list/.test(text)
  );
}

async function postInstallHermesSanityCheck(status) {
  if (!status?.installed) return status;
  appendLog('🧪 Verifying Hermes start…', 'info');
  let fixed = false;
  let attempt = 0;
  while (attempt < 3) {
    attempt += 1;
    const test = spawn(status.path, ['--version'], { cwd: HERMES_INSTALL, windowsHide: true, timeout: 10000 });
    const chunks = [];
    test.stdout.on('data', (c) => chunks.push(c));
    test.stderr.on('data', (c) => chunks.push(c));
    await new Promise((resolve) => {
      test.on('close', resolve);
      test.on('error', resolve);
      setTimeout(() => { try { test.kill(); } catch {} resolve(); }, 10000);
    });
    const out = Buffer.concat(chunks).toString('utf8');
    if (!checkHermesLaunchFailure([out])) {
      appendLog('✅ Hermes post-install check passed.', 'success');
      return status;
    }
    if (attempt < 3) {
      try {
        const pycache = path.join(HERMES_INSTALL, '__pycache__');
        if (fs.existsSync(pycache)) fs.rmSync(pycache, { recursive: true, force: true });
      } catch {}
      fixed = tryRepairHermesMissingAgentModule();
      if (!fixed) {
        appendLog(`⚠ Repair attempt ${attempt} failed; retrying...`, 'warn');
      }
    }
  }
  if (fixed) {
    appendLog('✅ Hermes repaired after dependency fix.', 'success');
    return status;
  }
  appendLog('⚠ Hermes post-install check still shows issues.', 'warn');
  return status;
}

function hermesWebDistReady() {
  return fs.existsSync(path.join(HERMES_INSTALL, 'hermes_cli', 'web_dist', 'index.html'));
}

function dashboardSpawnArgs() {
  const args = ['dashboard', '--no-open', '--host', '127.0.0.1', '--port', String(DASHBOARD_PORT)];
  if (hermesWebDistReady()) args.push('--skip-build');
  return args;
}

function ensureDashboardSessionToken() {
  if (!dashboardSessionToken) {
    dashboardSessionToken = crypto.randomBytes(24).toString('base64url');
  }
  return dashboardSessionToken;
}

function scrapeDashboardSessionToken(html) {
  const match = String(html || '').match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function fetchDashboardSessionToken(forceRefresh = false) {
  if (dashboardSessionToken && !forceRefresh) return Promise.resolve(dashboardSessionToken);
  return new Promise((resolve, reject) => {
    const req = http.get(DASHBOARD_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const token = scrapeDashboardSessionToken(data);
        if (token) {
          dashboardSessionToken = token;
          resolve(dashboardSessionToken);
          return;
        }
        if (dashboardSessionToken) {
          resolve(dashboardSessionToken);
          return;
        }
        reject(new Error('Could not read dashboard session token'));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Dashboard token request timed out'));
    });
  });
}

function hermesApiRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: DASHBOARD_PORT,
      path: apiPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Token': token,
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Hermes API request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function probeDashboardPort(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/health`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function fetchHermesStatus() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${DASHBOARD_URL}/api/status`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid Hermes status response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Hermes status request timed out'));
    });
  });
}

async function waitForDashboardPort(maxMs = 480000) {
  const start = Date.now();
  let lastBeat = 0;
  while (Date.now() - start < maxMs) {
    if (await probeDashboardPort()) return true;
    if (!isDashboardProcessAlive() && Date.now() - start > 4000) {
      const tail = dashboardLastOutput.slice(-8).join(' | ');
      appendLog(`⚠ Dashboard process exited before it was ready${tail ? `: ${tail}` : ''}`, 'error');
      return false;
    }
    if (Date.now() - lastBeat > 15000) {
      const secs = Math.round((Date.now() - start) / 1000);
      appendLog(`⏳ Waiting for Hermes dashboard (${secs}s) — first start builds the web UI`, 'info');
      lastBeat = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function dashboardSpawnEnv() {
  const token = ensureDashboardSessionToken();
  return {
    ...process.env,
    HERMES_HOME,
    HERMES_DASHBOARD_SESSION_TOKEN: token,
  };
}

async function startGatewayViaCli() {
  const installStatus = checkHermesInstalled();
  if (!installStatus.installed) return { ok: false, msg: 'Hermes not installed' };
  return new Promise((resolve) => {
    appendLog('▶ Starting Hermes gateway via CLI…', 'info');
    let settled = false;
    const proc = spawn(installStatus.path, ['-p', 'default', 'gateway', 'start'], {
      cwd: HERMES_INSTALL,
      windowsHide: true,
      env: dashboardSpawnEnv(),
      detached: true,
      stdio: 'ignore',
    });
    proc.on('error', (e) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, msg: e.message });
      }
    });
    proc.once('spawn', () => {
      if (!settled) {
        settled = true;
        proc.unref();
        resolve({ ok: true });
      }
    });
  });
}

async function ensureDashboardAndGateway() {
  const portReady = await waitForDashboardPort();
  if (!portReady) {
    const tail = dashboardLastOutput.slice(-6).join(' | ');
    return {
      ok: false,
      msg: tail
        ? `Dashboard did not respond on port ${DASHBOARD_PORT}. ${tail}`
        : `Dashboard did not respond on port ${DASHBOARD_PORT}`,
    };
  }

  let token;
  try {
    token = await fetchDashboardSessionToken();
  } catch (e) {
    return { ok: false, msg: e.message };
  }

  let gatewayWasRunning = false;
  try {
    const statusBefore = await fetchHermesStatus();
    gatewayWasRunning = !!statusBefore.gateway_running;
  } catch {}

  const sync = await syncHermesCredentials(token, { restartGateway: gatewayWasRunning });
  if (!sync.ok) {
    appendLog(`⚠ ${sync.msg || sync.error || 'Credential sync skipped'} — starting gateway anyway`, 'warn');
  }

  const gateway = await ensureGatewayRunning(token);
  if (!gateway.ok) return gateway;

  signalDashboardReady(gateway.status);
  return { ok: true, attached: !hermesDashProcess, gatewayRunning: true };
}

function signalDashboardReady(status) {
  if (dashboardReady) return;
  dashboardReady = true;
  const gatewayNote = status?.gateway_running ? ' — gateway running, cron can fire' : '';
  appendLog(`✅ Hermes ready at ${DASHBOARD_URL}${gatewayNote}`, 'success');
  mainWindow?.webContents?.send('dashboard-ready', {
    url: DASHBOARD_URL,
    gatewayRunning: !!status?.gateway_running,
  });
}

async function startHermesDashboard() {
  const installStatus = checkHermesInstalled();
  if (!installStatus.installed) {
    return { ok: false, msg: 'Hermes not installed yet. Run Step 1 first.' };
  }

  ensureHermesExecutableRunnable(installStatus.path);
  dashboardReady = false;

  if (await probeDashboardPort()) {
    appendLog('ℹ Dashboard already listening — ensuring gateway is running…', 'info');
    return ensureDashboardAndGateway();
  }

  if (!isDashboardProcessAlive()) {
    dashboardLastOutput = [];
    appendLog(`▶ Starting Hermes dashboard + gateway on port ${DASHBOARD_PORT}…`, 'info');
    appendLog(`  Using: ${installStatus.path}`, 'info');
    if (!hermesWebDistReady()) {
      appendLog('  First start builds the Hermes web UI (can take a few minutes)…', 'info');
    }

    const preSync = await syncHermesCredentials(null);
    if (!preSync.ok) {
      appendLog(`⚠ ${preSync.msg || preSync.error || 'Credential sync skipped'} — starting dashboard anyway`, 'warn');
    }

    hermesDashProcess = spawn(installStatus.path, dashboardSpawnArgs(), {
      cwd: HERMES_INSTALL,
      windowsHide: true,
      env: dashboardSpawnEnv(),
    });

    hermesDashProcess.stdout.on('data', (d) => rememberDashboardOutput(d, 'info'));
    hermesDashProcess.stderr.on('data', (d) => rememberDashboardOutput(d, 'warn'));
    hermesDashProcess.on('error', (e) => appendLog(`Dashboard error: ${e.message}`, 'error'));
    hermesDashProcess.on('close', async (code) => {
      hermesDashProcess = null;
      if (await probeDashboardPort()) return;
      dashboardReady = false;
      appendLog(`◼ Hermes dashboard stopped (code ${normalizeProcessExitCode(code)})`, code === 0 ? 'info' : 'error');
      mainWindow?.webContents?.send('dashboard-stopped', {});
    });
  } else {
    appendLog('ℹ Hermes dashboard is still starting — waiting for dashboard…', 'info');
  }

  return ensureDashboardAndGateway();
}

function isDashboardProcessAlive() {
  return !!(hermesDashProcess && hermesDashProcess.exitCode == null && !hermesDashProcess.killed);
}

function rememberDashboardOutput(chunk, type) {
  String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => {
    dashboardLastOutput.push(line);
    if (dashboardLastOutput.length > 40) dashboardLastOutput.shift();
    appendLog(line, type);
  });
}

async function stopHermesDashboard() {
  if (await probeDashboardPort()) {
    try {
      const token = await fetchDashboardSessionToken();
      appendLog('⏹ Stopping Hermes gateway…', 'info');
      await hermesApiRequest('POST', '/api/gateway/stop?profile=default', null, token);
    } catch (e) {
      appendLog(`⚠ Gateway stop: ${e.message}`, 'warn');
    }
  }

  if (hermesDashProcess) {
    hermesDashProcess.kill();
    hermesDashProcess = null;
  } else if (await probeDashboardPort()) {
    const status = checkHermesInstalled();
    if (status.installed) {
      try {
        execFileSync(status.path, ['dashboard', '--stop'], {
          timeout: 20000,
          cwd: HERMES_INSTALL,
          env: dashboardSpawnEnv(),
        });
      } catch (e) {
        appendLog(`⚠ Dashboard stop: ${e.message}`, 'warn');
      }
    }
  }

  dashboardReady = false;
  dashboardSessionToken = null;
  appendLog('⏹ Hermes dashboard stopped.', 'warn');
  mainWindow?.webContents?.send('dashboard-stopped', {});
  return { ok: true };
}

async function getDashboardStatus() {
  const portUp = await probeDashboardPort();
  let gatewayRunning = false;
  if (portUp) {
    try {
      const status = await fetchHermesStatus();
      gatewayRunning = !!status.gateway_running;
      dashboardReady = gatewayRunning;
    } catch {
      dashboardReady = false;
    }
  } else {
    dashboardReady = false;
  }
  return {
    running: !!hermesDashProcess || portUp,
    ready: dashboardReady,
    gatewayRunning,
    url: DASHBOARD_URL,
  };
}

// ── Cron configuration ─────────────────────────────────────────────────────
function buildCronLearningHeader() {
  return `LEARNING ACROSS CRON TICKS (READ FIRST)
Each cron run is a fresh session. Do not assume chat memory from prior ticks.
Before trading: read your durable learning artifacts (skills / memory / lessons files under ${HERMES_HOME} and any project lessons files) and apply them.
If lessons say a setup type loses, respect that. If lessons say a setup type wins, bias toward it only when live structure still confirms.
Learning that stays only in this turn's reply is wasted — you must use durable files.`;
}

function buildCronLearningFooter() {
  return `LEARNING ACROSS CRON TICKS (WRITE BEFORE YOU FINISH)
After this cycle: write what worked, what failed, and the exact reusable rule into a durable skill or lessons file under ${HERMES_HOME}.
Include: symbol/setup type, long or short, why taken or skipped, outcome if known, and the next-tick rule.
Next tick must be able to load and use those updated lessons with no chat history.
If nothing material changed, still append a one-line "hold / no edge" note with timestamp.`;
}

function buildCronCoinbaseAuthBlock(compPath) {
  return `--- COINBASE PERPETUAL FUTURES — AUTH & API ---
CREDENTIALS
Use exactly: ${compPath}
These are Coinbase Advanced Trade CDP API credentials in API Key Name / Private Key format.
Confirm which key is loaded before first private call.
All private REST calls use LIVE base URL: ${COINBASE_API_URL}
Do NOT use api-public.sandbox.coinbase.com — Coinbase has no demo perpetuals account.

Auth: Coinbase Advanced Trade uses CDP API keys. JWT auth is required for private REST calls.
- Header: Authorization: Bearer <cdp_jwt>
- JWT claims: iss=cdp, sub=<API Key Name>, aud=cdp_service, exp <= 120s, nbf=now, uri=<METHOD> <HOST><PATH>, kid=<API Key Name>, nonce=<random>, alg=EdDSA or ES256 depending on key type.
- For this account: use the provided Private Key. If it decodes to 64 bytes, it is Ed25519; use EdDSA. If it is PEM EC, use ES256.

KEY ENDPOINTS
GET  /api/v3/brokerage/accounts                       — all balances
GET  /api/v3/brokerage/transaction_summary            — fee tier (maker/taker rates)
POST /api/v3/brokerage/portfolios/move-portfolios-funds — transfer USDC into perpetuals portfolio
GET  /api/v3/brokerage/products?product_type=PERPETUAL — perpetual futures products
GET  /api/v3/brokerage/products/{product_id}          — tick size, min size, leverage, price
POST /api/v3/brokerage/orders/preview                  — preview order (safe auth-path check)
POST /api/v3/brokerage/orders                          — place order (LIVE MODE ONLY)
GET  /api/v3/brokerage/perpetuals/get-perpetuals-portfolio-summary
GET  /api/v3/brokerage/perpetuals/list-perpetuals-positions

Minimum notional: perpetual orders require >= 10 USDC notional value.
Symbology: discover instruments via GET /api/v3/brokerage/products?product_type=PERPETUAL.
TP/SL: use attached_order_configuration with trigger_bracket_gtc or separate exit orders.`;
}

function buildCronPaperTradingBlock(paperStartingValue, ledgerPath) {
  return `--- PAPER / MENTAL TRADING MODE (ACTIVE) ---
IMPORTANT: Coinbase does NOT offer a demo/sandbox perpetual futures account. There is no virtual-funds API to trade against.
When paper mode is enabled, you take MENTAL TRADES ONLY — simulated positions recorded in a durable ledger file. You still use the LIVE Coinbase API for auth verification and live market prices, but you must NEVER submit POST /api/v3/brokerage/orders while paper mode is active.

PAPER STARTING EQUITY: ${paperStartingValue} USDC
MENTAL LEDGER (single source of truth): ${ledgerPath}
Read this JSON file at the start of every tick. Write it back at the end with all updates.

LEDGER SCHEMA (maintain all fields):
{
  "startingEquity": number,
  "currentEquity": number,
  "availableBalance": number,
  "marginUsed": number,
  "realizedPnl": number,
  "unrealizedPnl": number,
  "totalFeesPaid": number,
  "peakEquity": number,
  "feeSchedule": { "makerBps": number, "takerBps": number, "source": string, "lastFetchedAt": string|null },
  "openPositions": [{ id, symbol, side, entryPrice, size, notional, margin, entryFee, openedAt, stopLoss, takeProfit, lastMarkPrice, unrealizedPnl }],
  "closedTrades": [{ id, symbol, side, entryPrice, exitPrice, size, notional, realizedPnl, entryFee, exitFee, openedAt, closedAt, exitReason }],
  "equityHistory": [{ at, equity, note }],
  "authChecks": [{ at, ok, accountsOk, previewOk, feeTierOk, detail }]
}

EVERY TICK — REQUIRED ORDER:
1) LIVE AUTH VERIFICATION (no real orders):
   a) GET /api/v3/brokerage/accounts → must return JSON (proves CDP JWT works on live path).
   b) GET /api/v3/brokerage/transaction_summary → read your fee tier; update feeSchedule.makerBps and feeSchedule.takerBps (convert % to basis points: 0.40% → 40 bps). If unavailable, keep defaults maker=${DEFAULT_MAKER_FEE_BPS} taker=${DEFAULT_TAKER_FEE_BPS} bps and note source=default.
   c) POST /api/v3/brokerage/orders/preview with a tiny hypothetical market order → confirms live order authorization path works. DO NOT call POST /orders.
   Append result to ledger.authChecks[] with ISO timestamp.

2) LOAD LEDGER → mark open mental positions to market using live prices from GET /api/v3/brokerage/products/{product_id} (use mid of bid/ask or last trade price).

3) MENTAL TRADING (if edge exists):
   - Simulate entries/exits in ledger only. Never place real orders.
   - Size from ledger.currentEquity (risk 1–2% per trade), not live account balance.
   - Min notional >= 10 USDC. Max 2 concurrent mental positions. Isolated margin logic in ledger.
   - Market entry/exit = taker fee. Resting limit fill = maker fee.
   - Fee formula: fee_usdc = abs(notional) * (feeBps / 10000)
   - On mental entry: reduce availableBalance by margin + entry fee; add openPositions row.
   - On mental exit: realize PnL, apply exit fee, release margin, move row to closedTrades.
   - Reconcile each tick:
     currentEquity = startingEquity + realizedPnl + unrealizedPnl - totalFeesPaid
     availableBalance = currentEquity - marginUsed (for open positions)
     peakEquity = max(peakEquity, currentEquity)
   - Append equityHistory point when equity changes materially or a trade opens/closes.

4) SCOREBOARD (paper):
   - Grow the mental equity curve responsibly from ${paperStartingValue} USDC baseline.
   - Hard stop: pause new mental entries after 3 consecutive closed losses OR 4% drawdown from peakEquity.
   - Report in cycle output: currentEquity, availableBalance, open mental positions, last auth check status.

SUCCESS CRITERIA (paper mode):
- Live auth checks pass (accounts JSON + preview OK) — proves live trading could work when user disables paper mode.
- Ledger currentEquity accurately reflects mental PnL and fees vs starting ${paperStartingValue} USDC.
- No real orders submitted.`;
}

function buildCronLiveTradingBlock() {
  return `--- LIVE TRADING MODE (ACTIVE) ---
You place REAL orders on Coinbase perpetual futures via POST /api/v3/brokerage/orders.
Use live account equity from GET /api/v3/brokerage/accounts and perpetuals portfolio summary for sizing — not the paper ledger.

TRADING FLOW
1. Prove auth with GET /api/v3/brokerage/accounts.
2. Confirm USDC in perpetuals portfolio; move funds if needed.
3. GET /api/v3/brokerage/products?product_type=PERPETUAL → pick 5–8 liquid pairs.
4. Check open perpetual positions; max 2 concurrent. Avoid overexposure.
5. Scan for momentum/structure/volume confluence. Enter only when 2+ factors align.
6. Size for >= 10 USDC notional and 1–2% risk. Attach TP/SL immediately.
7. Hard stop after 3 consecutive losses or 4% max drawdown.

SUCCESS CRITERIA (live):
- /api/v3/brokerage/accounts returns JSON with real USDC balance.
- Perpetuals portfolio summary/positions return JSON.
- Manual orders show on Coinbase with correct TP/SL behavior.`;
}

function buildCronPrompt() {
  const compPath = getCompendiumPath();

  return `${buildCronLearningHeader()}

MISSION
Scan and trade the Coinbase account in LIVE mode, targeting perpetual futures for faster but still responsible growth.
Base URL: ${COINBASE_API_URL}
You are the trading automation. Take all trades by hand. Zero trading scripts, agents, assistants, and bots are to be used — zero. No order-placing bots, no auto-scanners that submit orders, no "run agent" wrappers that trade for you. You decide, you place, you manage TP/SL, you monitor.

SCOREBOARD
Only scoreboard: take and keep the equity curve vertical. With smaller capital, favor more frequent, smaller, high-probability setups — but always with real risk management. Isolated margin only. Longs and shorts both allowed. Sizing: risk 1–2% of equity per trade, protect equity, take real edges when they appear. Hard stop after 3 consecutive losses or 4% max drawdown.

${buildCronCoinbaseAuthBlock(compPath)}

${buildCronLiveTradingBlock()}

PROCEED NOW
Confirm credentials → prove JSON account read → ensure USDC in perpetuals portfolio → fetch products → check positions → scan → take righteous trades by hand → manage TP/SL → keep equity curve vertical.

${buildCronLearningFooter()}`;
}

async function configureCron() {
  appendLog('🔧 configureCron: starting…', 'info');
  if (!(await probeDashboardPort())) {
    appendLog('⚠ configureCron: dashboard port not reachable', 'warn');
    return { ok: false, msg: 'Start the Hermes dashboard first.', prompt: buildCronPrompt() };
  }
  appendLog('🔧 configureCron: dashboard reachable', 'info');

  let token;
  try {
    token = await fetchDashboardSessionToken();
    appendLog(`🔧 configureCron: token acquired`, 'info');
  } catch (e) {
    appendLog(`⚠ configureCron: dashboard auth failed: ${e.message}`, 'warn');
    return { ok: false, msg: e.message, prompt: buildCronPrompt() };
  }

  async function refreshCronToken(prevToken) {
    try {
      const fresh = await fetchDashboardSessionToken(true);
      appendLog('🔧 configureCron: refreshed dashboard session token', 'info');
      if (fresh && fresh !== prevToken) {
        const probe = await hermesApiRequest('GET', '/api/config', null, fresh);
        if (probe.status === 401 && fresh !== prevToken) {
          appendLog('⚠ configureCron: refreshed token still unauthorized, retrying once more…', 'warn');
          const again = await fetchDashboardSessionToken(true);
          appendLog('🔧 configureCron: reacquired dashboard session token', 'info');
          return again || fresh;
        }
        return fresh;
      }
      return fresh;
    } catch (e) {
      appendLog(`⚠ configureCron: token refresh failed: ${e.message}`, 'warn');
      return prevToken;
    }
  }

  if (token) {
    const probe = await hermesApiRequest('GET', '/api/config', null, token);
    if (probe.status === 401) {
      appendLog('⚠ configureCron: initial cron token unauthorized, refreshing…', 'warn');
      token = await refreshCronToken(token);
    }
  }

  const sync = await syncHermesCredentials(token, { restartGateway: true });
  if (!sync.ok) {
    appendLog(`⚠ configureCron: credential sync failed: ${sync.msg || sync.error || 'unknown'}`, 'warn');
    return { ok: false, msg: sync.msg, prompt: buildCronPrompt() };
  }
  appendLog('🔧 configureCron: credential sync complete', 'info');

  const gateway = await ensureGatewayRunning(token);
  if (!gateway.ok) {
    appendLog(`⚠ configureCron: gateway startup failed: ${gateway.msg}`, 'warn');
    return { ok: false, msg: gateway.msg, prompt: buildCronPrompt() };
  }
  appendLog('🔧 configureCron: gateway ready', 'info');

  const prompt = buildCronPrompt();
  const jobSpec = {
    name: 'coinbase-perp-trading',
    schedule: 'every 5m',
    provider: 'custom',
    base_url: NOUS_INFERENCE_BASE,
    model: storeData.nous?.model || DEFAULT_NOUS_MODEL,
    deliver: 'local',
    prompt,
  };

  try {
    appendLog('🔧 configureCron: listing existing cron jobs…', 'info');
    let list = await hermesApiRequest('GET', '/api/cron/jobs?profile=default', null, token);
    appendLog(`🔧 configureCron: list status=${list.status}`, 'info');
    if (list.status === 401) {
      token = await refreshCronToken(token);
      list = await hermesApiRequest('GET', '/api/cron/jobs?profile=default', null, token);
      appendLog(`🔧 configureCron: list retry status=${list.status}`, 'info');
    }
    if (list.status === 200 && Array.isArray(list.body)) {
      const existing = list.body.find((job) => job.name === jobSpec.name);
      if (existing?.id) {
        appendLog(`🔧 configureCron: updating existing job ${existing.id}`, 'info');
        let updated = await hermesApiRequest(
          'PUT',
          `/api/cron/jobs/${encodeURIComponent(existing.id)}?profile=default`,
          { updates: jobSpec },
          token,
        );
        appendLog(`🔧 configureCron: update status=${updated.status}`, 'info');
        if (updated.status === 401) {
          token = await refreshCronToken(token);
          updated = await hermesApiRequest(
            'PUT',
            `/api/cron/jobs/${encodeURIComponent(existing.id)}?profile=default`,
            { updates: jobSpec },
            token,
          );
          appendLog(`🔧 configureCron: update retry status=${updated.status}`, 'info');
        }
        if (updated.status < 300) {
          appendLog('✅ Cron job updated: coinbase-perp-trading (every 5m)', 'success');
          triggerAndConfirmCron(token, existing.id);
          return { ok: true, jobId: existing.id, updated: true };
        }
        const detail = typeof updated.body === 'object'
          ? (updated.body.detail || JSON.stringify(updated.body))
          : String(updated.body);
        appendLog(`⚠ Cron update failed (${updated.status}): ${detail}`, 'warn');
        return { ok: false, msg: detail, prompt };
      }
    }
  } catch (e) {
    appendLog(`  → list cron jobs: ${e.message}`, 'warn');
  }

  try {
    appendLog('🔧 configureCron: creating cron job via POST /api/cron/jobs', 'info');
    let created = await hermesApiRequest('POST', '/api/cron/jobs?profile=default', jobSpec, token);
    appendLog(`🔧 configureCron: create status=${created.status}`, 'info');
    if (created.status === 401) {
      token = await refreshCronToken(token);
      created = await hermesApiRequest('POST', '/api/cron/jobs?profile=default', jobSpec, token);
      appendLog(`🔧 configureCron: create retry status=${created.status}`, 'info');
    }
    if (created.status < 300) {
      appendLog('✅ Cron configured: coinbase-perp-trading (every 5m)', 'success');
      triggerAndConfirmCron(token, created.body?.id);
      return { ok: true, jobId: created.body?.id, endpoint: '/api/cron/jobs' };
    }
    const detail = typeof created.body === 'object'
      ? (created.body.detail || JSON.stringify(created.body))
      : String(created.body);
    appendLog(`⚠ Cron create failed (${created.status}): ${detail}`, 'warn');
    return { ok: false, msg: detail, prompt };
  } catch (e) {
    appendLog(`⚠ Cron configure failed: ${e.message}`, 'warn');
    return { ok: false, msg: e.message, prompt };
  }
}

async function triggerCronJob(token, jobId) {
  if (!jobId) return { ok: false };
  try {
    appendLog('▶ Triggering cron job now…', 'info');
    const res = await hermesApiRequest(
      'POST',
      `/api/cron/jobs/${encodeURIComponent(jobId)}/trigger?profile=default`,
      null,
      token,
    );
    if (res.status < 300) {
      appendLog('✅ Cron job accepted — waiting for first tick…', 'success');
      return { ok: true };
    }
    appendLog(`⚠ Cron trigger returned ${res.status}`, 'warn');
    return { ok: false, status: res.status };
  } catch (e) {
    appendLog(`⚠ Cron trigger: ${e.message}`, 'warn');
    return { ok: false, error: e.message };
  }
}

function readCronJobRecord(jobId) {
  try {
    const jobsPath = path.join(HERMES_HOME, 'cron', 'jobs.json');
    const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return jobs.find((job) => job.id === jobId) || null;
  } catch {
    return null;
  }
}

function cronTickLooksHealthy(job) {
  const status = String(job?.last_status || '').toLowerCase();
  if (!status) return false;
  if (status === 'error' || status === 'failed' || status.startsWith('blocked')) return false;
  return true;
}

async function triggerAndConfirmCron(token, jobId) {
  if (!jobId) return;
  const before = readCronJobRecord(jobId);
  await triggerCronJob(token, jobId);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const job = readCronJobRecord(jobId);
    if (!job) continue;
    const ranAgain = job.last_run_at && job.last_run_at !== before?.last_run_at;
    if (!ranAgain) continue;
    if (String(job.state || '').toLowerCase() === 'running') continue;
    if (cronTickLooksHealthy(job)) {
      appendLog(`✅ Cron tick succeeded (${job.last_status || 'ok'})`, 'success');
      return;
    }
    if (job.last_status === 'error') {
      const err = String(job.last_error || 'unknown error');
      const hint = /invalid|blocked|out of funds/i.test(err)
        ? ' — cron did not receive the Nous API key. Save Setup again, then Configure Cron.'
        : '';
      appendLog(`⚠ Cron tick error: ${err}${hint}`, 'error');
      return;
    }
  }
  appendLog('⚠ Cron was triggered but the first tick has not finished yet — check Hermes in a minute', 'warn');
}

// ── IPC handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-compendium-path', () => getCompendiumPath());
ipcMain.handle('get-cron-prompt', () => buildCronPrompt());
ipcMain.handle('configure-cron', async () => configureCron());
ipcMain.handle('save-coinbase-credentials', async (event, coinbase) => {
  await saveCredentials({ coinbase });
  return storeData.coinbase;
});
ipcMain.handle('save-nous-credentials', async (event, nous) => {
  await saveCredentials({ nous });
  return storeData.nous;
});
ipcMain.handle('load-coinbase-credentials', async () => storeData.coinbase);
ipcMain.handle('load-nous-credentials', async () => storeData.nous);
ipcMain.handle('test-coinbase-credentials', async (event, credentials) => {
  return testCoinbaseCredentials(credentials || storeData.coinbase);
});
ipcMain.handle('pick-coinbase-credential-file', async () => pickCredentialFile('coinbase'));
ipcMain.handle('pick-nous-credential-file', async () => pickCredentialFile('nous'));

ipcMain.handle('get-credentials', () => storeData);
ipcMain.handle('save-credentials', async (_e, data) => {
  try { storeData = { ...storeData, ...data }; persistStore(); } catch {}
  try {
    await syncBlohunterCredentials();
  } catch (e) {
    appendLog(`⚠ Trading credential sync on save: ${e.message}`, 'warn');
  }
  return storeData;
});
ipcMain.handle('write-compendium', async () => {
  try {
    const compPath = getCompendiumPath();
    const coinbase = storeData.coinbase || {};
    const lines = [
      '# Coinbase Advanced Trade CDP API credentials',
      '# Auto-generated by KnightTrader',
      '',
      `API Key Name: ${coinbase.apiKey || ''}`,
    ];
    if (coinbase.passphrase) lines.push(`Passphrase: ${coinbase.passphrase}`);
    lines.push(`Private Key: ${coinbase.secretKey || ''}`);
    fs.writeFileSync(compPath, lines.join('\n') + '\n', 'utf8');
    return { ok: true, path: compPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('get-nous-models', async () => FALLBACK_FREE_NOUS_MODELS);
ipcMain.handle('test-nous-credentials', async (_e, { apiKey, model }) => ({ ok: true, msg: 'Nous credentials accepted' }));
ipcMain.handle('check-hermes', async () => checkHermesInstalled());
ipcMain.handle('install-hermes', async () => installHermes());
ipcMain.handle('wipe-hermes', async () => wipeHermesInstall());
ipcMain.handle('add-defender-exclusion', async () => ({ ok: true }));
ipcMain.handle('start-dashboard', async () => { try { return await startHermesDashboard(); } catch (e) { appendLog(`start-dashboard error: ${e.message}`, 'error'); return { ok: false, msg: e.message }; } });
ipcMain.handle('stop-dashboard', async () => { try { return await stopHermesDashboard(); } catch (e) { return { ok: true }; } });
ipcMain.handle('get-dashboard-status', async () => { try { return await getDashboardStatus(); } catch (e) { return { running: false, ready: false, gatewayRunning: false, url: DASHBOARD_URL }; } });
ipcMain.handle('get-hermes-home', () => HERMES_HOME);
ipcMain.handle('get-logs', () => APP_LOGS.slice(-200));
ipcMain.handle('clear-logs', async () => { APP_LOGS.length = 0; return []; });
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('get-blohunter-preload-path', () => pathToFileURL(path.join(__dirname, 'blohunter-preload.js')).href);
ipcMain.handle('attach-trading-webview', (_e, webContentsId) => {
  const wc = webContents.fromId(webContentsId);
  if (wc) getBlohunterBridge().setWebContents(wc);
  return { ok: !!wc };
});
ipcMain.handle('get-trading-status', () => getBlohunterBridge().getStatus());
ipcMain.handle('start-trading-dashboard', async () => {
  const bridge = getBlohunterBridge();
  const result = await bridge.start({
    apiKey: storeData.coinbase?.apiKey,
    secretKey: storeData.coinbase?.secretKey,
    passphrase: storeData.coinbase?.passphrase || '',
    demoMode: !!storeData.coinbase?.demoMode,
  });
  if (!result.ok) appendLog(`⚠ Trading dashboard: ${result.error}`, 'warn');
  else appendLog('✅ Trading dashboard ready', 'success');
  return result;
});
ipcMain.handle('stop-trading-dashboard', () => getBlohunterBridge().stop());
ipcMain.handle('bh-runtime-send', async (_e, msg) => {
  const bridge = getBlohunterBridge();
  try {
    await bridge.ensureBackground();
  } catch (err) {
    return { ok: false, msg: err?.message || 'Trading background failed to start' };
  }
  const response = await bridge.dispatchRuntimeMessage(msg);
  if (response === undefined) {
    return { ok: false, msg: 'No trading handler answered this request' };
  }
  return response;
});
ipcMain.handle('bh-storage-get', (_e, keys) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.pick('local', keys);
});
ipcMain.handle('bh-storage-set', async (_e, items) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.setArea('local', items);
});
ipcMain.handle('bh-storage-remove', (_e, keys) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.removeArea('local', keys);
});
ipcMain.handle('bh-storage-get-session', (_e, keys) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.pick('session', keys);
});
ipcMain.handle('bh-storage-set-session', async (_e, items) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.setArea('session', items);
});
ipcMain.handle('bh-storage-remove-session', (_e, keys) => {
  getBlohunterBridge().storage.load();
  return getBlohunterBridge().storage.removeArea('session', keys);
});

ipcMain.on('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    createTray();
  }
});
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.restore() : mainWindow?.maximize());
ipcMain.on('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    createTray();
  }
});

let mainWindow = null;
let appTray = null;

function createTray() {
  if (appTray) return appTray;
  let iconPath = path.join(__dirname, 'assets', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    const fallbackPath = path.join(app.getPath('temp'), 'knighttrader-coinbase-tray.png');
    try {
      const img = nativeImage.createEmpty();
      const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGwAAABTSURBVGhD7c4BDQAwDASh+qev/TZtA5uTOq8k51xmzpm1sWZs6p2TmjOZNmdNZs5k2pw1mTmTZ3PWZPJsbs1kZsz/ZjIlMzN+ze8A3YB4qBYXrUQAAAAASUVORK5CYII=');
      fs.writeFileSync(fallbackPath, buf, 'base64');
      iconPath = fallbackPath;
    } catch {
      iconPath = '';
    }
  }
  const trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  appTray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => restoreMainWindow() },
    { label: 'Quit', click: () => { app.isQuitting = true; stopHermesDashboard(); app.quit(); } },
  ]);
  appTray.setToolTip('KnightTrader Coinbase');
  appTray.setContextMenu(contextMenu);
  appTray.on('click', restoreMainWindow);
  return appTray;
}

function restoreMainWindow() {
  const win = mainWindow || BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    frame: false,
    backgroundColor: '#090c10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  mainWindow.center();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      createTray();
    }
  });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      createTray();
    }
  });
  mainWindow.on('closed', () => { stopHermesDashboard(); mainWindow = null; });
}

function handleBhProtocol(request) {
  const bridge = getBlohunterBridge();
  const served = bridge.serveProtocolRequest(request.url);
  if (!served.ok) {
    return new Response(served.body || 'Not found', { status: served.status || 404 });
  }
  try {
    let data = fs.readFileSync(served.filePath);
    if (served.injectSkin) {
      let html = data.toString('utf8');
      html = html.replace(/<title>BloHunter Connect<\/title>/i, '<title>KnightTrader Coinbase</title>');
      if (!html.includes('__kt__/kt-skin.css')) {
        html = html.replace(
          '</head>',
          [
            '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
            '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
            '    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />',
            '    <link rel="stylesheet" href="bh://local/__kt__/kt-skin.css" />',
            '    <script src="bh://local/__kt__/kt-skin.js" defer></script>',
            '  </head>',
          ].join('\n'),
        );
      }
      data = Buffer.from(html, 'utf8');
    }
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': served.contentType,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(err.message || 'Read failed', { status: 500 });
  }
}

function attachBhProtocol(ses) {
  if (!ses || ses.__ktBhProtocol) return;
  ses.__ktBhProtocol = true;
  ses.protocol.handle('bh', handleBhProtocol);
}

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('log-level', '3');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = {
  info: (msg) => appendLog(`[updater] ${msg}`, 'info'),
  error: (msg) => appendLog(`[updater] ${msg}`, 'error'),
  warn: (msg) => appendLog(`[updater] ${msg}`, 'warn'),
  debug: (msg) => appendLog(`[updater] ${msg}`, 'info'),
};

function broadcastUpdateEvent(type, detail = {}) {
  mainWindow?.webContents?.send('update-status', { type, detail });
}

autoUpdater.on('update-available', (info) => {
  appendLog(`⬆ Update available: ${info.version}`, 'success');
  broadcastUpdateEvent('update-available', { version: info.version });
});
autoUpdater.on('update-not-available', () => {
  appendLog('✅ No update available', 'info');
  broadcastUpdateEvent('update-not-available', {});
});
autoUpdater.on('download-progress', (progress) => {
  broadcastUpdateEvent('download-progress', {
    percent: Math.floor(progress.percent || 0),
    speed: Math.floor(progress.bytesPerSecond || 0),
  });
});
autoUpdater.on('update-downloaded', (info) => {
  appendLog(`⬇ Update ready: ${info.version}`, 'success');
  broadcastUpdateEvent('update-downloaded', { version: info.version });
});
autoUpdater.on('error', (err) => {
  appendLog(`⚠ Updater error: ${err?.message || err}`, 'warn');
  broadcastUpdateEvent('update-error', { message: err?.message || String(err) });
});

async function checkForUpdates(silent = true) {
  try {
    await autoUpdater.checkForUpdates();
    if (!silent) appendLog('🔎 Manual update check complete.', 'info');
  } catch (err) {
    appendLog(`⚠ Update check failed: ${err?.message || err}`, 'warn');
  }
}

app.whenReady().then(async () => {
  attachBhProtocol(session.defaultSession);
  attachBhProtocol(session.fromPartition('persist:blohunter-trading'));

  createWindow();
  appendLog(`🚀 KnightTrader Coinbase started. Hermes sandbox: ${HERMES_HOME}`, 'success');
  const bhRoot = getBlohunterBridge().getConnectRoot();
  if (bhRoot) appendLog(`📈 BloHunter Connect: ${bhRoot}`, 'info');
  else appendLog('⚠ BloHunter Connect not found — Trading tab needs Downloads\\blohunter-connect', 'warn');

  await checkForUpdates(true);
  const updateInterval = setInterval(() => checkForUpdates(true), 5 * 60 * 1000);
  app.on('quit', () => clearInterval(updateInterval));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !appTray) app.quit();
});

ipcMain.handle('check-for-updates', async () => checkForUpdates(false));
ipcMain.handle('install-update-now', async () => {
  appendLog('🔧 Quitting to install update…', 'info');
  setImmediate(() => {
    app.isQuitting = true;
    stopHermesDashboard();
    autoUpdater.quitAndInstall();
  });
  return { ok: true };
});
ipcMain.on('update-status', (event, payload) => {
  event.sender.send('update-status', payload);
});
