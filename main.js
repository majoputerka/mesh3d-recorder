const {
  app, BrowserWindow, BrowserView,
  ipcMain, globalShortcut, dialog, shell, Menu, screen,
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { spawn, execFile, exec } = require('child_process');

// ─── ffmpeg ─────────────────────────────────────────────────────────────────
let ffmpegBin = 'ffmpeg';
try { ffmpegBin = require('@ffmpeg-installer/ffmpeg').path; } catch {}

// ─── Chromium tuning (must be set before app is ready) ──────────────────────
// The BrowserView is a second webContents that Chromium de-prioritizes when
// our Electron shell window holds focus. That causes paint/compositor
// throttling, which shows up as stuttery scroll in recordings. Turn all the
// throttles off so the view paints at full rate regardless of focus.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ─── App name & icon ─────────────────────────────────────────────────────────
app.name = 'mesh3d';
const ICON_PATH = path.join(__dirname, 'build', 'mesh3d-logo-icon_1-iOS-Default-1024x1024@1x.png');

// ─── Constants ──────────────────────────────────────────────────────────────
const BAR_H      = 54;
const SETTINGS_H = 300;
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const CODEC_MAP = {
  hevc_hw: 'hevc_videotoolbox',
  h264_hw: 'h264_videotoolbox',
  h264:    'libx264',
  h265:    'libx265',
};

const DEFAULTS = {
  width:       1920,
  height:      1440,
  fps:         30,
  quality:     65,
  codec:       'hevc_hw',
  ssFormat:    'webp',
  ssQuality:   90,
  ssDir:       path.join(os.homedir(), 'Desktop'),
  videoDir:    path.join(os.homedir(), 'Desktop'),
  scrollSpeed: 2,
};

// ─── Settings ────────────────────────────────────────────────────────────────
let cfg = { ...DEFAULTS };

function loadCfg() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      Object.assign(cfg, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {}
}
function saveCfg() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function urlToName(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch { return 'capture'; }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function notify(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function isHWCodec(key) {
  return key === 'hevc_hw' || key === 'h264_hw';
}

// ─── AppleScript / browser helpers ───────────────────────────────────────────
// Uses execFile to run osascript as a DIRECT child of Electron (no shell),
// so macOS correctly attributes the Apple Events to this app and shows the
// Automation permission prompt on first use.
function runScript(script) {
  return new Promise((resolve, reject) => {
    const proc = execFile('/usr/bin/osascript', ['-'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
    proc.stdin.write(script + '\n');
    proc.stdin.end();
  });
}

// Ctrl+G — grab URL of current tab from browser via AppleScript.
// Uses execFile so macOS attributes the Apple Event to Electron directly,
// triggering the Automation permission prompt on first use.
async function grabBrowserUrl() {
  for (const browserApp of CHROMIUM_APPS) {
    try {
      const url = await runScript(`
        tell application "${browserApp}"
          return URL of active tab of front window
        end tell`);
      if (url?.startsWith('http')) { navigate(url); return; }
    } catch {}
  }
  // Try Safari
  try {
    const url = await runScript(`
      tell application "Safari"
        return URL of current tab of front window
      end tell`);
    if (url?.startsWith('http')) { navigate(url); return; }
  } catch {}
  notify('error', 'Could not grab URL — grant Automation access in System Settings > Privacy & Security');
}

// Ctrl+N — switch to next tab in browser + load URL.
// Tries AppleScript (Brave, Chrome, Edge, Arc, Safari) which triggers a one-time
// permission prompt from macOS. Once approved, works forever.
const CHROMIUM_APPS = ['Brave Browser', 'Google Chrome', 'Microsoft Edge', 'Opera', 'Vivaldi', 'Chromium', 'Arc'];

async function nextBrowserTab() {
  // Try each Chromium-based browser
  for (const browserApp of CHROMIUM_APPS) {
    try {
      const url = await runScript(`
        tell application "${browserApp}"
          set win to front window
          set cnt to count of tabs of win
          set idx to active tab index of win
          set active tab index of win to (idx mod cnt) + 1
          return URL of active tab of win
        end tell`);
      if (url?.startsWith('http')) { navigate(url); return; }
    } catch {}
  }

  // Try Safari
  try {
    const url = await runScript(`
      tell application "Safari"
        tell front window
          set cnt to number of tabs
          set idx to current tab index
          set current tab index to (idx mod cnt) + 1
          return URL of current tab
        end tell
      end tell`);
    if (url?.startsWith('http')) { navigate(url); return; }
  } catch {}

  notify('error', 'Switch tab manually, then press Ctrl+G to load it');
}

// ─── State ────────────────────────────────────────────────────────────────────
let win, view;
let settingsOpen = false;
let recording    = false;
let paused       = false;
let scrolling    = false;
let ffProc       = null;
let ffLogStream  = null;
let recTimerInt  = null;
let recStart     = null;
let currentUrl   = '';
let screencastOn = false;
let frameCount   = 0;
let lastJpeg     = null;
let writeTimer   = null;

// ─── Window ──────────────────────────────────────────────────────────────────
function create() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width:  Math.min(cfg.width, sw),
    height: Math.min(cfg.height + BAR_H, sh),
    minWidth:  400,
    minHeight: 200,
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (app.dock) { try { app.dock.setIcon(ICON_PATH); } catch {} }

  view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  win.addBrowserView(view);
  view.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  syncBounds();
  win.loadFile('renderer.html');
  // BrowserView follows window when resized
  win.on('resize', syncBounds);
  win.on('closed', () => { win = null; });
  Menu.setApplicationMenu(null);

  execFile(ffmpegBin, ['-version'], (err) => {
    if (err) notify('ffmpeg-missing', true);
  });
}

// BrowserView always maintains the configured aspect ratio (cfg.width / cfg.height).
// It scales to fit inside the available window area, centered, with dark bars
// filling the remaining space. The configured resolution is the OUTPUT size.
function syncBounds() {
  if (!win || !view) return;

  const [winW, winH] = win.getSize();
  const topH  = BAR_H + (settingsOpen ? SETTINGS_H : 0);
  const availW = winW;
  const availH = Math.max(winH - topH, 100);

  const cfgRatio   = cfg.width / cfg.height;
  const availRatio = availW / availH;

  let viewW, viewH;
  if (availRatio > cfgRatio) {
    viewH = availH;
    viewW = Math.round(viewH * cfgRatio);
  } else {
    viewW = availW;
    viewH = Math.round(viewW / cfgRatio);
  }

  const x = Math.round((availW - viewW) / 2);
  const y = topH + Math.round((availH - viewH) / 2);
  view.setBounds({ x, y, width: viewW, height: viewH });
  // Only apply emulation if a page has been loaded (not on startup)
  if (currentUrl) applyDeviceEmulation();
}

// Lock the page's CSS viewport to cfg.width × cfg.height regardless of window size.
// scale = zoom factor so content fills the visible view area.
// deviceScaleFactor=1 ensures capturePage() returns exactly cfg pixels (no Retina 2×).
function applyDeviceEmulation() {
  if (!view) return;
  const wc = view.webContents;
  if (!wc || wc.isDestroyed() || wc.isLoading()) return;
  const b = view.getBounds();
  if (!b.width || !b.height) return;
  const scale = Math.min(b.width / cfg.width, b.height / cfg.height);
  try {
    wc.enableDeviceEmulation({
      screenPosition:    'desktop',
      screenSize:        { width: cfg.width, height: cfg.height },
      viewPosition:      { x: 0, y: 0 },
      // deviceScaleFactor:1 makes capturePage() return exactly cfg.width×cfg.height
      // on any display (Retina or not) — no DPR guessing needed anywhere.
      deviceScaleFactor: 1,
      viewSize:          { width: cfg.width, height: cfg.height },
      scale,
    });
  } catch {}
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function navigate(url) {
  if (!url) return;
  if (!url.match(/^https?:\/\//)) url = `https://${url}`;
  currentUrl = url;
  if (scrolling) stopScroll();
  view.webContents.loadURL(url);
  view.webContents.once('did-finish-load', () => {
    hideScrollbars();
    applyDeviceEmulation();  // reapply after load — some sites reset emulation
  });
  view.webContents.once('did-navigate', (_, navUrl) => {
    currentUrl = navUrl;
    notify('navigated', navUrl);
  });
}

function hideScrollbars() {
  view.webContents.insertCSS(
    '::-webkit-scrollbar{display:none!important}' +
    '*{scrollbar-width:none!important;-ms-overflow-style:none!important}'
  ).catch(() => {});
}

// ─── Screenshot ──────────────────────────────────────────────────────────────
// Uses Chromium's built-in WebP/JPEG encoders — no ffmpeg or sips dependency.
// WebP: canvas.toDataURL('image/webp') via win.webContents (Chromium, always works).
// JPEG: NativeImage.toJPEG() — built into Electron.
// PNG:  NativeImage.toPNG()  — built into Electron.
async function pngToWebP(pngBuf, quality) {
  try {
    const b64 = pngBuf.toString('base64');
    const q   = quality / 100;
    const dataUrl = await win.webContents.executeJavaScript(`
      (function(b64, q) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c.toDataURL('image/webp', q));
          };
          img.onerror = () => reject(new Error('img load failed'));
          img.src = 'data:image/png;base64,' + b64;
        });
      })(${JSON.stringify(b64)}, ${q})
    `);
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/webp;base64,')) {
      return Buffer.from(dataUrl.slice(22), 'base64');
    }
  } catch {}
  return null;
}

async function screenshot() {
  if (!view) return;
  try {
    const topH = BAR_H + (settingsOpen ? SETTINGS_H : 0);
    if (!recording) {
      // Disable device emulation first so content fills the view naturally
      try { view.webContents.disableDeviceEmulation(); } catch {}
      view.setBounds({ x: 0, y: topH, width: cfg.width, height: cfg.height });
    }

    const raw = await view.webContents.capturePage();
    if (!recording) syncBounds();

    if (raw.isEmpty()) { notify('error', 'Navigate to a page first'); return; }

    const img  = raw.resize({ width: cfg.width, height: cfg.height, quality: 'best' });
    const name = urlToName(currentUrl || 'screenshot');
    const ext  = cfg.ssFormat;
    const dest = path.join(cfg.ssDir, `${name}.${ext}`);
    ensureDir(cfg.ssDir);

    if (ext === 'png') {
      fs.writeFileSync(dest, img.toPNG());
      notify('screenshot-saved', dest);
      return;
    }

    if (ext === 'jpeg') {
      fs.writeFileSync(dest, img.toJPEG(cfg.ssQuality));
      notify('screenshot-saved', dest);
      return;
    }

    // WebP — use Chromium's built-in encoder (guaranteed to work)
    const webpBuf = await pngToWebP(img.toPNG(), cfg.ssQuality);
    if (webpBuf) {
      fs.writeFileSync(dest, webpBuf);
      notify('screenshot-saved', dest);
    } else {
      // Chromium encoder failed (shouldn't happen) — fall back to PNG
      const png = path.join(cfg.ssDir, `${name}.png`);
      fs.writeFileSync(png, img.toPNG());
      notify('screenshot-saved', png);
    }
  } catch (e) {
    notify('error', `Screenshot: ${e.message}`);
  }
}

// ─── Recording ───────────────────────────────────────────────────────────────
// Capture is push-based: Chromium's DevTools Protocol (Page.startScreencast)
// emits one JPEG per actual compositor paint. We pipe those JPEGs into ffmpeg
// with wallclock timestamps, so the output video's frame timing reflects when
// frames were actually painted — no stale-compositor duplicates.
async function startRec() {
  if (recording) return;
  if (!currentUrl) { notify('error', 'Navigate to a page first'); return; }

  applyDeviceEmulation();

  const name     = urlToName(currentUrl);
  const dest     = path.join(cfg.videoDir, `${name}.mp4`);
  const codecKey = cfg.codec || 'hevc_hw';
  const ffCodec  = CODEC_MAP[codecKey] || 'hevc_videotoolbox';
  const hw       = isHWCodec(codecKey);
  ensureDir(cfg.videoDir);

  // We emit exactly `fps` JPEGs per second from Node (setInterval below), so
  // ffmpeg reads a clean CFR MJPEG stream. No -use_wallclock_as_timestamps
  // (image2pipe doesn't honor it) and no -vf fps (no resampling needed).
  const ffArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(cfg.fps),
    '-i', 'pipe:0',
    '-c:v', ffCodec,
  ];

  if (hw) {
    ffArgs.push('-q:v', String(cfg.quality));
  } else {
    const crf = Math.round(35 - ((cfg.quality - 1) / 99) * 25);
    ffArgs.push('-crf', String(crf), '-preset', 'fast');
  }

  if (ffCodec === 'hevc_videotoolbox' || ffCodec === 'libx265') {
    ffArgs.push('-tag:v', 'hvc1');
  }

  ffArgs.push('-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', dest);

  ffProc = spawn(ffmpegBin, ffArgs);

  const logPath = path.join(app.getPath('userData'), 'ffmpeg.log');
  try { ffLogStream = fs.createWriteStream(logPath, { flags: 'w' }); } catch {}
  ffProc.stderr.on('data', (d) => { if (ffLogStream) ffLogStream.write(d); });
  ffProc.stdin.on('error', () => {});
  ffProc.on('error', (e) => notify('error', `ffmpeg: ${e.message}`));
  ffProc.on('close', (code) => {
    ffProc = null;
    if (ffLogStream) { ffLogStream.end(); ffLogStream = null; }
    if (code === 0 || code === null) {
      notify('recording-saved', dest);
    } else {
      notify('error', `ffmpeg exited with code ${code} — see ${logPath}`);
    }
  });

  recording  = true;
  paused     = false;
  recStart   = Date.now();
  frameCount = 0;
  lastJpeg   = null;

  try {
    const wc = view.webContents;
    // Focus the view's webContents so Chromium treats it as the active
    // target and doesn't down-prioritize its compositor.
    wc.focus();
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.on('message', onCdpMessage);
    await wc.debugger.sendCommand('Page.enable');
    await wc.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: Math.max(1, Math.min(100, cfg.quality)),
      maxWidth: cfg.width,
      maxHeight: cfg.height,
      everyNthFrame: 1,
    });
    screencastOn = true;
  } catch (e) {
    notify('error', `CDP attach failed: ${e.message}`);
    recording = false;
    try { ffProc?.stdin.end(); } catch {}
    return;
  }

  // Emit exactly `fps` frames per second of wall-clock to ffmpeg. If the
  // browser paints slower than fps, the previous frame is repeated; if faster,
  // intermediate paints are dropped. This guarantees the output duration
  // matches real time and dupes are uniformly spaced.
  const frameMs = 1000 / cfg.fps;
  let nextTick  = Date.now() + frameMs;
  const emit = () => {
    if (!recording) return;
    if (!paused && lastJpeg && ffProc && ffProc.stdin.writable) {
      try {
        ffProc.stdin.write(lastJpeg);
        frameCount++;
      } catch {}
    }
    nextTick += frameMs;
    const delay = Math.max(0, nextTick - Date.now());
    writeTimer = setTimeout(emit, delay);
  };
  writeTimer = setTimeout(emit, frameMs);

  recTimerInt = setInterval(() => {
    notify('rec-timer', Math.floor((Date.now() - recStart) / 1000));
  }, 500);

  notify('rec-state', { recording: true, paused: false });
}

// CDP message router — the debugger API delivers every domain event here.
// We only care about screencast frames. Ack first so Chromium queues the next
// paint while we're still writing this one to ffmpeg.
function onCdpMessage(_event, method, params) {
  if (method !== 'Page.screencastFrame') return;
  const sessionId = params.sessionId;
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId })
      .catch(() => {});
  }

  if (!recording || paused) return;
  try {
    lastJpeg = Buffer.from(params.data, 'base64');
  } catch {}
}

