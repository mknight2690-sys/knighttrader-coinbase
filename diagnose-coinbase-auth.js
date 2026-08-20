const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const API_KEY = 'organizations/704a0e43-9134-4e0f-ba52-db0f706ce340/apiKeys/606dffc2-9b67-44f1-acb3-61ee1d1fd187';
const SECRET_B64 = 'u6DRGN3Zoc1b6FgT8yfXJc3HOdkpHds4reGbLYXAxXGPZGAA8N/HCQqi53ZjAjipN2H09oBEwovEP6zujVDu7A==';
const URL = 'https://api.coinbase.com/api/v3/brokerage/accounts';

function info(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

const secretBytes = Buffer.from(SECRET_B64, 'base64');
info('Secret format', {
  base64Length: SECRET_B64.length,
  decodedLength: secretBytes.length,
  firstBytes: Array.from(secretBytes.slice(0, 8)),
  lastBytes: Array.from(secretBytes.slice(-8)),
});

let jose;
try {
  jose = require('jose');
  info('jose module', { loaded: true, version: require('jose/package.json').version });
} catch (e) {
  info('jose module', { loaded: false, error: e.message });
}

async function tryJoseEs256() {
  if (!jose) throw new Error('jose not loaded');
  const key = await jose.importECPrivateKey(secretBytes, { namedCurve: 'P-256' });
  const jwt = await new jose.SignJWT({
    sub: API_KEY,
    iss: 'cdp',
    aud: 'https://api.coinbase.com',
    exp: Math.floor(Date.now() / 1000) + 120,
    nbf: Math.floor(Date.now() / 1000),
    uri: `GET api.coinbase.com/api/v3/brokerage/accounts`,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: API_KEY, nonce: crypto.randomBytes(16).toString('hex') })
    .sign(key);
  return jwt;
}

async function tryJoseEdDsa() {
  if (!jose) throw new Error('jose not loaded');
  const importer = jose.importOKPPrivateKey || jose.importPKCS8;
  let key;
  try {
    key = await importer(secretBytes, 'Ed25519');
  } catch (e) {
    key = await jose.importPKCS8(secretBytes, 'EdDSA');
  }
  const jwt = await new jose.SignJWT({
    sub: API_KEY,
    iss: 'cdp',
    aud: 'https://api.coinbase.com',
    exp: Math.floor(Date.now() / 1000) + 120,
    nbf: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: API_KEY, nonce: crypto.randomBytes(16).toString('hex') })
    .sign(key);
  return jwt;
}

async function tryHmac() {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}GET/api/v3/brokerage/accounts`;
  const signature = crypto.createHmac('sha256', secretBytes).update(message).digest('base64');
  return { timestamp, signature };
}

function sendRequest(headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(URL);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  const results = { es256: null, eddsa: null, hmac: null, request: null };

  try {
    results.es256 = { jwt: await tryJoseEs256() };
  } catch (e) {
    results.es256 = { error: `${e.code}:${e.message}` };
  }

  try {
    results.eddsa = { jwt: await tryJoseEdDsa() };
  } catch (e) {
    results.eddsa = { error: `${e.code}:${e.message}` };
  }

  try {
    results.hmac = await tryHmac();
  } catch (e) {
    results.hmac = { error: e.message };
  }

  info('Auth attempts', results);

  for (const attempt of ['eddsa', 'es256', 'hmac']) {
    const a = results[attempt];
    if (!a) continue;
    try {
      let headers;
      if (attempt === 'hmac') {
        headers = {
          'CB-ACCESS-KEY': API_KEY,
          'CB-ACCESS-SIGN': a.signature,
          'CB-ACCESS-TIMESTAMP': a.timestamp,
          'Content-Type': 'application/json',
        };
      } else if (a.jwt) {
        headers = { Authorization: `Bearer ${a.jwt}` };
      } else {
        continue;
      }
      const res = await sendRequest(headers);
      info(`${attempt} request result`, { headers, response: res });
      if (res.status === 200) {
        fs.writeFileSync('C:/Users/mknig/Desktop/KnightTrader-Coinbase/diagnose-success.json', JSON.stringify({ attempt, response: res }, null, 2));
        console.log('\n✅ SUCCESS with', attempt);
        process.exit(0);
      }
    } catch (e) {
      info(`${attempt} request error`, { error: e.message });
    }
  }

  fs.writeFileSync('C:/Users/mknig/Desktop/KnightTrader-Coinbase/diagnose-results.json', JSON.stringify(results, null, 2));
  console.log('\n❌ No auth method succeeded. Results saved to diagnose-results.json');
})();
