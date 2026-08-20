const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kt', {
  // Credentials
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),
  writeCompendium: () => ipcRenderer.invoke('write-compendium'),
  getCompendiumPath: () => ipcRenderer.invoke('get-compendium-path'),
  getHermesHome: () => ipcRenderer.invoke('get-hermes-home'),
  testNousCredentials: (data) => ipcRenderer.invoke('test-nous-credentials', data),
  getNousModels: () => ipcRenderer.invoke('get-nous-models'),
  testCoinbaseCredentials: (data) => ipcRenderer.invoke('test-coinbase-credentials', data),
  pickNousCredentialFile: () => ipcRenderer.invoke('pick-nous-credential-file'),
  pickCoinbaseCredentialFile: () => ipcRenderer.invoke('pick-coinbase-credential-file'),

  // Hermes management
  checkHermes: () => ipcRenderer.invoke('check-hermes'),
  installHermes: () => ipcRenderer.invoke('install-hermes'),
  wipeHermes: () => ipcRenderer.invoke('wipe-hermes'),
  addDefenderExclusion: () => ipcRenderer.invoke('add-defender-exclusion'),
  startDashboard: () => ipcRenderer.invoke('start-dashboard'),
  stopDashboard: () => ipcRenderer.invoke('stop-dashboard'),
  getDashboardStatus: () => ipcRenderer.invoke('get-dashboard-status'),
  configureCron: () => ipcRenderer.invoke('configure-cron'),
  getCronPrompt: () => ipcRenderer.invoke('get-cron-prompt'),

  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),

  // Live events from main process
  onLogLine: (cb) => ipcRenderer.on('log-line', (_e, entry) => cb(entry)),
  onDashboardReady: (cb) => ipcRenderer.on('dashboard-ready', (_e, d) => cb(d)),
  onDashboardStopped: (cb) => ipcRenderer.on('dashboard-stopped', (_e, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, payload) => cb(payload)),

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),

  // Trading / BloHunter desk
  getBlohunterPreloadPath: () => ipcRenderer.invoke('get-blohunter-preload-path'),
  attachTradingWebview: (webContentsId) => ipcRenderer.invoke('attach-trading-webview', webContentsId),
  startTradingDashboard: () => ipcRenderer.invoke('start-trading-dashboard'),
  stopTradingDashboard: () => ipcRenderer.invoke('stop-trading-dashboard'),
  getTradingStatus: () => ipcRenderer.invoke('get-trading-status'),
  bhRuntimeSend: (msg) => ipcRenderer.invoke('bh-runtime-send', msg),
  bhStorageGet: (keys) => ipcRenderer.invoke('bh-storage-get', keys),
  bhStorageSet: (items) => ipcRenderer.invoke('bh-storage-set', items),
  bhStorageRemove: (keys) => ipcRenderer.invoke('bh-storage-remove', keys),
  bhStorageGetSession: (keys) => ipcRenderer.invoke('bh-storage-get-session', keys),
  bhStorageSetSession: (items) => ipcRenderer.invoke('bh-storage-set-session', items),
  bhStorageRemoveSession: (keys) => ipcRenderer.invoke('bh-storage-remove-session', keys),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close')
});
