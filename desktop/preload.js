const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  getSettings: () => ipcRenderer.invoke('settings'),
  onSettings: (cb) => ipcRenderer.on('settings', (e, s) => cb(s)),
  getCursor: () => ipcRenderer.invoke('cursor'),
  onRecapture: (cb) => ipcRenderer.on('recapture', () => cb()),
  ocr: (jpegBytes) => ipcRenderer.invoke('ocr', jpegBytes),
  report: (data) => ipcRenderer.send('selftest-report', data),
});

// hotkeys.html — the bind editor window (same preload as the overlay)
contextBridge.exposeInMainWorld('deskHotkeys', {
  list: () => ipcRenderer.invoke('hotkeys:list'),
  set: (id, accel) => ipcRenderer.invoke('hotkeys:set', id, accel),
  reset: () => ipcRenderer.invoke('hotkeys:reset'),
  capture: (on) => ipcRenderer.send('hotkeys:capture', on),
});
