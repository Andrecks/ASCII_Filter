const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  getSettings: () => ipcRenderer.invoke('settings'),
  onSettings: (cb) => ipcRenderer.on('settings', (e, s) => cb(s)),
  getCursor: () => ipcRenderer.invoke('cursor'),
  onRecapture: (cb) => ipcRenderer.on('recapture', () => cb()),
  ocr: (jpegBytes) => ipcRenderer.invoke('ocr', jpegBytes),
  report: (data) => ipcRenderer.send('selftest-report', data),
});
