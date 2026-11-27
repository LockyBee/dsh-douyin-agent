const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('douyinDesktop', Object.freeze({
  checkUpdates: () => ipcRenderer.invoke('douyin:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('douyin:download-update'),
  installUpdate: () => ipcRenderer.invoke('douyin:install-update'),
  getSettings: () => ipcRenderer.invoke('douyin:get-settings'),
  saveSettings: value => ipcRenderer.invoke('douyin:save-settings', value),
  clearApiKey: () => ipcRenderer.invoke('douyin:clear-key'),
  openMemoryFolder: () => ipcRenderer.invoke('douyin:open-memory'),
  openPersonaFolder: () => ipcRenderer.invoke('douyin:open-persona'),
  openBrowserVerification: () => ipcRenderer.invoke('douyin:open-browser-verification'),
  checkBrowserVerification: () => ipcRenderer.invoke('douyin:check-browser-verification'),
  readBrowserVerificationStatus: () => ipcRenderer.invoke('douyin:browser-verification-status'),
  saveMediaKey: value => ipcRenderer.invoke('douyin:save-media-key', value),
}));
