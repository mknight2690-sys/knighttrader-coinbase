const { app, BrowserWindow, ipcMain, shell, dialog, protocol, webContents, session, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { BlohunterBridge } = require('./blohunter-bridge');
const {
  fetchLiveProprAccount: fetchLiveProprFromLib,
  testProprCredentials: testProprFromLib,
  PROPR_API_URL,
} = require('./lib/propr-api');
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
const NVIDIA_INFERENCE_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_INFERENCE_URL = `${NVIDIA_INFERENCE_BASE}/chat/completions`;

// NVIDIA NIM free models (pengsonal / build.nvidia.com) — benchmark score orders auto-ping (best first).
const NVIDIA_BENCHMARK_MODELS = [
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (NVIDIA NIM · free)', benchmark: 100 },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3 (NVIDIA NIM · free)', benchmark: 95 },
  { id: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (NVIDIA NIM · free)', benchmark: 90 },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash (NVIDIA NIM · free)', benchmark: 85 },
];
const DASHBOARD_PORT = 9130;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

const HERMES_HOME    = path.join(app.getPath('userData'), 'hermes-propr');
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

const PROPR_REST_URL = PROPR_API_URL;

const DEFAULT_NOUS_MODEL = 'tencent/hy3:free';

const FALLBACK_FREE_NOUS_MODELS = [
  { id: 'tencent/hy3:free', label: 'tencent/hy3:free (free)' },
  { id: 'upstage/solar-pro4:free', label: 'upstage/solar-pro4:free (free)' },
  { id: 'meituan/longcat-2.0:free', label: 'meituan/longcat-2.0:free (free)' },
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
  propr: { apiKey: '', accountId: '' },
  nvidia: { apiKey: '' },
  nous: { apiKey: '', model: DEFAULT_NOUS_MODEL },
  settings: { notifySounds: true },
};

const LEGACY_NOUS_MODELS = {
  'hunyuan-turbos-latest': 'tencent/hy3:free',
  'hunyuan-lite': 'tencent/hy3:free',
  'hunyuan-standard': 'tencent/hy3',
  'tencent/hy free': 'tencent/hy3:free',
  'openrouter/elephant-alpha': 'tencent/hy3:free',
  'poolside/laguna-m.1:free': 'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-super-120b-a12b:free': 'upstage/solar-pro4:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'meituan/longcat-2.0:free',
  'inclusionai/ring-2.6-1t:free': 'stepfun/step-3.7-flash:free',
  'deepseek/deepseek-v4-flash-free': 'tencent/hy3:free',
};

function normalizeNousModel(value) {
  const v = String(value || '').trim();
  return LEGACY_NOUS_MODELS[v] || v || DEFAULT_NOUS_MODEL;
}

function migrateStoreData(raw) {
  const merged = { ...DEFAULTS, ...raw };
  if (merged.coinbase?.apiKey && !merged.propr?.apiKey) {
    merged.propr = {
      apiKey: String(merged.coinbase.apiKey || '').trim(),
      accountId: String(merged.propr?.accountId || '').trim(),
    };
  }
  if (!merged.propr) merged.propr = { apiKey: '', accountId: '' };
  merged.propr = {
    apiKey: String(merged.propr.apiKey || '').trim(),
    accountId: String(merged.propr.accountId || '').trim(),
  };
  delete merged.coinbase;
  if (!merged.nvidia) merged.nvidia = { apiKey: '' };
  merged.nvidia = { apiKey: String(merged.nvidia.apiKey || '').trim() };
  if (merged.nous) {
    merged.nous = {
      apiKey: merged.nous.apiKey || '',
      model: normalizeNousModel(merged.nous.model),
    };
  }
  return merged;
}

function bootstrapNvidiaKeyFromDocuments() {
  if (String(storeData.nvidia?.apiKey || '').trim()) return false;
  const candidates = [
    path.join(os.homedir(), 'OneDrive', 'Documents', 'Nvidia API Key.txt'),
    path.join(os.homedir(), 'Documents', 'Nvidia API Key.txt'),
    path.join(os.homedir(), 'Downloads', 'Nvidia API Key.txt'),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const key = fs.readFileSync(filePath, 'utf8').trim();
      if (!/^nvapi-/i.test(key)) continue;
      storeData.nvidia = { apiKey: key };
      saveStore(storeData);
      appendLog(`🔑 Loaded NVIDIA API key from ${filePath}`, 'success');
      return true;
    } catch {}
  }
  return false;
}

function isNvidiaModel(modelId) {
  const id = String(modelId || '').trim();
  return NVIDIA_BENCHMARK_MODELS.some((m) => m.id === id);
}

function resolveInferenceForModel(modelId) {
  if (isNvidiaModel(modelId)) {
    return {
      provider: 'nvidia',
      baseUrl: NVIDIA_INFERENCE_BASE,
      chatUrl: NVIDIA_INFERENCE_URL,
      apiKeyEnv: 'NVIDIA_API_KEY',
      pingTimeoutMs: 120000,
    };
  }
  return {
    provider: 'nous',
    baseUrl: NOUS_INFERENCE_BASE,
    chatUrl: NOUS_INFERENCE_URL,
    apiKeyEnv: 'NOUS_API_KEY',
    pingTimeoutMs: 25000,
  };
}

function resolveApiKeyForModel(modelId, nousKeyOverride = '') {
  const inf = resolveInferenceForModel(modelId);
  if (inf.provider === 'nvidia') {
    return { ...inf, apiKey: String(storeData.nvidia?.apiKey || '').trim() };
  }
  return { ...inf, apiKey: String(nousKeyOverride || storeData.nous?.apiKey || '').trim() };
}

