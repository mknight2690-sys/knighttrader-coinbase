const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('function coinbaseBase64url');
const end = source.indexOf('function httpsRequest');
assert.ok(start > 0 && end > start, 'jwt helpers not found');

const context = {
  crypto,
  Buffer,
  console,
  module: { exports: {} },
  exports: {},
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nthis.__jwt = { coinbaseBase64url, importCoinbaseSecret, buildCoinbaseJwt, derEcdsaSignatureToJose };`, context);

const { buildCoinbaseJwt } = context.__jwt;

function decodePart(part) {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

(async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = await buildCoinbaseJwt('organizations/test/apiKeys/test', pem, 'GET', '/api/v3/brokerage/accounts', 'https://api.coinbase.com');
  const [h, p, sig] = token.split('.');
  const header = decodePart(h);
  const payload = decodePart(p);
  assert.strictEqual(header.alg, 'ES256');
  assert.strictEqual(header.typ, 'JWT');
  assert.ok(header.nonce && header.nonce.length >= 16);
  assert.strictEqual(payload.iss, 'cdp');
  assert.strictEqual(payload.uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');
  const rawSig = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.strictEqual(rawSig.length, 64, `ES256 signature should be raw R||S, got ${rawSig.length}`);

  const ed = crypto.generateKeyPairSync('ed25519');
  const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const edToken = await buildCoinbaseJwt('organizations/test/apiKeys/ed', edPem, 'GET', '/api/v3/brokerage/accounts', 'https://api.coinbase.com');
  const edHeader = decodePart(edToken.split('.')[0]);
  assert.strictEqual(edHeader.alg, 'EdDSA');
  assert.ok(edHeader.nonce);
  console.log('coinbase jwt shape ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
