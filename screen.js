// screen.js — BouchHub Agent screen capture & input module
// Uses PowerShell + .NET for screenshots (no external bat dependencies)
// Uses @nut-tree-fork/nut-js for mouse/keyboard input

const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let nutTree;
try { nutTree = require('@nut-tree-fork/nut-js'); } catch (e) {
  console.warn('[Screen] @nut-tree-fork/nut-js not available — input disabled');
}

const TMP_DIR = path.join(os.tmpdir(), 'bouchhub-screen');
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (_) {}

let streamInterval = null;
let currentMonitor = 0;
let callbackUrl = null;
let agentSecret = null;
let isStreaming = false;
let frameCount = 0;

// ── Monitor listing via PowerShell ──────────────────────────
async function getMonitors() {
  return new Promise((resolve) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$out = @()
foreach ($s in $screens) {
  $out += @{
    name = $s.DeviceName
    width = $s.Bounds.Width
    height = $s.Bounds.Height
    x = $s.Bounds.X
    y = $s.Bounds.Y
    primary = $s.Primary
  }
}
$out | ConvertTo-Json -Compress`;

    exec(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          return resolve([{ id: 0, name: 'Display 1', primary: true }]);
        }
        try {
          let parsed = JSON.parse(stdout.trim());
          if (!Array.isArray(parsed)) parsed = [parsed];
          resolve(parsed.map((s, i) => ({
            id: i,
            name: s.name || `Display ${i + 1}`,
            width: s.width,
            height: s.height,
            x: s.x,
            y: s.y,
            primary: s.primary || i === 0,
          })));
        } catch {
          resolve([{ id: 0, name: 'Display 1', primary: true }]);
        }
      }
    );
  });
}

// ── Screenshot via PowerShell + .NET ────────────────────────
async function captureFrame(monitorIndex) {
  const tmpFile = path.join(TMP_DIR, `frame_${frameCount++ % 5}.jpg`);

  return new Promise((resolve, reject) => {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${monitorIndex}
if ($idx -ge $screens.Length) { $idx = 0 }
$screen = $screens[$idx]
$bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
$g.Dispose()
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 50L)
$bmp.Save('${tmpFile.replace(/\\/g, '\\\\')}', $enc, $params)
$bmp.Dispose()`;

    exec(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { windowsHide: true, timeout: 5000 },
      (err) => {
        if (err) return reject(new Error('Screenshot failed: ' + err.message));
        try {
          const buf = fs.readFileSync(tmpFile);
          resolve(buf);
        } catch (e) {
          reject(new Error('Could not read screenshot file: ' + e.message));
        }
      }
    );
  });
}

// ── Stream control ───────────────────────────────────────────
async function startStream(options) {
  if (isStreaming) await stopStream();
  callbackUrl = options.callbackUrl;
  agentSecret = options.agentSecret;
  currentMonitor = options.monitorIndex || 0;
  isStreaming = true;

  const fps = options.fps || 5; // 5fps — good balance for PowerShell-based capture
  const interval = Math.floor(1000 / fps);

  console.log(`[Screen] Starting stream → monitor ${currentMonitor} @ ${fps}fps`);

  const nodeFetch = require('node-fetch');
  let capturing = false;

  streamInterval = setInterval(async () => {
    if (!isStreaming || !callbackUrl || capturing) return;
    capturing = true;
    try {
      const frame = await captureFrame(currentMonitor);
      await nodeFetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'x-agent-secret': agentSecret },
        body: frame,
        timeout: 3000,
      });
    } catch (e) {
      if (e.message && (e.message.includes('410') || e.message.includes('ECONNREFUSED'))) {
        console.log('[Screen] Hub session gone — stopping stream');
        stopStream();
      } else {
        console.warn('[Screen] Frame error:', e.message);
      }
    } finally {
      capturing = false;
    }
  }, interval);

  return { success: true };
}

async function stopStream() {
  isStreaming = false;
  if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
  callbackUrl = null;
  console.log('[Screen] Stream stopped');
}

// ── Input handling ───────────────────────────────────────────
async function handleInput(data) {
  if (!nutTree) return { error: 'Input control not available (@nut-tree-fork/nut-js not installed)' };
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
