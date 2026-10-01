const path = require('path');
const fs = require('fs');

function isWindows() {
  return process.platform === 'win32';
}

function isUnixLike() {
  return process.platform === 'linux' || process.platform === 'darwin';
}

function spawnOptions(extra = {}) {
  return isWindows() ? { windowsHide: true, ...extra } : extra;
}

function pathExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function hermesExecutableCandidates(hermesHome, hermesInstall) {
  const names = isWindows() ? ['hermes.exe', 'hermes'] : ['hermes'];
  const relDirs = isWindows()
    ? ['', 'venv/Scripts', 'venv/bin', 'bin', '.venv/Scripts', '.venv/bin', '.hermes/bin']
    : ['', 'venv/bin', 'bin', '.venv/bin', '.venv/Scripts', '.hermes/bin'];
  const roots = [path.join(hermesHome, 'bin'), hermesInstall];
  const out = [];
  for (const root of roots) {
    for (const rel of relDirs) {
      for (const name of names) {
        out.push(rel ? path.join(root, ...rel.split('/'), name) : path.join(root, name));
      }
    }
  }
  return out;
}

function findHermesExecutable(hermesHome, hermesInstall) {
  return hermesExecutableCandidates(hermesHome, hermesInstall).find(pathExists) || null;
}

function venvPythonCandidates(hermesInstall) {
  const rel = isWindows()
    ? ['venv/Scripts/python.exe', '.venv/Scripts/python.exe', 'venv/bin/python.exe', '.venv/bin/python.exe']
    : ['venv/bin/python3', 'venv/bin/python', '.venv/bin/python3', '.venv/bin/python'];
  return rel.map((part) => path.join(hermesInstall, ...part.split('/')));
}

function findVenvPython(hermesInstall) {
  return venvPythonCandidates(hermesInstall).find(pathExists) || null;
}

function uvCandidates(hermesInstall) {
  const rel = isWindows()
    ? ['bin/uv.exe', '.venv/bin/uv.exe', '.venv/Scripts/uv.exe']
    : ['bin/uv', '.venv/bin/uv', '.venv/Scripts/uv'];
  return rel.map((part) => path.join(hermesInstall, ...part.split('/')));
}

function findUv(hermesInstall) {
  return uvCandidates(hermesInstall).find(pathExists) || 'uv';
}

function legacyHermesAgentDirs() {
  const home = require('os').homedir();
  const dirs = [];
  if (isWindows()) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(
      path.join(local, 'knight-trader', 'hermes', 'hermes-agent', 'agent'),
      path.join(local, 'knight-trader-blofin', 'hermes', 'hermes-agent', 'agent'),
      path.join(local, 'knight-trader-coinbase', 'hermes-coinbase', 'hermes-agent', 'agent'),
      path.join(local, 'knight-trader-propr', 'hermes-propr', 'hermes-agent', 'agent'),
    );
  } else {
    dirs.push(
      path.join(home, '.config', 'knight-trader-propr', 'hermes-propr', 'hermes-agent', 'agent'),
      path.join(home, '.config', 'KnightTrader Propr', 'hermes-propr', 'hermes-agent', 'agent'),
      path.join(home, '.hermes', 'hermes-agent', 'agent'),
    );
  }
  return dirs;
}

module.exports = {
  isWindows,
  isUnixLike,
  spawnOptions,
  hermesExecutableCandidates,
  findHermesExecutable,
  findVenvPython,
  findUv,
  legacyHermesAgentDirs,
};
