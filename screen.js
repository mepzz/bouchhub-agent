// screen.js — BouchHub Agent screen capture using FFmpeg gdigrab
// Captures frames via FFmpeg, streams JPEG to hub over HTTP POST

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let nutTree;
try { nutTree = require('@nut-tree-fork/nut-js'); } catch (e) {
  console.warn('[Screen] @nut-tree-fork/nut-js not available — input disabled');
}

const TMP_DIR = path.join(os.tmpdir(), 'bouchhub-screen');
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (_) {}

let ffmpegProc = null;
let isStreaming = false;
let callbackUrl = null;
let agentSecret = null;
let currentMonitor = 0;
let monitors = null;

// ── Monitor listing via PowerShell .ps1 file ─────────────────
async function getMonitors() {
  return new Promise((resolve) => {
    const ps1 = path.join(TMP_DIR, 'list_monitors.ps1');
    fs.writeFileSync(ps1, `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$out = @()
foreach ($s in $screens) {
  $out += @{ name=$s.DeviceName; width=$s.Bounds.Width; height=$s.Bounds.Height; x=$s.Bounds.X; y=$s.Bounds.Y; primary=$s.Primary }
}
$out | ConvertTo-Json -Compress
`);
    const { exec } = require('child_process');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([{ id: 0, name: 'Display 1', primary: true }]);
        try {
          let parsed = JSON.parse(stdout.trim());
          if (!Array.isArray(parsed)) parsed = [parsed];
          monitors = parsed.map((s, i) => ({
            id: i, name: s.name || `Display ${i + 1}`,
            width: s.width, height: s.height,
            x: s.x, y: s.y, primary: s.primary || i === 0,
          }));
          resolve(monitors);
        } catch { resolve([{ id: 0, name: 'Display 1', primary: true }]); }
      }
    );
  });
}

// ── FFmpeg screen capture stream ─────────────────────────────
async function startStream(options) {
  if (isStreaming) await stopStream();

  callbackUrl = options.callbackUrl;
  agentSecret = options.agentSecret;
  currentMonitor = options.monitorIndex || 0;
  isStreaming = true;

  // Get monitor info if we don't have it
  if (!monitors) await getMonitors();
  const mon = monitors[currentMonitor] || monitors[0];

  const fps = 10;
  const width = mon ? mon.width : 1920;
  const height = mon ? mon.height : 1080;
  const offsetX = mon ? mon.x : 0;
  const offsetY = mon ? mon.y : 0;

  // Scale down for bandwidth — cap at 1280 wide
  const scaleW = Math.min(width, 1280);
  const scaleH = Math.round((scaleW / width) * height);

  console.log(`[Screen] Starting FFmpeg stream → monitor ${currentMonitor} (${width}x${height} @ ${offsetX},${offsetY}) scaled to ${scaleW}x${scaleH} @ ${fps}fps`);

  // FFmpeg reads desktop, outputs MJPEG frames to stdout
  // gdigrab offset_x/offset_y lets us target a specific monitor
  ffmpegProc = spawn('ffmpeg', [
    '-f', 'gdigrab',
    '-framerate', String(fps),
    '-offset_x', String(offsetX),
    '-offset_y', String(offsetY),
    '-video_size', `${width}x${height}`,
    '-i', 'desktop',
    '-vf', `scale=${scaleW}:${scaleH}`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '5',   // JPEG quality 1=best, 31=worst — 5 is good balance
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

  ffmpegProc.on('error', (e) => {
    console.error('[Screen] FFmpeg error:', e.message);
    isStreaming = false;
  });

  ffmpegProc.on('close', (code) => {
    console.log('[Screen] FFmpeg exited code:', code);
    isStreaming = false;
    ffmpegProc = null;
  });

  // Parse MJPEG frames from stdout and POST each one to hub
  const nodeFetch = require('node-fetch');
  let buf = Buffer.alloc(0);
  let posting = false;

  ffmpegProc.stdout.on('data', (chunk) => {
    if (!isStreaming) return;
    buf = Buffer.concat([buf, chunk]);

    // MJPEG frames start with FF D8 and end with FF D9
    let start = -1;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD8) { start = i; break; }
    }
    if (start === -1) return;

    let end = -1;
    for (let i = start + 2; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD9) { end = i + 2; break; }
    }
    if (end === -1) return;

    const frame = buf.slice(start, end);
    buf = buf.slice(end);

    // Don't queue up frames if we're still posting the last one
    if (posting) return;
    posting = true;

    nodeFetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'x-agent-secret': agentSecret },
      body: frame,
      timeout: 3000,
    }).then(() => { posting = false; })
      .catch((e) => {
        posting = false;
        if (e.message && (e.message.includes('410') || e.message.includes('ECONNREFUSED'))) {
          console.log('[Screen] Hub gone — stopping stream');
          stopStream();
        }
      });
  });

  return { success: true };
}

async function stopStream() {
  isStreaming = false;
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
    ffmpegProc = null;
  }
  console.log('[Screen] Stream stopped');
}

// ── Input handling ───────────────────────────────────────────
async function handleInput(data) {
  if (!nutTree) return { error: 'Input control not available' };
  const { mouse, keyboard, Button, Key } = nutTree;
  try {
    if (data.type === 'mousemove') {
      await mouse.setPosition({ x: Math.round(data.x), y: Math.round(data.y) });
    } else if (data.type === 'mousedown') {
      await mouse.pressButton(data.button === 2 ? Button.RIGHT : Button.LEFT);
    } else if (data.type === 'mouseup') {
      await mouse.releaseButton(data.button === 2 ? Button.RIGHT : Button.LEFT);
    } else if (data.type === 'scroll') {
      if (data.deltaY > 0) await mouse.scrollDown(3);
      else await mouse.scrollUp(3);
    } else if (data.type === 'keydown') {
      const k = mapKey(Key, data.key);
      if (k !== null) await keyboard.pressKey(k);
    } else if (data.type === 'keyup') {
      const k = mapKey(Key, data.key);
      if (k !== null) await keyboard.releaseKey(k);
    } else if (data.type === 'type') {
      await keyboard.type(data.text);
    }
    return { success: true };
  } catch (e) {
    console.warn('[Screen] Input error:', e.message);
    return { error: e.message };
  }
}

function mapKey(Key, keyName) {
  const map = {
    'Enter': Key.Return, 'Backspace': Key.Backspace, 'Tab': Key.Tab,
    'Escape': Key.Escape, 'Delete': Key.Delete, 'ArrowLeft': Key.Left,
    'ArrowRight': Key.Right, 'ArrowUp': Key.Up, 'ArrowDown': Key.Down,
    'Home': Key.Home, 'End': Key.End, 'PageUp': Key.PageUp,
    'PageDown': Key.PageDown, 'Control': Key.LeftControl,
    'Shift': Key.LeftShift, 'Alt': Key.LeftAlt, ' ': Key.Space,
    'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
    'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
    'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
  };
  if (map[keyName] !== undefined) return map[keyName];
  if (keyName.length === 1) return Key[keyName.toUpperCase()] ?? null;
  return null;
}

module.exports = { getMonitors, startStream, stopStream, handleInput };