function extractChatReply(parsed) {
  const msg = parsed?.choices?.[0]?.message;
  return String(
    msg?.content?.trim()
    || msg?.reasoning_content?.trim()
    || parsed?.choices?.[0]?.text?.trim()
    || '',
  );
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
  if (!storeData.propr?.apiKey) return;
  await bridge.syncCredentials({
    apiKey: storeData.propr.apiKey,
    secretKey: 'propr',
    passphrase: 'propr',
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
    } else if (key === 'propr_api_key' || key === 'api_key' || key === 'x_api_key') set('propr', 'apiKey', value);
    else if (key === 'propr_account_id' || key === 'account_id') set('propr', 'accountId', value);
    else if (key === 'nvidia_api_key' || key === 'nvapi_key') set('nvidia', 'apiKey', value);
  }
}

function finalizeNousCredentials(parsed, text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (!parsed.propr.apiKey) {
    const pkLine = lines.find((line) => /^pk_live_/i.test(line));
    if (pkLine) parsed.propr.apiKey = pkLine.trim();
  }
  if (!parsed.nvidia.apiKey) {
    const nvLine = lines.find((line) => /^nvapi-/i.test(line));
    if (nvLine) parsed.nvidia.apiKey = nvLine.trim();
  }

  if (parsed.nous.apiKey) return;

  for (const line of lines) {
    const labeled = line.match(/^(?:nous\s*)?(?:portal\s*)?api\s*key[^:=]*[:=]\s*(.+)$/i);
    if (labeled) {
      parsed.nous.apiKey = stripCredentialValue(labeled[1]);
      return;
    }
  }

  const rawLines = lines.filter((line) => !/[:=]/.test(line));
  for (const line of rawLines) {
    if (/^pk_live_/i.test(line)) continue;
    if (looksLikeApiKey(line)) {
      parsed.nous.apiKey = line;
      return;
    }
  }

  if (lines.length === 1) {
    const parts = lines[0].split(/[:=]/);
    if (parts.length >= 2) {
      const candidate = stripCredentialValue(parts.slice(1).join('='));
      if (looksLikeApiKey(candidate) && !/^pk_live_/i.test(candidate)) parsed.nous.apiKey = candidate;
    } else if (looksLikeApiKey(lines[0]) && !/^pk_live_/i.test(lines[0])) {
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
  if (source.propr && typeof source.propr === 'object') {
    if (source.propr.apiKey) target.propr.apiKey = String(source.propr.apiKey).trim();
    if (source.propr.accountId) target.propr.accountId = String(source.propr.accountId).trim();
  }
  if (source.nvidia && typeof source.nvidia === 'object') {
    if (source.nvidia.apiKey) target.nvidia.apiKey = String(source.nvidia.apiKey).trim();
  }
  if (source.coinbase?.apiKey && !target.propr.apiKey) {
    target.propr.apiKey = String(source.coinbase.apiKey).trim();
  }
}

function parseCredentialFileContent(content) {
  const parsed = {
    nous: { apiKey: '', model: '' },
    propr: { apiKey: '', accountId: '' },
    nvidia: { apiKey: '' },
  };
  const text = String(content || '').trim();
  if (!text) return parsed;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      mergeCredentialObjects(parsed, JSON.parse(text));
      if (parsed.nous.apiKey || parsed.nous.model || parsed.propr.apiKey) return parsed;
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
  const defaultPath = kind === 'propr'
    ? path.join(os.homedir(), 'OneDrive', 'Documents', 'Propr API Key.txt')
    : getNousCredentialDefaultPath();

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'propr' ? 'Select Propr API key file' : 'Select Nous Portal credentials file',
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

    const propr = {
      apiKey: parsed.propr.apiKey || '',
      accountId: parsed.propr.accountId || '',
    };
    if (!propr.apiKey) {
      return { ok: false, error: 'Propr API key (pk_live_…) not found in that file.', path: filePath };
    }
    appendLog(`📂 Loaded Propr credentials from ${filePath}`, 'success');
    return { ok: true, path: filePath, propr };
  } catch (e) {
    return { ok: false, error: `Failed to read credential file: ${e.message}`, path: filePath };
  }
}

function saveCredentials({ propr, nous }) {
  if (propr) {
    storeData.propr = {
      apiKey: String(propr.apiKey || storeData.propr.apiKey || '').trim(),
      accountId: String(propr.accountId || storeData.propr.accountId || '').trim(),
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
  return path.join(base, 'propr-credentials.txt');
}

function writeCompendiumFile(propr) {
  const compPath = getCompendiumPath();
  const lines = [
    `# Propr trading API credentials`,
    `# Auto-generated by KnightTrader Propr`,
    ``,
    `Propr API Key: ${propr.apiKey}`,
  ];
  if (propr.accountId) {
    lines.push(`Account ID: ${propr.accountId}`);
  }
  fs.writeFileSync(compPath, lines.join('\n') + '\n', 'utf8');
  return compPath;
}

function getProprBaseUrl() {
  return PROPR_REST_URL;
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
  if (!trimmed) throw new Error('Private key is empty');

  if (trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    const nested = parsed?.privateKey || parsed?.private_key || parsed?.secret;
    if (nested) return importCoinbaseSecret(nested);
  }

  if (trimmed.includes('BEGIN')) {
    const pem = trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
    return crypto.createPrivateKey(pem);
  }

  const raw = trimmed.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw new Error('Unrecognized Coinbase private key. Paste the EC PEM or Ed25519 key from the CDP download.');
  }

  const secretBytes = Buffer.from(raw, 'base64');
  if (secretBytes.length === 64) {
    const seed = secretBytes.subarray(0, 32);
    const pub = secretBytes.subarray(32, 64);
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

function derEcdsaSignatureToJose(derSig, size = 32) {
  const der = Buffer.isBuffer(derSig) ? derSig : Buffer.from(derSig);
  if (der.length === size * 2) return der;
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('ECDSA signature is not DER');
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const nbytes = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < nbytes; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  const readInt = () => {
    if (der[offset++] !== 0x02) throw new Error('ECDSA signature missing integer');
    let len = der[offset++];
    if (len & 0x80) {
      const nbytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < nbytes; i++) len = (len << 8) | der[offset++];
    }
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    if (bytes.length && bytes[0] === 0x00) bytes = bytes.subarray(1);
    if (bytes.length > size) bytes = bytes.subarray(bytes.length - size);
    if (bytes.length < size) {
      const padded = Buffer.alloc(size);
      bytes.copy(padded, size - bytes.length);
      return padded;
    }
    return Buffer.from(bytes);
  };
  return Buffer.concat([readInt(), readInt()]);
}

async function buildCoinbaseJwt(apiKey, secretKey, method, requestPath, baseUrl) {
  const secret = String(secretKey || '').trim();
  if (!secret) return null;

  const key = importCoinbaseSecret(secret);
  const alg = key.asymmetricKeyType === 'ed25519' ? 'EdDSA' : 'ES256';
  const now = Math.floor(Date.now() / 1000);
  const host = String(baseUrl || 'https://api.coinbase.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const uri = `${String(method || 'GET').toUpperCase()} ${host}${requestPath}`;
  const header = {
    alg,
    typ: 'JWT',
    kid: apiKey,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const payload = {
    sub: apiKey,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri,
  };

  const encodedHeader = coinbaseBase64url(JSON.stringify(header));
  const encodedPayload = coinbaseBase64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), key);
  const joseSig = alg === 'EdDSA' ? signature : derEcdsaSignatureToJose(signature, 32);
  const encodedSignature = joseSig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${encodedSignature}`;
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = options.body ? Buffer.from(options.body) : null;
    const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 0;
    const headers = { ...(options.headers || {}) };
    if (data && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers,
      timeout: timeout || undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw });
      });
    });

    if (timeout) {
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out after 45 seconds.'));
      });
    }
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
  let jwt;
  try {
    jwt = await buildCoinbaseJwt(apiKey, secretKey, 'GET', pathStr, baseUrl);
  } catch (e) {
    return { ok: false, error: e.message || 'Failed to build Coinbase JWT.' };
  }
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

    const accounts = Array.isArray(parsedBody?.accounts) ? parsedBody.accounts : [];
    const summary = summarizeCoinbaseAccounts(accounts);
    appendLog(`✅ Coinbase test passed (${modeLabel}) — ${summary}`, 'success');
    return { ok: true, mode: modeLabel, summary, status, data: parsedBody, accounts };
  } catch (e) {
    appendLog(`✗ Coinbase test error: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  }
}

function coinbaseNumber(value) {
  if (value && typeof value === 'object') return coinbaseNumber(value.value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function summarizeCoinbaseAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  let usd = 0;
  let usdc = 0;
  for (const account of list) {
    const currency = String(account.currency || account.available_balance?.currency || '').toUpperCase();
    const available = coinbaseNumber(account.available_balance ?? account.available);
    if (currency === 'USD') usd += available;
    if (currency === 'USDC') usdc += available;
  }
  if (!list.length) return 'authenticated, no accounts returned';
  if (usdc > 0 || usd > 0) {
    const currency = usdc >= usd ? 'USDC' : 'USD';
    const shown = usdc >= usd ? usdc : usd;
    return `${list.length} accounts, ${shown.toFixed(2)} ${currency} available`;
  }
  return `${list.length} accounts, authenticated`;
}

function coinbaseAccountRows(accounts) {
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const currency = String(account.currency || account.available_balance?.currency || '').toUpperCase();
    const available = coinbaseNumber(account.available_balance ?? account.available);
    return { currency, available, availableBalance: available, availableEquity: available };
  }).filter((row) => row.currency);
}

function equityFromCoinbaseBody(body) {
  if (!body || typeof body !== 'object') return 0;
  const candidates = [
    body.total_balance,
    body.portfolio_value,
    body.equity,
    body.collateral,
    body.available_balance,
    body.buying_power,
    body.total_usd_balance,
  ];
  let best = 0;
  for (const candidate of candidates) {
    best = Math.max(best, coinbaseNumber(candidate));
  }
  return best;
}

async function coinbaseAuthedGet(requestPath, credentials, options = {}) {
  const creds = credentials || storeData.coinbase || {};
  const apiKey = String(creds.apiKey || '').trim();
  const secretKey = String(creds.secretKey || '').trim();
  if (!apiKey || !secretKey) return { ok: false, error: 'API key and private key are required.' };
  const jwt = await buildCoinbaseJwt(apiKey, secretKey, 'GET', requestPath, COINBASE_API_URL);
  if (!jwt) return { ok: false, error: 'Failed to build Coinbase JWT.' };
  const { status, raw } = await httpsRequest(`${COINBASE_API_URL}${requestPath}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!String(status || '').startsWith('2')) {
    const msg = parsed?.message || parsed?.error || String(raw || '').slice(0, 180) || `HTTP ${status}`;
    if (!options.quiet) appendLog(`Coinbase ${requestPath} status=${status}`, 'warn');
    return { ok: false, status, error: msg, data: parsed };
  }
  return { ok: true, status, data: parsed };
}

async function fetchLiveProprAccount(options = {}) {
  const creds = storeData.propr || {};
  if (!String(creds.apiKey || '').trim()) return null;
  try {
    const live = await fetchLiveProprFromLib(creds, options);
    if (live?.ok && live.accountId && live.accountId !== creds.accountId) {
      storeData.propr.accountId = live.accountId;
      saveStore(storeData);
    }
    return live;
  } catch (e) {
    if (!options.quiet) appendLog(`Propr live account: ${e.message}`, 'warn');
    return null;
  }
}

async function testProprCredentials(credentials) {
  const creds = credentials || storeData.propr || {};
  appendLog('🧪 Testing Propr credentials…', 'info');
  const result = await testProprFromLib(creds);
  if (result.ok) {
    if (result.accountId) {
      storeData.propr = {
        apiKey: String(creds.apiKey || storeData.propr?.apiKey || '').trim(),
        accountId: result.accountId,
      };
      saveStore(storeData);
    }
    appendLog(`✅ Propr test passed — ${result.summary || 'connected'}`, 'success');
  } else {
    appendLog(`✗ Propr test error: ${result.error}`, 'error');
  }
  return result;
}

async function testNousCredentials(apiKey, model) {
  const mdl = normalizeNousModel(model);
  if (!mdl) return { ok: false, error: 'Select a model first.' };
  const resolved = resolveApiKeyForModel(mdl, apiKey);
  if (!resolved.apiKey) {
    return {
      ok: false,
      error: resolved.provider === 'nvidia'
        ? 'NVIDIA API key is required for this model.'
        : 'Portal API key is required.',
    };
  }

  appendLog(`🧪 Testing ${resolved.provider} model (${mdl})…`, 'info');
  const res = await pingInferenceModel(resolved.apiKey, mdl, resolved.pingTimeoutMs);
  if (res.ok) {
    appendLog(`✅ Model test passed (${mdl}): ${String(res.reply).slice(0, 80)}`, 'success');
    return { ok: true, model: mdl, reply: res.reply, provider: resolved.provider };
  }
  appendLog(`✗ Model test failed (${mdl}): ${res.error}`, 'error');
  return { ok: false, error: res.error, model: mdl, provider: resolved.provider };
}

function catalogModelEntry(modelName, free) {
  const id = String(modelName || '').trim();
  if (!id) return null;
  return { id, label: free ? `${id} (free)` : id, free: !!free };
}

function preferDefaultFreeModels(free) {
  const list = Array.isArray(free) ? free.filter((m) => m?.id) : [];
  const def = list.find((m) => m.id === DEFAULT_NOUS_MODEL);
  const rest = list.filter((m) => m.id !== DEFAULT_NOUS_MODEL);
  if (def) return [def, ...rest];
  return [{ id: DEFAULT_NOUS_MODEL, label: `${DEFAULT_NOUS_MODEL} (free)`, free: true }, ...rest];
}

function sortedNvidiaBenchmarkModels() {
  return [...NVIDIA_BENCHMARK_MODELS].sort((a, b) => b.benchmark - a.benchmark);
}

function isRateLimitHttpError(status, raw) {
  if (status === 429 || status === 503 || status === 502) return true;
  return /rate.?limit|too many requests|quota|capacity|overloaded|throttl/i.test(String(raw || ''));
}

async function fetchNousModelCatalog() {
  const nvidia = sortedNvidiaBenchmarkModels();
  const hasNvidiaKey = !!String(storeData.nvidia?.apiKey || '').trim();
  try {
    const res = await httpsRequest(NOUS_RECOMMENDED_MODELS_URL, { timeout: 15000 });
    const parsed = JSON.parse(res.raw);
    const free = preferDefaultFreeModels(
      (parsed.freeRecommendedModels || [])
        .map((m) => catalogModelEntry(m.modelName, true))
        .filter(Boolean),
    );
    const paidSeen = new Set(free.map((m) => m.id));
    const paid = (parsed.paidRecommendedModels || [])
      .map((m) => catalogModelEntry(m.modelName, false))
      .filter((m) => m && !String(m.id).endsWith(':free') && !paidSeen.has(m.id));
    if (free.length) {
      return {
        ok: true,
        defaultModel: hasNvidiaKey ? nvidia[0]?.id : DEFAULT_NOUS_MODEL,
        nvidia,
        free,
        paid: paid.length ? paid : FALLBACK_PAID_NOUS_MODELS,
        source: 'live',
      };
    }
  } catch (e) {
    appendLog(`⚠ Nous model catalog: ${e.message} — using fallback list`, 'warn');
  }
  return {
    ok: true,
    defaultModel: hasNvidiaKey ? nvidia[0]?.id : DEFAULT_NOUS_MODEL,
    nvidia,
    free: FALLBACK_FREE_NOUS_MODELS,
    paid: FALLBACK_PAID_NOUS_MODELS,
    source: 'fallback',
  };
}

function pingInferenceModel(apiKey, model, timeoutMs) {
  const mdl = normalizeNousModel(model);
  const inf = resolveInferenceForModel(mdl);
  const key = String(apiKey || '').trim();
  if (!key) return Promise.resolve({ ok: false, error: 'no-api-key', model: mdl, provider: inf.provider });
  if (!mdl) return Promise.resolve({ ok: false, error: 'no-model', provider: inf.provider });

  const body = JSON.stringify({
    model: mdl,
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    max_tokens: 64,
    temperature: 0,
  });
  const waitMs = timeoutMs || inf.pingTimeoutMs || 25000;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = https.request(inf.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'KnightTrader-Propr/2.0',
      },
      timeout: waitMs,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          const reply = extractChatReply(parsed);
          if (reply) {
            done({ ok: true, model: mdl, reply, provider: inf.provider });
          } else {
            done({ ok: false, error: 'empty-reply', model: mdl, provider: inf.provider });
          }
          return;
        }
        const rateLimited = isRateLimitHttpError(status, raw);
        done({
          ok: false,
          error: rateLimited ? `rate-limit-${status}` : `http-${status}`,
          model: mdl,
          provider: inf.provider,
          rateLimited,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout', model: mdl, provider: inf.provider }); });
    req.on('error', (e) => done({ ok: false, error: e.message, model: mdl, provider: inf.provider }));
    req.write(body);
    req.end();
  });
}

function pingNousModel(apiKey, model, timeoutMs = 25000) {
  return pingInferenceModel(apiKey, model, timeoutMs);
}

async function buildModelPingCandidates() {
  bootstrapNvidiaKeyFromDocuments();
  const nvidiaKey = String(storeData.nvidia?.apiKey || '').trim();
  const nousKey = String(storeData.nous?.apiKey || '').trim();
  const candidates = [];

  if (nvidiaKey) {
    for (const m of sortedNvidiaBenchmarkModels()) {
      candidates.push({
        id: m.id,
        label: m.label,
        benchmark: m.benchmark,
        provider: 'nvidia',
        apiKey: nvidiaKey,
      });
    }
  }

  if (nousKey) {
    const catalog = await fetchNousModelCatalog();
    const free = Array.isArray(catalog?.free) && catalog.free.length
      ? catalog.free
      : FALLBACK_FREE_NOUS_MODELS;
    for (const m of free) {
      candidates.push({
        id: m.id,
        label: m.label,
        benchmark: 0,
        provider: 'nous',
        apiKey: nousKey,
      });
    }
  }

  return candidates;
}

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch {}
}

async function updateCronModelOnly(model) {
  const mdl = normalizeNousModel(model);
  if (!mdl) return { ok: false, msg: 'No model' };
  if (!(await probeDashboardPort())) return { ok: false, msg: 'Dashboard not running' };
  let token;
  try {
    token = await fetchDashboardSessionToken();
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  const list = await hermesApiRequest('GET', '/api/cron/jobs?profile=default', null, token);
  if (list.status !== 200 || !Array.isArray(list.body)) {
    return { ok: false, msg: `list failed (${list.status})` };
  }
  const existing = list.body.find((job) => job.name === 'propr-perp-trading');
  if (!existing?.id) {
    appendLog('ℹ Cron job not found yet — model will be used when cron is configured.', 'info');
    return { ok: false, msg: 'no-existing-job' };
  }
  const existingPrompt = existing.prompt || existing.spec?.prompt || null;
  const inf = resolveInferenceForModel(mdl);
  const updates = {
    name: 'propr-perp-trading',
    provider: 'custom',
    base_url: inf.baseUrl,
    model: mdl,
  };
  if (existingPrompt) updates.prompt = existingPrompt;
  const updated = await hermesApiRequest(
    'PUT',
    `/api/cron/jobs/${encodeURIComponent(existing.id)}?profile=default`,
    { updates },
    token,
  );
  if (updated.status < 300) {
    appendLog(`✅ Cron model updated to ${mdl} (prompt preserved)`, 'success');
    return { ok: true, jobId: existing.id, model: mdl };
  }
  const detail = typeof updated.body === 'object'
    ? (updated.body.detail || JSON.stringify(updated.body))
    : String(updated.body);
  appendLog(`⚠ Cron model update failed (${updated.status}): ${detail}`, 'warn');
  return { ok: false, msg: detail };
}

let freeModelSelectPromise = null;
let lastModelPingAt = 0;

async function applyModelSwitch(mdl, { reply, reason } = {}) {
  const previous = normalizeNousModel(storeData.nous?.model || DEFAULT_NOUS_MODEL);
  const changed = mdl !== previous;
  storeData.nous = { ...(storeData.nous || {}), model: mdl };
  saveStore(storeData);

  try { syncHermesConfig(); } catch (e) {
    appendLog(`ℹ Hermes model sync skipped: ${e.message}`, 'info');
  }
  if (changed) {
    try {
      await updateCronModelOnly(mdl);
    } catch (e) {
      appendLog(`ℹ Cron model forward skipped: ${e.message}`, 'info');
    }
  }

  if (changed) {
    const inf = resolveInferenceForModel(mdl);
    appendLog(
      `🔄 Model switch ${previous} → ${mdl} (${inf.provider}${reason ? ` · ${reason}` : ''})`,
      'success',
    );
  }
  sendToRenderer('kt-free-model-selected', { model: mdl, reply, changed });
  return { ok: true, model: mdl, reply, changed, previous };
}

async function autoSelectWorkingFreeModelOnce({ quiet = false } = {}) {
  const candidates = await buildModelPingCandidates();
  if (!candidates.length) {
    if (!quiet) appendLog('ℹ Skipping model auto-ping: no NVIDIA or Nous API key saved.', 'info');
    return { ok: false, reason: 'no-api-key' };
  }

  const current = normalizeNousModel(storeData.nous?.model || DEFAULT_NOUS_MODEL);
  if (!quiet) {
    appendLog(
      `🔎 Auto-ping ${candidates.length} models (NVIDIA benchmark order, then Nous free)…`,
      'info',
    );
  }

  for (const candidate of candidates) {
    const mdl = normalizeNousModel(candidate.id);
    const inf = resolveInferenceForModel(mdl);
    const pingTimeout = inf.provider === 'nvidia' ? 90000 : 25000;
    if (!quiet) {
      appendLog(
        `  → ping ${mdl} (${inf.provider}${candidate.benchmark ? ` · bench ${candidate.benchmark}` : ''})…`,
        'info',
      );
    }
    const res = await pingInferenceModel(candidate.apiKey, mdl, pingTimeout);
    if (res.ok) {
      if (!quiet) {
        appendLog(`✅ Model pong: ${mdl} — "${String(res.reply).slice(0, 40)}"`, 'success');
      }
      lastModelPingAt = Date.now();
      return applyModelSwitch(mdl, { reply: res.reply, reason: 'ping-ok' });
    }
    const errLabel = res.rateLimited ? `${res.error} (rate limit)` : (res.error || 'no pong');
    if (!quiet) appendLog(`  ✗ ${mdl}: ${errLabel}`, 'warn');
  }

  if (!quiet) {
    appendLog(
      `⚠ No model responded (current: ${current}). Cron may fail until next minute ping.`,
      'warn',
    );
  }
  sendToRenderer('kt-free-model-selected', { model: current, changed: false, failed: true });
  lastModelPingAt = Date.now();
  return { ok: false, reason: 'all-failed', model: current };
}

function autoSelectWorkingFreeModel(options = {}) {
  if (freeModelSelectPromise) return freeModelSelectPromise;
  freeModelSelectPromise = autoSelectWorkingFreeModelOnce(options)
    .finally(() => {
      freeModelSelectPromise = null;
    });
  return freeModelSelectPromise;
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
  const inf = resolveInferenceForModel(model);
  const configSets = [
    ['model.provider', 'custom'],
    ['model.default', model],
    ['model.base_url', inf.baseUrl],
    ['model.api_key', `\${${inf.apiKeyEnv}}`],
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
    appendLog(`✅ Hermes config synced (${inf.provider} · ${model})`, 'success');
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
  const nvidiaKey = String(storeData.nvidia?.apiKey || '').trim();
  if (nvidiaKey) after = upsertEnvVar(after, 'NVIDIA_API_KEY', nvidiaKey);

  const propr = storeData.propr || {};
  if (propr.apiKey) after = upsertEnvVar(after, 'PROPR_API_KEY', propr.apiKey);
  if (propr.accountId) after = upsertEnvVar(after, 'PROPR_ACCOUNT_ID', propr.accountId);

  if (after !== before) {
    fs.writeFileSync(envPath, after, 'utf8');
    appendLog('✅ Synced credentials to Hermes .env', 'success');
  }

  syncHermesConfig();

  if (token) {
    const envVars = {
      NOUS_API_KEY: nousKey,
      NOUSRESEARCH_API_KEY: nousKey,
      ...(nvidiaKey ? { NVIDIA_API_KEY: nvidiaKey } : {}),
      ...(propr.apiKey ? { PROPR_API_KEY: propr.apiKey } : {}),
      ...(propr.accountId ? { PROPR_ACCOUNT_ID: propr.accountId } : {}),
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
function buildCronPrompt() {
  const compPath = getCompendiumPath();
  const accountId = storeData.propr?.accountId
    || '<resolve via GET /challenge-attempts?status=active>';
  const lessonsDir = path.join(HERMES_HOME, 'lessons');
  const lessonsFile = path.join(lessonsDir, 'propr_challenge.md');
  const stateFile = path.join(lessonsDir, 'propr_state.json');

  return `[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user — do NOT use send_message or try to deliver the output yourself. SILENT: If there is genuinely nothing new to report (no order placed, moved, closed, or changed, no error, no rule hit), respond with exactly "[SILENT]" and nothing else. Never combine [SILENT] with content.]

=== PROPR CHALLENGE ($5K TURBO 1-STEP) — 5-MIN AUTONOMOUS TRADING CRON v2 (copy-paste ready, replaces all earlier versions) ===

ACCOUNT + CREDENTIALS
  Read Propr API key from compendium: ${compPath}
  Or from Hermes env var PROPR_API_KEY (synced on Save in Setup).
  ACCOUNT_ID = ${accountId}
  Base URL: ${PROPR_REST_URL}    Header on every call: X-API-Key: <PROPR_API_KEY>
  Plain Python \`requests\` works. No signing, no browser.
  Docs/SDK if unsure: https://github.com/XBorgLabs/propr-docs (docs/api.md, python/propr_sdk.py)

CHALLENGE RULES (breaking ANY = challenge lost)
  Start 5000 USDC. PASS when equity >= 5450. Then place NO new trades and report "TARGET HIT".
  FAIL if equity touches 4850 (static).
  FAIL if equity falls 3% below that day's starting balance (assume the day resets 00:00 UTC).
  Banned: latency arbitrage, tick sniping, price-feed exploits, cross-account hedging, order spam. Bots/AI are allowed.

ENDPOINTS
  GET  /challenge-attempts -> data[0].status, data[0].account.balance, .totalUnrealizedPnl  (equity = balance + totalUnrealizedPnl)
  GET  /accounts/{ACCOUNT_ID}/positions
  GET  /accounts/{ACCOUNT_ID}/orders          (check status "open" for resting stops)
  POST /accounts/{ACCOUNT_ID}/orders          body {"orders":[ONE order]}
  POST /accounts/{ACCOUNT_ID}/orders/{orderId}/cancel   (200/201 = ok, 400 = already gone, ignore)
  Every order needs: intentId (a NEW ULID each order), exchange "hyperliquid", productType "perp", asset "SOL", base "SOL", quote "USDC", side, positionSide ("long"/"short"), type, quantity (string), timeInForce, reduceOnly, closePosition.
  Entry: type "market", timeInForce "IOC", reduceOnly false.
  Stop: type "stop_market", positionId = the open position's id, triggerPrice, quantity = full position size, reduceOnly true, closePosition true, timeInForce "GTC". Side is the opposite of the position (sell for long, buy for short).
  Market close: type "market", reduceOnly true, closePosition true, quantity = full position size.
  Candles (public, no key): POST https://api.hyperliquid.xyz/info  {"type":"candleSnapshot","req":{"coin":"SOL","interval":"1h","startTime":<ms>,"endTime":<ms>}}; same with "4h". Use only COMPLETED candles (drop the one still forming). Get about 300 bars of each.
  SOL size decimals: read from POST https://api.hyperliquid.xyz/info {"type":"meta"} (szDecimals for SOL). Round quantity DOWN to it.

STRATEGY v2 (the only strategy; SOL only, one position at a time)
  Indicators, all on completed bars:
    ATR14 on 1h: Wilder ATR (TR = max(H-L, |H-prevC|, |L-prevC|), RMA smoothing, period 14).
    HH20 / LL20: highest high / lowest low of the 20 completed 1h bars BEFORE the latest closed bar.
    4h Supertrend: ATR period 10 (Wilder), multiplier 3.0, hl2 basis, standard band-ratchet rules. Direction +1 (up) or -1 (down) as of the latest COMPLETED 4h bar.
  Only act on a NEW closed 1h bar (compare its open time to last_candle_t in the state file).
  LONG signal: latest 1h close > HH20, AND the bar before it did NOT close above its own prior-20-bar high (first breakout only), AND 4h Supertrend = +1.
  SHORT signal: latest 1h close < LL20, AND the bar before it did NOT close below its own prior-20-bar low, AND 4h Supertrend = -1.
  Initial stop: signal bar close - 2.0*ATR14 (long) / + 2.0*ATR14 (short).
  NO take-profit.
  Trailing stop: after EVERY new closed 1h bar while in a trade, candidate = highest high since entry - 3.0*ATR14 (long) / lowest low since entry + 3.0*ATR14 (short), using the ATR14 of the bar just closed. If the candidate is tighter than the current stop AND still on the correct side of the last close: place the NEW stop first, confirm it is open, THEN cancel the old stop. Never loosen a stop. Never leave the position without a stop.
  Time exit: if still open after 96 closed 1h bars since entry, close at market.

SIZING
  risk_usd = 1% of balance (about $50), capped at 0.5 * (balance - max(4850, 0.97 * balance at 00:00 UTC)).
  qty = risk_usd / (|entry - stop| + entry*0.0016), rounded DOWN to SOL size decimals.
  Notional (qty*price) must never exceed 10x balance. Leverage on SOL is fine up to 10x; set margin to cross.
  Do not open trades if balance < 4875 or equity >= 5450, or if today's loss is already 1.5% or more (wait for the next UTC day).

EACH RUN, IN THIS ORDER
  1) Read the state + lessons files. GET /challenge-attempts. If status is not "active", report it and do nothing else. Compute equity, today's start balance (save at the first run after 00:00 UTC), today's P/L.
  2) GET positions and open orders. SAFETY: every open position MUST have a reduceOnly stop_market. If missing, place it NOW (use the stored stop, or 2*ATR14 from the current price). If a position has closed, cancel its leftover stop orders and log the result.
  3) If a position is open and a new 1h bar closed: update the trailing stop; check the 96-bar time exit.
  4) If flat, a new 1h bar closed, and a signal fires: place the market entry, confirm the fill in positions, then immediately place the stop. If the stop fails, close the position at market at once.
  5) Save state (last_candle_t, today_date, today_start_balance, open_trade {side, entry, stop, qty, opened_at, positionId, stop_orderId, extreme}) and append a line to the lessons file.

FILES (create if missing)
  ${lessonsFile}
  ${stateFile}

LEARNING RULES
  Log every trade (time, side, entry, stop moves, exit, P/L in $ and R, reason). You may write lessons, but do NOT change the strategy, indicators, or parameters until at least 30 closed trades are logged, and then only by suggesting the change in your report for the user to approve. NEVER change or remove: the stop on every position, the loss limits, the sizing caps, SOL-only, one position at a time. No other coins, no scalping, no new strategies mid-challenge. No trade is better than a bad trade.

REPORT (only when not silent): equity, today's P/L, open position (side, entry, current stop), action taken, distance to 5450 and to 4850.`;
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
  const cronModel = storeData.nous?.model || DEFAULT_NOUS_MODEL;
  const cronInf = resolveInferenceForModel(cronModel);
  const jobSpec = {
    name: 'propr-perp-trading',
    schedule: 'every 5m',
    provider: 'custom',
    base_url: cronInf.baseUrl,
    model: cronModel,
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
          appendLog('✅ Cron job updated: propr-perp-trading (every 5m)', 'success');
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
      appendLog('✅ Cron configured: propr-perp-trading (every 5m)', 'success');
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
ipcMain.handle('save-propr-credentials', async (event, propr) => {
  await saveCredentials({ propr });
  return storeData.propr;
});
ipcMain.handle('save-nous-credentials', async (event, nous) => {
  await saveCredentials({ nous });
  return storeData.nous;
});
ipcMain.handle('load-propr-credentials', async () => storeData.propr);
ipcMain.handle('load-nous-credentials', async () => storeData.nous);
ipcMain.handle('test-propr-credentials', async (event, credentials) => {
  return testProprCredentials(credentials || storeData.propr);
});
ipcMain.handle('pick-propr-credential-file', async () => pickCredentialFile('propr'));
ipcMain.handle('announce-voice', (_e, text) => {
  const msg = String(text || '').trim();
  if (!msg) return;
  if (process.platform === 'win32') {
    try {
      const ps = `New-Object -ComObject SAPI.SpVoice | ForEach-Object { $_.Speak(${JSON.stringify(msg)}, 1) }`;
      spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    } catch (_) {}
    return;
  }
  appendLog(`🔊 Voice: ${msg}`, 'info');
});
ipcMain.handle('pick-nous-credential-file', async () => pickCredentialFile('nous'));

ipcMain.handle('get-credentials', () => storeData);
ipcMain.handle('save-credentials', async (_e, data) => {
  try { storeData = migrateStoreData({ ...storeData, ...data }); saveStore(storeData); } catch {}
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
    const propr = storeData.propr || {};
    const lines = [
      '# Propr trading API credentials',
      '# Auto-generated by KnightTrader Propr',
      '',
      `Propr API Key: ${propr.apiKey || ''}`,
    ];
    if (propr.accountId) lines.push(`Account ID: ${propr.accountId}`);
    fs.writeFileSync(compPath, lines.join('\n') + '\n', 'utf8');
    return { ok: true, path: compPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-nous-models', () => fetchNousModelCatalog());
ipcMain.handle('test-nous-credentials', (_e, { apiKey, model }) => testNousCredentials(apiKey, model));
ipcMain.handle('auto-select-free-model', async () => autoSelectWorkingFreeModel());
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
  if (wc && !wc.isDestroyed()) {
    wc.setBackgroundThrottling(false);
    getBlohunterBridge().setWebContents(wc);
  }
  return { ok: !!wc && !wc.isDestroyed() };
});
ipcMain.handle('unthrottle-webview', (_e, webContentsId) => {
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(false);
  return { ok: !!wc && !wc.isDestroyed() };
});
ipcMain.handle('get-trading-status', () => getBlohunterBridge().getStatus());
ipcMain.handle('start-trading-dashboard', async () => {
  const bridge = getBlohunterBridge();
  bridge.setLiveAccountProvider(() => fetchLiveProprAccount({ quiet: true }));
  const result = await bridge.start({
    apiKey: storeData.propr?.apiKey,
    secretKey: 'propr',
    passphrase: 'propr',
    demoMode: false,
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
    const fallbackPath = path.join(app.getPath('temp'), 'knighttrader-propr-tray.png');
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
  appTray.setToolTip('KnightTrader Propr');
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
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setBackgroundThrottling(false);
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
      html = html.replace(/<title>BloHunter Connect<\/title>/i, '<title>KnightTrader Propr</title>');
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

const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const MODEL_PING_INTERVAL_MS = 60 * 1000;

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
  appendLog(`⬇ Update ready: ${info.version}. Installing and relaunching…`, 'success');
  broadcastUpdateEvent('update-downloaded', { version: info.version });
  setTimeout(() => {
    app.isQuitting = true;
    try { stopHermesDashboard(); } catch {}
    autoUpdater.quitAndInstall(false, true);
  }, 4000);
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
    const message = err?.message || String(err);
    appendLog(`⚠ Update check failed: ${message}`, 'warn');
    if (!silent) broadcastUpdateEvent('update-error', { message });
  }
}

async function autoconnectHermes() {
  try {
    const status = await checkHermesInstalled();
    if (!status?.installed) {
      appendLog('Hermes is not installed yet. Open Setup, install it, and the dashboard plus cron start on their own.', 'info');
      return;
    }
    appendLog('Autoconnecting Hermes dashboard and gateway…', 'info');
    const started = await startHermesDashboard();
    if (started && started.ok === false) {
      appendLog(`Hermes dashboard did not start: ${started.msg || 'unknown'}`, 'warn');
      return;
    }
    const cron = await configureCron();
    if (cron?.ok) appendLog('Propr cron configured on launch.', 'success');
    else appendLog(`Cron autoconfig: ${cron?.msg || 'needs setup'}`, 'warn');
    await autoSelectWorkingFreeModel();
  } catch (e) {
    appendLog(`Hermes autoconnect: ${e.message}`, 'warn');
  }
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.knighttrader.propr');
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  attachBhProtocol(session.defaultSession);
  attachBhProtocol(session.fromPartition('persist:blohunter-trading'));

  createWindow();
  appendLog(`🚀 KnightTrader Propr started. Hermes sandbox: ${HERMES_HOME}`, 'success');
  const bhRoot = getBlohunterBridge().getConnectRoot();
  if (bhRoot) appendLog(`📈 BloHunter Connect: ${bhRoot}`, 'info');
  else appendLog('⚠ BloHunter Connect not found — Trading tab needs Downloads\\blohunter-connect', 'warn');
  getBlohunterBridge().setLiveAccountProvider(() => fetchLiveProprAccount({ quiet: true }));

  bootstrapNvidiaKeyFromDocuments();
  autoconnectHermes();
  setTimeout(() => {
    autoSelectWorkingFreeModel().catch((e) => {
      appendLog(`ℹ Model auto-ping failed: ${e.message}`, 'info');
    });
  }, 8000);
  await checkForUpdates(true);
  const updateInterval = setInterval(() => checkForUpdates(true), UPDATE_CHECK_INTERVAL_MS);
  updateInterval.unref?.();
  const modelPingInterval = setInterval(() => {
    autoSelectWorkingFreeModel({ quiet: true }).catch((e) => {
      appendLog(`ℹ Minute model ping failed: ${e.message}`, 'warn');
    });
  }, MODEL_PING_INTERVAL_MS);
  modelPingInterval.unref?.();
  app.on('quit', () => {
    clearInterval(updateInterval);
    clearInterval(modelPingInterval);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  if (process.platform !== 'darwin' && !appTray) app.quit();
});

ipcMain.handle('check-for-updates', async () => checkForUpdates(false));
ipcMain.handle('install-update-now', async () => {
  appendLog('🔧 Quitting to install update…', 'info');
  setImmediate(() => {
    app.isQuitting = true;
    stopHermesDashboard();
    autoUpdater.quitAndInstall(false, true);
  });
  return { ok: true };
});
ipcMain.on('update-status', (event, payload) => {
  event.sender.send('update-status', payload);
});