function pauseRec() {
  if (!recording) return;
  paused = !paused;
  notify('rec-state', { recording: true, paused });
}

async function stopRec() {
  if (!recording) return;
  recording = false;
  paused    = false;

  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }

  try {
    const wc = view?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.debugger.off('message', onCdpMessage);
      if (screencastOn) {
        try { await wc.debugger.sendCommand('Page.stopScreencast'); } catch {}
      }
      if (wc.debugger.isAttached()) {
        try { wc.debugger.detach(); } catch {}
      }
    }
  } catch {}
  screencastOn = false;
  lastJpeg = null;

  if (ffProc) { try { ffProc.stdin.end(); } catch {} }

  const elapsed = (Date.now() - recStart) / 1000;
  const avgFps  = elapsed > 0 ? frameCount / elapsed : 0;
  console.log(`[mesh3d] recording done: ${frameCount} frames in ${elapsed.toFixed(1)}s (avg ${avgFps.toFixed(1)} fps painted)`);

  clearInterval(recTimerInt);
  recTimerInt = null;
  syncBounds();
  notify('rec-state', { recording: false, paused: false });
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
// Drives scrollTop from wall-clock time: pos = startPos + velocity × elapsed.
// This guarantees correct average velocity regardless of rAF jitter. Individual
// painted frames may still show variance in motion (that's a compositor paint
// timing issue, not a scroll issue) but velocity is stable second-to-second.
function startScroll() {
  if (!currentUrl) return;
  scrolling = true;
  const velocity = cfg.scrollSpeed * 62.5; // px/s (scrollSpeed is legacy px/16ms)
  view.webContents.executeJavaScript(`
    (function() {
      window.__m3dScrollActive = true;
      const de = document.scrollingElement || document.documentElement;
      const startPos = de.scrollTop;
      const startMs  = performance.now();
      function step() {
        if (!window.__m3dScrollActive) return;
        const elapsed = (performance.now() - startMs) / 1000;
        const max = Math.max(0, de.scrollHeight - de.clientHeight);
        const pos = Math.min(startPos + ${velocity} * elapsed, max);
        if (pos >= max) window.__m3dScrollActive = false;
        de.scrollTop = pos;
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })();
  `).catch(() => {});
  notify('scroll-state', true);
}

