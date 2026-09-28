const https = require('https');

const PROPR_API_URL = 'https://api.propr.xyz/v1';

function proprNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function proprRequest(apiKey, requestPath, { method = 'GET', body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(`${PROPR_API_URL}${requestPath}`, {
      method,
      headers: {
        'X-API-Key': String(apiKey || '').trim(),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, raw, data: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Propr request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function resolveProprAccount(apiKey, cachedAccountId = '') {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'Propr API key is required.' };
  if (cachedAccountId) return { ok: true, accountId: cachedAccountId };

  const attempts = await proprRequest(key, '/challenge-attempts?status=active&limit=5');
  if (!String(attempts.status || '').startsWith('2')) {
    const msg = attempts.data?.message || attempts.data?.error || `HTTP ${attempts.status}`;
    return { ok: false, error: msg, status: attempts.status };
  }
  const rows = Array.isArray(attempts.data?.data) ? attempts.data.data : [];
  const active = rows.find((row) => row?.accountId || row?.account?.accountId);
  const accountId = String(active?.accountId || active?.account?.accountId || '').trim();
  if (!accountId) {
    return { ok: false, error: 'No active Propr challenge account found. Purchase a challenge at app.propr.xyz first.' };
  }
  return { ok: true, accountId, attempt: active };
}

function encodeAccountPath(accountId, suffix) {
  return `/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

function mapProprOpenPositions(rawPositions = []) {
  return rawPositions
    .filter((p) => proprNumber(p?.quantity) > 0)
    .map((position) => {
      const side = String(position.positionSide || position.side || 'long').toLowerCase();
      const asset = String(position.asset || position.base || '').trim();
      const symbol = asset.replace(/^xyz:/, '');
      const contract = asset.includes('/') ? asset : `${asset}-USDC`;
      return {
        contract,
        symbol,
        pair: contract,
        side: side.includes('short') ? 'short' : 'long',
        leverage: proprNumber(position.leverage),
        marginMode: position.marginMode || 'cross',
        pnlUsd: proprNumber(position.unrealizedPnl),
        pnlPct: proprNumber(position.returnOnEquity) * 100,
        margin: proprNumber(position.marginUsed),
        amount: proprNumber(position.quantity),
        avgPrice: proprNumber(position.entryPrice),
        liqPrice: proprNumber(position.liquidationPrice),
        markPrice: proprNumber(position.markPrice),
        manualPosition: false,
        source: 'direct-propr-rest',
      };
    });
}

function mapProprClosedPositions(rawPositions = []) {
  return rawPositions
    .filter((p) => String(p?.status || '').toLowerCase() === 'closed' || proprNumber(p?.quantity) === 0)
    .map((record) => {
      const side = String(record.positionSide || record.side || 'long').toLowerCase();
      const asset = String(record.asset || record.base || '').trim();
      const symbol = asset.replace(/^xyz:/, '');
      const contract = asset.includes('/') ? asset : `${asset}-USDC`;
      const closedAt = Date.parse(record.closedAt || record.updatedAt || '') || Date.now();
      const entryPrice = proprNumber(record.entryPrice);
      const exitPrice = proprNumber(record.markPrice || record.breakEvenPrice);
      return {
        symbol,
        contract,
        pair: contract,
        side: side.includes('short') ? 'short' : 'long',
        positionKey: `${symbol}:${side.includes('short') ? 'short' : 'long'}`,
        leverage: proprNumber(record.leverage),
        closeReason: String(record.status || 'closed'),
        manualPosition: false,
        pnlUsd: proprNumber(record.realizedPnl),
        pnlPct: proprNumber(record.returnOnEquity) * 100,
        amount: proprNumber(record.quantity),
        entryPrice,
        exitPrice,
        closedAt,
        source: 'direct-propr-rest',
        sourceConfidence: entryPrice > 0 ? 'high' : 'history-only',
        liquidationDetected: String(record.status || '').toLowerCase() === 'liquidated',
      };
    })
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 50);
}

async function fetchLiveProprAccount(credentials, options = {}) {
  const apiKey = String(credentials?.apiKey || '').trim();
  const cachedAccountId = String(credentials?.accountId || '').trim();
  if (!apiKey) return null;

  try {
    const accountRes = await resolveProprAccount(apiKey, cachedAccountId);
    if (!accountRes.ok) return { ok: false, error: accountRes.error };
    const accountId = accountRes.accountId;

    const accountGet = await proprRequest(apiKey, encodeAccountPath(accountId, ''));
    const account = (String(accountGet.status || '').startsWith('2') && accountGet.data && typeof accountGet.data === 'object')
      ? accountGet.data
      : (accountRes.attempt?.account || {});
    const balance = proprNumber(account.balance || account.marginBalance || account.crossWalletBalance);
    const available = proprNumber(account.availableBalance || account.maxWithdrawAmount || balance);
    const unrealized = proprNumber(account.totalUnrealizedPnl || account.crossUnrealizedPnl);
    const equity = balance > 0 ? balance : available;

    const [openRes, closedRes, tradesRes] = await Promise.all([
      proprRequest(apiKey, `${encodeAccountPath(accountId, '/positions')}?status=open&limit=50`),
      proprRequest(apiKey, `${encodeAccountPath(accountId, '/positions')}?status=closed&limit=50`),
      proprRequest(apiKey, `${encodeAccountPath(accountId, '/trades')}?limit=50`),
    ]);

    const rawOpen = String(openRes.status || '').startsWith('2') && Array.isArray(openRes.data?.data) ? openRes.data.data : [];
    const rawClosed = String(closedRes.status || '').startsWith('2') && Array.isArray(closedRes.data?.data) ? closedRes.data.data : [];
    if (String(tradesRes.status || '').startsWith('2') && Array.isArray(tradesRes.data?.data) && !rawClosed.length) {
      // Fall back to close-type trades when closed positions list is empty.
      for (const trade of tradesRes.data.data) {
        if (String(trade.type || '').toLowerCase() === 'close' || String(trade.type || '').toLowerCase() === 'liquidation') {
          rawClosed.push({
            asset: trade.asset,
            base: trade.base,
            quote: trade.quote,
            positionSide: trade.positionSide,
            status: trade.isLiquidation ? 'liquidated' : 'closed',
            quantity: trade.quantity,
            entryPrice: trade.price,
            markPrice: trade.price,
            realizedPnl: trade.realizedPnl,
            leverage: trade.leverage,
            closedAt: trade.executedAt,
            updatedAt: trade.executedAt,
          });
        }
      }
    }

    const openPositions = mapProprOpenPositions(rawOpen);
    const closedPositions = mapProprClosedPositions(rawClosed);
    const totalMargin = openPositions.reduce((sum, p) => sum + proprNumber(p.margin), 0);
    const totalUnrealized = openPositions.reduce((sum, p) => sum + proprNumber(p.pnlUsd), 0);

    return {
      ok: true,
      accountId,
      totalEquity: equity,
      totalAvailable: available,
      totalUnrealized,
      totalMargin,
      accountRows: [{
        currency: String(account.currency || 'USDC').toUpperCase(),
        available,
        availableBalance: available,
        availableEquity: available,
        equity,
        balance,
      }],
      openPositions: rawOpen.filter((p) => proprNumber(p.quantity) > 0),
      closedPositions: rawClosed,
      mappedOpenPositions: openPositions,
      mappedClosedPositions: closedPositions,
      openCount: openPositions.length,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    if (!options.quiet) return { ok: false, error: e.message };
    return null;
  }
}

async function testProprCredentials(credentials) {
  const apiKey = String(credentials?.apiKey || '').trim();
  if (!apiKey) return { ok: false, error: 'Propr API key is required.' };
  if (!/^pk_live_/i.test(apiKey)) {
    return { ok: false, error: 'Propr API keys start with pk_live_. Generate one at app.propr.xyz/settings.' };
  }

  try {
    const me = await proprRequest(apiKey, '/users/me');
    if (me.status === 401 || me.status === 403) {
      return { ok: false, error: 'Unauthorized — check your Propr API key.' };
    }
    if (!String(me.status || '').startsWith('2')) {
      const msg = me.data?.message || me.data?.error || `HTTP ${me.status}`;
      return { ok: false, error: msg, status: me.status };
    }

    const accountRes = await resolveProprAccount(apiKey, credentials?.accountId || '');
    if (!accountRes.ok) return accountRes;

    const live = await fetchLiveProprAccount({ apiKey, accountId: accountRes.accountId }, { quiet: true });
    const balance = proprNumber(live?.totalEquity);
    const currency = live?.accountRows?.[0]?.currency || 'USDC';
    const summary = balance > 0
      ? `${balance.toFixed(2)} ${currency} available · ${live?.openCount || 0} open positions`
      : `connected · account ${accountRes.accountId.slice(-8)}`;

    return {
      ok: true,
      mode: 'live',
      summary,
      accountId: accountRes.accountId,
      profile: me.data,
      live,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  PROPR_API_URL,
  proprRequest,
  resolveProprAccount,
  fetchLiveProprAccount,
  testProprCredentials,
  mapProprOpenPositions,
  mapProprClosedPositions,
};
