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
let recTimerInt  = null;
let recStart     = null;
let currentUrl   = '';
let frameDeltas          = [];
let captureDurWarmup     = [];
let captureDurPost       = [];
let droppedTickCount     = 0;
let modeSwitchCount      = 0;
let detectedRefreshRate  = 60;
let captureEveryNthRaf   = 2;
let captureTickHandler   = null;
let watchdogTimer        = null;

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
      preload: path.join(__dirname, 'view-preload.js'),
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
// Device emulation (deviceScaleFactor:1, viewSize:cfg) keeps the view at its
// current scaled-down window size so the user can interact normally, while
// capturePage() returns exactly cfg.width × cfg.height BGRA frames.
async function startRec() {
  if (recording) return;
  if (!currentUrl) { notify('error', 'Navigate to a page first'); return; }

  // Ensure emulation is active — view stays visually scaled, output is full-res.
  applyDeviceEmulation();


  frameDeltas      = [];
  captureDurWarmup = [];
  captureDurPost   = [];
  const name     = urlToName(currentUrl);
  const dest     = path.join(cfg.videoDir, `${name}.mp4`);
  const rawDest  = path.join(cfg.videoDir, `${name}_raw.mp4`);
  const codecKey = cfg.codec || 'hevc_hw';
  const ffCodec  = CODEC_MAP[codecKey] || 'hevc_videotoolbox';
  const hw       = isHWCodec(codecKey);
  ensureDir(cfg.videoDir);

  const fw = cfg.width;
  const fh = cfg.height;
  const frameMs = Math.round(1000 / cfg.fps);

  const ffArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${fw}x${fh}`,
    '-framerate', String(cfg.fps),
    '-use_wallclock_as_timestamps', '1',
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

  ffArgs.push('-vsync', 'cfr', '-pix_fmt', 'yuv420p', '-an', rawDest);

  ffProc = spawn(ffmpegBin, ffArgs);
  ffProc.stderr.on('data', () => {});
  ffProc.on('error', (e) => notify('error', `ffmpeg: ${e.message}`));
  ffProc.on('close', (code) => {
    ffProc = null;
    if (code === 0 || code === null) {
      // Trim the 1-second warmup from the start of the raw video (stream copy, fast)
      const trimProc = spawn(ffmpegBin, [
        '-y', '-ss', '1.0', '-i', rawDest, '-c', 'copy', dest,
      ]);
      trimProc.stderr.on('data', () => {});
      trimProc.on('close', (trimCode) => {
        try { fs.unlinkSync(rawDest); } catch {}
        notify('recording-saved', trimCode === 0 ? dest : rawDest);
      });
    } else {
      try { fs.unlinkSync(rawDest); } catch {}
      notify('error', `ffmpeg exited with code ${code} — try H.264 codec`);
    }
  });

  recording = true;
  paused    = false;
  recStart  = Date.now();

  // ── Refresh rate & capture cadence ─────────────────────────────────────────
  const refreshRate = screen.getPrimaryDisplay().displayFrequency || 60;
  const captureN    = Math.max(1, Math.round(refreshRate / cfg.fps));
  detectedRefreshRate = refreshRate;
  captureEveryNthRaf  = captureN;
  droppedTickCount    = 0;
  modeSwitchCount     = 0;
  console.log(`[mesh3d] sync: refresh=${refreshRate}Hz captureEveryNthRaf=${captureN} frameMs=${frameMs}ms`);

  const WARMUP_MS      = 1000;
  const WARMUP_PREWARM = 10;
  let warmupDone   = false;
  let warmupCount  = 0;
  let warmupEnd    = Date.now() + WARMUP_MS;
  let lastWriteAt  = 0;
  let lastDeltaAt  = 0;
  let lastTickAt   = 0;
  let tickReceived = false;   // set by IPC handler, cleared on write
  let ipcActive    = false;   // tracks mode for logging only

  // Free-running loop — always active throughout recording (warmup + capture).
  // Writes on rAF tick (scroll-synced) or falls back to time-based throttle.
  function doCapture() {
    if (!recording) return;
    const t0 = Date.now();
    view.webContents.capturePage().then((img) => {
      if (!recording) return;
      const now = Date.now();
      const dur = now - t0;

      if (!warmupDone) {
        captureDurWarmup.push(dur);
        warmupCount++;
        if (now >= warmupEnd && warmupCount >= WARMUP_PREWARM) {
          warmupDone  = true;
          lastWriteAt = now;
          lastDeltaAt = now;
          lastTickAt  = now;
          console.log(`[mesh3d] warmup done: ${warmupCount} captures in ${now - (warmupEnd - WARMUP_MS)}ms`);
          startWatchdog();
        }
        setTimeout(doCapture, 0);
        return;
      }

      captureDurPost.push(dur);
      // Tick arrived → write now (scroll-synced). No tick → time-based fallback.
      const shouldWrite = tickReceived || (now - lastWriteAt >= frameMs);
      if (!paused && !img.isEmpty() && ffProc?.stdin?.writable && shouldWrite) {
        tickReceived = false;
        if (lastDeltaAt > 0) frameDeltas.push(now - lastDeltaAt);
        lastDeltaAt = now;
        lastWriteAt = now;
        const { width, height } = img.getSize();
        const frame = (width === cfg.width && height === cfg.height)
          ? img
          : img.resize({ width: cfg.width, height: cfg.height, quality: 'best' });
        ffProc.stdin.write(frame.getBitmap());
      }
      setTimeout(doCapture, 0);
    }).catch(() => {
      if (recording) setTimeout(doCapture, 4);
    });
  }

  // IPC handler: flag a tick — free-run loop consumes it on next resolution.
  captureTickHandler = () => {
    if (!recording || !warmupDone) return;
    lastTickAt = Date.now();
    if (tickReceived) droppedTickCount++;   // coalesced tick (previous not yet consumed)
    tickReceived = true;
    if (!ipcActive) {
      ipcActive = true;
      modeSwitchCount++;
      console.log('[mesh3d] mode switch: time-gated → tick-gated');
    }
  };

  ipcMain.on('m3d-capture-tick', captureTickHandler);

  // Watchdog: log when ticks stop arriving (capture still runs via time-gated fallback).
  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!recording || !warmupDone) return;
      if (ipcActive && Date.now() - lastTickAt > 200) {
        ipcActive = false;
        modeSwitchCount++;
        console.log('[mesh3d] mode switch: tick-gated → time-gated (no ticks for 200ms)');
      }
    }, 100);
  }

  doCapture();

  recTimerInt = setInterval(() => {
    notify('rec-timer', Math.floor((Date.now() - recStart) / 1000));
  }, 500);

  notify('rec-state', { recording: true, paused: false });
}

function pauseRec() {
  if (!recording) return;
  paused = !paused;
  notify('rec-state', { recording: true, paused });
}

function frameStats(deltas) {
  const n = deltas.length;
  if (!n) return null;
  const mean     = deltas.reduce((a, b) => a + b, 0) / n;
  const variance = deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / n;
  const stddev   = Math.sqrt(variance);
  const min      = Math.min(...deltas);
  const max      = Math.max(...deltas);
  return { mean, stddev, min, max, n };
}

function stopRec() {
  if (!recording) return;
  recording = false;
  paused    = false;

  if (ffProc) { try { ffProc.stdin.end(); } catch {} }

  clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (captureTickHandler) {
    ipcMain.removeListener('m3d-capture-tick', captureTickHandler);
    captureTickHandler = null;
  }

  // Print frame interval timing summary
  const deltas = frameDeltas.slice();
  if (deltas.length) {
    const splitAt = Math.round(2 * cfg.fps);
    const first2s = deltas.slice(0, splitAt);
    const rest    = deltas.slice(splitAt);
    const fmt = (s) => `mean=${s.mean.toFixed(1)}ms stddev=${s.stddev.toFixed(1)} min=${s.min} max=${s.max} n=${s.n}`;
    console.log(`[mesh3d] frame deltas — all: ${fmt(frameStats(deltas))}`);
    if (first2s.length) console.log(`[mesh3d]   first 2s: ${fmt(frameStats(first2s))}`);
    if (rest.length)    console.log(`[mesh3d]   after 2s: ${fmt(frameStats(rest))}`);
  }
  const fmtD = (s) => `mean=${s.mean.toFixed(1)}ms stddev=${s.stddev.toFixed(1)} min=${s.min} max=${s.max} n=${s.n}`;
  if (captureDurWarmup.length) console.log(`[mesh3d] capturePage duration — warmup: ${fmtD(frameStats(captureDurWarmup))}`);
  if (captureDurPost.length) {
    const ps  = frameStats(captureDurPost);
    const fms = Math.round(1000 / cfg.fps);
    console.log(`[mesh3d] capturePage duration — post-warmup: ${fmtD(ps)}`);
    console.log(`[mesh3d] capture budget ratio: post-warmup mean / frameMs = ${(ps.mean / fms).toFixed(2)}`);
  }
  console.log(`[mesh3d] sync mode: detected refresh=${detectedRefreshRate}Hz, captureEveryNthRaf=${captureEveryNthRaf}`);
  console.log(`[mesh3d] dropped ticks: ${droppedTickCount} (target 0, acceptable <5/min)`);
  console.log(`[mesh3d] mode switches: ${modeSwitchCount} (ipc ↔ fallback)`);

  // Async: fetch scroll signal log from renderer and compute summary stats.
  try {
    view.webContents.executeJavaScript('JSON.stringify(window.__m3dScrollLog || [])').then(json => {
      const log = JSON.parse(json);
      if (!log.length) { console.log('[mesh3d] rAF log: no data (scroll not active during recording)'); return; }

      const logPath = path.join(os.tmpdir(), 'mesh3d-scroll-debug.json');
      try { fs.writeFileSync(logPath, json); } catch {}

      const tsDeltasAll   = log.map(f => f[2]);
      const tsDeltaDrops  = tsDeltasAll.filter(d => d > 20);
      const maxDelta      = Math.max(...tsDeltasAll);

      const absErrors = [];
      for (let i = 1; i < log.length; i++) {
        absErrors.push(Math.abs((log[i][3] - log[i-1][3]) - (log[i][5] - log[i-1][5])));
      }

      const tickFrames     = log.filter(f => f[6] === 1);
      const capturedDeltas = [];
      for (let i = 1; i < tickFrames.length; i++) {
        capturedDeltas.push(tickFrames[i][5] - tickFrames[i-1][5]);
      }

      const stat = arr => {
        const n = arr.length;
        if (!n) return { mean: 0, stddev: 0, min: 0, max: 0, n: 0 };
        const mean = arr.reduce((a, b) => a + b, 0) / n;
        const stddev = Math.sqrt(arr.reduce((a, d) => a + (d - mean) ** 2, 0) / n);
        return { mean, stddev, min: Math.min(...arr), max: Math.max(...arr), n };
      };

      const cad = stat(tsDeltasAll);
      const err = stat(absErrors);
      const cap = stat(capturedDeltas);

      console.log(`[mesh3d] rAF cadence: mean=${cad.mean.toFixed(1)}ms stddev=${cad.stddev.toFixed(1)} min=${cad.min.toFixed(1)} max=${cad.max.toFixed(1)}`);
      console.log(`[mesh3d] rAF drops (tsDelta > 20ms): count=${tsDeltaDrops.length}, max observed delta=${maxDelta.toFixed(1)}ms`);
      console.log(`[mesh3d] scrollTop quantization: mean abs error=${err.mean.toFixed(3)}px, max error=${err.max.toFixed(3)}px`);
      console.log(`[mesh3d] captured frame deltas (scrollTopAfter between tick frames): mean=${cap.mean.toFixed(2)}px stddev=${cap.stddev.toFixed(2)} min=${cap.min} max=${cap.max} n=${cap.n}`);
      console.log(`[mesh3d] rAF debug log → ${logPath}`);
    }).catch(() => {});
  } catch {}

  clearInterval(recTimerInt);
  recTimerInt = null;
  syncBounds();
  notify('rec-state', { recording: false, paused: false });
}

// ─── Scroll ───────────────────────────────────────────────────────────────────
function startScroll() {
  if (!currentUrl) return;
  scrolling = true;
  // velocity in px/s — scrollSpeed was pixels per 16ms tick, so × 62.5
  const velocity = cfg.scrollSpeed * 62.5;
  view.webContents.executeJavaScript(`typeof window.__m3dRecorder?.captureTick`)
    .then(t => console.log(`[mesh3d] preload check: captureTick = ${t}`))
    .catch(() => {});
  const rafN = captureEveryNthRaf;
  view.webContents.executeJavaScript(`
    (function() {
      window.__m3dScrollActive = true;
      window.__m3dScrollLog = [];
      let lastTs = null;
      let pos = window.scrollY;
      let rafCount = 0;
      let firstTs = null;
      const captureN = ${rafN};
      function step(ts) {
        if (!window.__m3dScrollActive) return;
        if (lastTs !== null) {
          if (firstTs === null) firstTs = ts;
          const tsDelta = ts - lastTs;
          const delta = ${velocity} * tsDelta / 1000;
          pos += delta;
          const scrollTopBefore = document.documentElement.scrollTop;
          document.documentElement.scrollTop = pos;
          document.body.scrollTop = pos;
          const scrollTopAfter = document.documentElement.scrollTop;
          document.dispatchEvent(new WheelEvent('wheel', {
            deltaY: delta, deltaMode: 0, bubbles: true, cancelable: true
          }));
          rafCount++;
          const tickSent = rafCount % captureN === 0;
          if (tickSent) window.__m3dRecorder?.captureTick();
          if (ts - firstTs < 5000) {
            window.__m3dScrollLog.push([rafCount, ts, tsDelta, pos, scrollTopBefore, scrollTopAfter, tickSent ? 1 : 0]);
          }
        }
        lastTs = ts;
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
