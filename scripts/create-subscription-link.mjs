import { readFileSync, writeFileSync } from 'node:fs';

const SUCCESS_URL =
  'https://mknight2690-sys.github.io/knighttrader-coinbase-site/?purchase=success&utm_source=stripe';
const PRODUCT_NAME = 'KnightTrader Propr';
const PRICE_CENTS = 4700;
const METADATA_KEY = 'kt_product';
const METADATA_VAL = 'knighttrader-propr-47-mo';

function loadSecretKey(keyFile) {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  if (keyFile) return readFileSync(keyFile, 'utf8').trim();
  console.error('Set STRIPE_SECRET_KEY or pass a key file path.');
  process.exit(1);
}

async function stripe(secretKey, path, method = 'GET', body = null) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Stripe API ${path}: ${msg}`);
  }
  return json;
}

async function findOrCreateProduct(secretKey) {
  const list = await stripe(secretKey, '/products?limit=100&active=true');
  const existing = (list.data || []).find(
    (p) => p.metadata?.[METADATA_KEY] === METADATA_VAL || p.name === PRODUCT_NAME
  );
  if (existing) return existing;
  return stripe(secretKey, '/products', 'POST', {
    name: PRODUCT_NAME,
    description: 'Desktop app for Propr challenge auto-trading on Hyperliquid perps. Updates and continued all-in-one Hermes agent access. $47 per month.',
    [`metadata[${METADATA_KEY}]`]: METADATA_VAL,
  });
}

async function findOrCreatePrice(secretKey, productId) {
  const list = await stripe(secretKey, `/prices?product=${productId}&active=true&limit=20`);
  const existing = (list.data || []).find(
    (p) => p.unit_amount === PRICE_CENTS && p.currency === 'usd' && p.recurring?.interval === 'month'
  );
  if (existing) return existing;
  return stripe(secretKey, '/prices', 'POST', {
    product: productId,
    unit_amount: String(PRICE_CENTS),
    currency: 'usd',
    'recurring[interval]': 'month',
  });
}

async function createPaymentLink(secretKey, priceId) {
  return stripe(secretKey, '/payment_links', 'POST', {
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'after_completion[type]': 'redirect',
    'after_completion[redirect][url]': SUCCESS_URL,
    allow_promotion_codes: 'true',
  });
}

const keyFile = process.argv[2];
const outFile = process.argv[3];
const secretKey = loadSecretKey(keyFile);
const product = await findOrCreateProduct(secretKey);
const price = await findOrCreatePrice(secretKey, product.id);
const link = await createPaymentLink(secretKey, price.id);
if (outFile) writeFileSync(outFile, `${link.url}\n`, 'utf8');
console.log(link.url);
