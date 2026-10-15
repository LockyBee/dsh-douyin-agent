const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('douyinDesktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('douyin:get-settings'),
  saveSettings: value => ipcRenderer.invoke('douyin:save-settings', value),
  clearApiKey: () => ipcRenderer.invoke('douyin:clear-key'),
  openMemoryFolder: () => ipcRenderer.invoke('douyin:open-memory'),
  openPersonaFolder: () => ipcRenderer.invoke('douyin:open-persona'),
}));
