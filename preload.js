const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = [
  'rec-state', 'rec-timer', 'scroll-state',
  'screenshot-saved', 'recording-saved',
  'navigated', 'error', 'settings-state', 'shortcuts-state', 'ffmpeg-missing',
];

contextBridge.exposeInMainWorld('api', {
  navigate:      (url)     => ipcRenderer.send('navigate', url),
  screenshot:    ()        => ipcRenderer.send('screenshot'),
  toggleRec:     ()        => ipcRenderer.send('toggle-rec'),
  pauseRec:      ()        => ipcRenderer.send('pause-rec'),
  toggleScroll:  ()        => ipcRenderer.send('toggle-scroll'),
  refresh:       ()        => ipcRenderer.send('refresh'),
  toggleSettings:  ()      => ipcRenderer.send('toggle-settings'),
  toggleShortcuts: ()      => ipcRenderer.send('toggle-shortcuts'),
  grabUrl:       ()        => ipcRenderer.send('grab-url'),
  nextTab:       ()        => ipcRenderer.send('next-tab'),
  getCfg:        ()        => ipcRenderer.invoke('get-cfg'),
  setCfg:        (updates) => ipcRenderer.send('set-cfg', updates),
  pickDir:       ()        => ipcRenderer.invoke('pick-dir'),
  openPath:      (p)       => ipcRenderer.send('open-path', p),
  on: (channel, fn) => {
    if (ALLOWED.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => fn(data));
    }
  },
});