function stopScroll() {
  scrolling = false;
  view.webContents.executeJavaScript(
    `window.__m3dScrollActive = false;`
  ).catch(() => {});
  notify('scroll-state', false);
}

function toggleScroll() { scrolling ? stopScroll() : startScroll(); }

function resetScroll() {
  view.webContents.executeJavaScript(`window.scrollTo(0, 0);`).catch(() => {});
}

function refresh() {
  if (scrolling) stopScroll();
  view.webContents.reload();
  view.webContents.once('did-finish-load', hideScrollbars);
}

// ─── Settings panel ───────────────────────────────────────────────────────────
function toggleSettings() {
  settingsOpen = !settingsOpen;
  syncBounds();
  notify('settings-state', settingsOpen);
}

// ─── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('navigate',        (_, url) => navigate(url));
ipcMain.on('screenshot',      ()       => screenshot());
ipcMain.on('toggle-rec',      ()       => recording ? stopRec() : startRec());
ipcMain.on('pause-rec',       ()       => pauseRec());
ipcMain.on('toggle-scroll',   ()       => toggleScroll());
ipcMain.on('reset-scroll',    ()       => resetScroll());
ipcMain.on('refresh',         ()       => refresh());
ipcMain.on('toggle-settings', ()       => toggleSettings());
ipcMain.on('open-path',       (_, p)   => shell.showItemInFolder(p));
ipcMain.on('grab-url',        ()       => grabBrowserUrl());
ipcMain.on('next-tab',        ()       => nextBrowserTab());

