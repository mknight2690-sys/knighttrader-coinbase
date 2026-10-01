const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setPaperOnly } = require('./paper-mode');
const { bootstrapCredentialsFromEnvironment } = require('./env-bootstrap');
const { spawnOptions } = require('./platform');

async function runHeadlessMode(deps, cli) {
  const {
    HERMES_HOME,
    HERMES_INSTALL,
    appendLog,
    checkHermesInstalled,
    installHermes,
    syncHermesCredentials,
    syncHermesConfig,
    hermesChildEnv,
    storeData,
    saveStore,
    getHermesEnvPath,
    DEFAULT_NOUS_MODEL,
    normalizeNousModel,
  } = deps;

  setPaperOnly(cli.paperOnly);
  if (cli.paperOnly) {
    appendLog('Paper-only mode enabled — Propr order API calls are blocked.', 'info');
  }

  bootstrapCredentialsFromEnvironment({
    storeData,
    saveStore,
    getHermesEnvPath,
    defaultNousModel: DEFAULT_NOUS_MODEL,
    normalizeNousModel,
  });

  let task = String(cli.task || '').trim();
  if (!task && cli.taskFile) {
    task = fs.readFileSync(path.resolve(cli.taskFile), 'utf8').trim();
  }
  if (!task) {
    console.error('Headless mode requires --task or --task-file.');
    process.exitCode = 1;
    return;
  }

  let status = checkHermesInstalled();
  if (!status.installed) {
    appendLog('Hermes not installed — running Linux/Unix installer…', 'info');
    const installed = await installHermes();
    if (!installed?.ok) {
      console.error(`Hermes install failed: ${installed?.error || installed?.msg || 'unknown error'}`);
      process.exitCode = 1;
      return;
    }
    status = checkHermesInstalled();
  }

  if (!status.installed) {
    console.error('Hermes is still not available after install.');
    process.exitCode = 1;
    return;
  }

  try {
    await syncHermesCredentials(null);
    syncHermesConfig();
  } catch (e) {
    appendLog(`Credential sync warning: ${e.message}`, 'warn');
  }

  const logsDir = path.join(HERMES_HOME, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `headless-${stamp}.log`);

  appendLog(`Running Hermes one-shot task (${status.path})…`, 'info');
  const env = {
    ...hermesChildEnv(),
    KT_HEADLESS: '1',
    KT_PAPER_ONLY: cli.paperOnly ? '1' : '0',
  };

  const args = ['-z', task];
  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn(status.path, args, {
      cwd: HERMES_INSTALL,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions(),
    });
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, text: Buffer.concat(chunks).toString('utf8') }));
  });

  fs.writeFileSync(logPath, output.text, 'utf8');
  process.stdout.write(`${output.text}\n`);
  appendLog(`Headless output saved to ${logPath}`, 'info');

  if (output.code !== 0) {
    appendLog(`Hermes exited with code ${output.code}`, 'error');
    process.exitCode = output.code;
    return;
  }

  appendLog('Headless task complete.', 'success');
}

module.exports = {
  runHeadlessMode,
};
