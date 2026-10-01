const fs = require('fs');
const path = require('path');

function readEnvFileValue(envPath, key) {
  try {
    if (!fs.existsSync(envPath)) return '';
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return (match ? match[1].trim() : '').replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
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

function bootstrapCredentialsFromEnvironment({
  storeData,
  saveStore,
  getHermesEnvPath,
  defaultNousModel,
  normalizeNousModel,
}) {
  const envPath = getHermesEnvPath();
  const nousFromEnv = String(
    process.env.NOUS_API_KEY
    || process.env.NOUSRESEARCH_API_KEY
    || readEnvFileValue(envPath, 'NOUS_API_KEY')
    || readEnvFileValue(envPath, 'NOUSRESEARCH_API_KEY')
    || '',
  ).trim();
  const proprFromEnv = String(process.env.PROPR_API_KEY || readEnvFileValue(envPath, 'PROPR_API_KEY') || '').trim();
  const accountFromEnv = String(process.env.PROPR_ACCOUNT_ID || readEnvFileValue(envPath, 'PROPR_ACCOUNT_ID') || '').trim();

  let changed = false;
  if (nousFromEnv && !String(storeData.nous?.apiKey || '').trim()) {
    storeData.nous = {
      ...(storeData.nous || {}),
      apiKey: nousFromEnv,
      model: normalizeNousModel(storeData.nous?.model || defaultNousModel),
    };
    changed = true;
  }
  if (proprFromEnv && !String(storeData.propr?.apiKey || '').trim()) {
    storeData.propr = {
      ...(storeData.propr || {}),
      apiKey: proprFromEnv,
      accountId: accountFromEnv || storeData.propr?.accountId || '',
    };
    changed = true;
  } else if (accountFromEnv && !String(storeData.propr?.accountId || '').trim()) {
    storeData.propr = { ...(storeData.propr || {}), accountId: accountFromEnv };
    changed = true;
  }

  if (changed) saveStore(storeData);

  const nousKey = String(storeData.nous?.apiKey || nousFromEnv || '').trim();
  const proprKey = String(storeData.propr?.apiKey || proprFromEnv || '').trim();
  const proprAccountId = String(storeData.propr?.accountId || accountFromEnv || '').trim();

  if (!nousKey && !proprKey) return { ok: true, changed };

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  let after = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (nousKey) {
    after = upsertEnvVar(after, 'NOUS_API_KEY', nousKey);
    after = upsertEnvVar(after, 'NOUSRESEARCH_API_KEY', nousKey);
  }
  if (proprKey) after = upsertEnvVar(after, 'PROPR_API_KEY', proprKey);
  if (proprAccountId) after = upsertEnvVar(after, 'PROPR_ACCOUNT_ID', proprAccountId);
  fs.writeFileSync(envPath, after, 'utf8');

  return { ok: true, changed, nousKey, proprKey };
}

module.exports = {
  bootstrapCredentialsFromEnvironment,
  readEnvFileValue,
};
