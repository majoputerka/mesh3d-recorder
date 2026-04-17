const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__m3dRecorder', {
  captureTick: () => ipcRenderer.send('m3d-capture-tick'),
});
