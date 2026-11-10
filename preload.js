const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  env: () => ipcRenderer.invoke('env'),
  pick: () => ipcRenderer.invoke('pick'),
  chooseDir: () => ipcRenderer.invoke('chooseDir'),
  scan: (paths) => ipcRenderer.invoke('scan', paths),
  thumb: (file) => ipcRenderer.invoke('thumb', file),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  merge: (payload) => ipcRenderer.invoke('merge', payload),
  cancel: () => ipcRenderer.invoke('cancel'),
  onJob: (cb) => ipcRenderer.on('job', (_e, m) => cb(m)),
  pathFor: (file) => webUtils.getPathForFile(file),
});