ipcMain.handle('get-cfg', () => cfg);
ipcMain.on('set-cfg', (_, updates) => {
  Object.assign(cfg, updates);
  saveCfg();
  syncBounds();  // re-sync bounds after any settings change
});

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.filePaths[0] ?? null;
});

// ─── Global shortcuts ────────────────────────────────────────────────────────
function registerShortcuts() {
  const map = {
    // Recording
    'CommandOrControl+Shift+R': () => recording ? stopRec() : startRec(),
    'CommandOrControl+Shift+P': pauseRec,
    'CommandOrControl+Shift+M': screenshot,
    // Scroll
    'CommandOrControl+Shift+Down': toggleScroll,
    'CommandOrControl+Shift+Up':   resetScroll,
    'CommandOrControl+Shift+F':    refresh,
    // Browser integration
    'Control+G': grabBrowserUrl,   // Grab current browser tab URL
    'Control+N': nextBrowserTab,   // Next browser tab → load in app
    'Control+R': refresh,          // Refresh current page
  };
  for (const [key, fn] of Object.entries(map)) {
    try { globalShortcut.register(key, fn); } catch (e) {
      console.warn(`Could not register shortcut ${key}:`, e.message);
    }
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadCfg();
  create();
  registerShortcuts();
  navigate('mesh3d.gallery');
});

app.on('will-quit', () => {
  if (recording) stopRec();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());
