// When running under Electron, use the userData .env path
require('dotenv').config({
  path: process.env.BOUCHHUB_ENV_PATH || require('path').join(__dirname, '.env')
});
const fetch = require('node-fetch');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const simpleGit = require('simple-git');
const express = require('express');

// ─── Config ────────────────────────────────────────────────
const { HUB_URL, AGENT_SECRET, DEVICE_ID, DEVICE_NAME, AGENT_PORT } = process.env;

if (!HUB_URL || !AGENT_SECRET || !DEVICE_ID || !DEVICE_NAME) {
  console.error('[Agent] Missing configuration. Run "node setup.js" first.');
  process.exit(1);
}

const PORT = parseInt(AGENT_PORT || '3001');
const HEARTBEAT_INTERVAL = 5 * 1000;
const STATS_INTERVAL = 5 * 1000;
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;
// When running under Electron, use the bundled git and repo dir
const ROOT = process.env.BOUCHHUB_REPO_DIR || path.join(__dirname, '..');
const GIT_EXE = process.env.BOUCHHUB_GIT_EXE || 'git';
const git = simpleGit(ROOT, {
  binary: GIT_EXE,
  config: ['core.autocrlf=false'],
  unsafe: {
    allowUnsafeCustomBinary: true,  // allow paths with spaces (e.g. Program Files)
  },
});
const AGENT_VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0.0.0'; }
})();
// When running under tray.js, signal updates via exit code 42 instead of self-spawning
const UNDER_TRAY = process.env.BOUCHHUB_TRAY === '1';

let heartbeatTimer = null;
let updateTimer = null;
let statsTimer = null;
let isShuttingDown = false;

// ─── Stats Cache ───────────────────────────────────────────
let cachedStats = {
  cpu: { usage: 0, temp: null, model: '', cores: 0 },
  gpu: { usage: null, temp: null, vramUsed: null, vramTotal: null, model: '' },
  ram: { used: 0, total: 0, pct: 0 },
  disks: [],
  network: [],
  fans: [],
  uptime: 0,
  timestamp: Date.now()
};

// ─── CPU Usage ─────────────────────────────────────────────
function getCpuTicks() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

let lastCpuTicks = getCpuTicks();
let cpuUsagePct = 0;

setInterval(() => {
  const now = getCpuTicks();
  const idleDiff = now.idle - lastCpuTicks.idle;
  const totalDiff = now.total - lastCpuTicks.total;
  cpuUsagePct = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
  lastCpuTicks = now;
}, 2000);

// ─── PowerShell one-shot runner ────────────────────────────
let lastNetStats = null;

function runPS(script, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('{}'), timeoutMs);
    exec(
      `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\"')}"`,
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => {
        clearTimeout(timer);
        resolve((stdout || '').trim() || '{}');
      }
    );
  });
}

async function getAllStats() {
  const script = `
$out = @{}
try { $t = (Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace root/wmi -EA Stop | Select -First 1).CurrentTemperature; $out.cpuTemp = [math]::Round(($t-2732)/10) } catch { $out.cpuTemp = $null }
try { $smi = & nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null; if ($smi) { $p=$smi.Trim().Split(','); $out.gpu=@{model=$p[0].Trim();temp=[int]$p[1];usage=[int]$p[2];vramUsed=[math]::Round([int]$p[3]/1024,1);vramTotal=[math]::Round([int]$p[4]/1024,1)} } } catch {}
if (-not $out.gpu) { try { $vc=Get-WmiObject Win32_VideoController -EA Stop|Select -First 1; $out.gpu=@{model=$vc.Name;temp=$null;usage=$null;vramUsed=$null;vramTotal=[math]::Round($vc.AdapterRAM/1GB,1)} } catch { $out.gpu=@{model='N/A';temp=$null;usage=$null;vramUsed=$null;vramTotal=$null} } }
try { $out.disks=@(Get-WmiObject Win32_LogicalDisk -Filter DriveType=3 -EA Stop|%{$t=[math]::Round($_.Size/1GB,1);$f=[math]::Round($_.FreeSpace/1GB,1);@{drive=$_.DeviceID;total=$t;used=[math]::Round($t-$f,1);free=$f;pct=[math]::Round(($t-$f)/$t*100)}}) } catch { $out.disks=@() }
try { $out.net=@(Get-NetAdapterStatistics -EA Stop|?{$_.ReceivedBytes -gt 0}|%{@{name=$_.Name;rx=$_.ReceivedBytes;tx=$_.SentBytes}}) } catch { $out.net=@() }
try { $out.fans=@(Get-WmiObject Win32_Fan -EA Stop|?{$_.DesiredSpeed -gt 0}|%{@{name=$_.Name;rpm=$_.DesiredSpeed}}) } catch { $out.fans=@() }
$out | ConvertTo-Json -Depth 5 -Compress`.trim();

  try {
    const out = await runPS(script);
    return JSON.parse(out);
  } catch(e) {
    return {};
  }
}

// ─── Collect All Stats ─────────────────────────────────────
async function collectStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();

  // Single PS process for all system stats — no more process pile-up
  const psStats = await getAllStats();

  // Compute network speeds from delta
  const now = Date.now();
  let network = [];
  if (psStats.net && Array.isArray(psStats.net)) {
    network = psStats.net.map(a => {
      let rxSpeed = 0, txSpeed = 0;
      if (lastNetStats) {
        const prev = lastNetStats.adapters.find(p => p.name === a.name);
        if (prev) {
          const dt = (now - lastNetStats.time) / 1000;
          rxSpeed = Math.max(0, Math.round((a.rx - prev.rx) / dt / 1024 / 1024 * 100) / 100);
          txSpeed = Math.max(0, Math.round((a.tx - prev.tx) / dt / 1024 / 1024 * 100) / 100);
        }
      }
      return { name: a.name, rxMBs: rxSpeed, txMBs: txSpeed };
    });
    lastNetStats = { time: now, adapters: psStats.net };
  }

  cachedStats = {
    cpu: { usage: cpuUsagePct, temp: psStats.cpuTemp ?? null, model: cpus[0]?.model?.trim() || 'Unknown', cores: cpus.length },
    gpu: psStats.gpu ?? { model: 'N/A', temp: null, usage: null, vramUsed: null, vramTotal: null },
    ram: {
      used: Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10,
      total: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
      pct: Math.round((usedMem / totalMem) * 100)
    },
    disks: psStats.disks ?? [],
    network,
    fans: psStats.fans ?? [],
    uptime: Math.floor(os.uptime()),
    timestamp: Date.now()
  };
}

// ─── Express API ───────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
});

app.get('/stats', (req, res) => res.json(cachedStats));

app.get('/info', (req, res) => {
  res.json({
    deviceId: DEVICE_ID, deviceName: DEVICE_NAME,
    platform: process.platform, arch: os.arch(), hostname: os.hostname(),
    cpuModel: os.cpus()[0]?.model?.trim(), cores: os.cpus().length,
    totalRam: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    nodeVersion: process.version,
    agentVersion: AGENT_VERSION,
    underTray: UNDER_TRAY,
  });
});

app.get('/version', (req, res) => {
  res.json({ version: AGENT_VERSION, underTray: UNDER_TRAY });
});

// Hub calls this when the device is deleted — signal Electron to show disconnect UI
app.post('/disconnect', (req, res) => {
  res.json({ success: true });
  console.log('[Agent] Disconnect signal received from hub');
  // Signal the tray wrapper via a special exit code
  setTimeout(() => process.exit(43), 500); // 43 = disconnected by hub
});

app.post('/update/check', async (req, res) => {
  const result = await checkForUpdates(false);
  res.json(result);
});

app.post('/update/force', async (req, res) => {
  // Responds immediately, update happens async
  res.json({ status: 'checking' });
  await checkForUpdates(true);
});

// Process list via PowerShell
app.get('/processes', async (req, res) => {
  try {
    const out = await runPS(
      'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 | ForEach-Object { $_.Name + "," + [math]::Round($_.WorkingSet64/1MB,1) + "," + $_.Id + "," + [math]::Round($_.CPU,1) } | Out-String'
    );
    const processes = out.split('\n').filter(l => l.trim() && l.includes(',')).map(line => {
      const parts = line.trim().split(',');
      if (parts.length < 3) return null;
      return {
        name: parts[0],
        ramMB: parseFloat(parts[1]) || 0,
        pid: parseInt(parts[2]) || 0,
        cpu: parseFloat(parts[3]) || 0
      };
    }).filter(Boolean);
    res.json(processes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Remote Terminal UI (port 3002) ───────────────────────────────────────────
const termApp = require('express')();
const TERM_PORT = 3002;

termApp.get('/', (req, res) => {
  // Simple auth via agent secret in URL query
  if (req.query.secret !== process.env.AGENT_SECRET) {
    return res.status(403).send('<h2>403 Forbidden</h2>');
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BouchHub Terminal — ${require('os').hostname()}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e8e8f0;font-family:'Courier New',monospace;height:100vh;display:flex;flex-direction:column}
.header{background:#111118;border-bottom:1px solid #1e1e2e;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.logo{font-weight:700;font-size:16px;color:#7c6aff}
.hostname{font-size:12px;color:#5a5a7a}
#output{flex:1;overflow-y:auto;padding:16px 20px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
.line{margin-bottom:2px}
.line.cmd{color:#7c6aff}
.line.out{color:#e8e8f0}
.line.err{color:#ff6a6a}
.input-row{display:flex;align-items:center;padding:12px 20px;background:#111118;border-top:1px solid #1e1e2e;gap:10px;flex-shrink:0}
.prompt{color:#7c6aff;flex-shrink:0;font-size:13px}
#cmdInput{flex:1;background:transparent;border:none;color:#e8e8f0;font-family:inherit;font-size:13px;outline:none}
.cwd{font-size:11px;color:#5a5a7a;padding:4px 20px 8px;background:#111118}
</style>
</head>
<body>
<div class="header">
  <div class="logo">BouchHub</div>
  <div class="hostname">Terminal — ${require('os').hostname()}</div>
</div>
<div id="output"><div class="line out">Connected to ${require('os').hostname()}. Type commands below.</div></div>
<div class="cwd" id="cwd">PS &gt; ${process.cwd()}</div>
<div class="input-row">
  <div class="prompt">PS &gt;</div>
  <input id="cmdInput" autofocus placeholder="Enter command..." autocomplete="off">
</div>
<script>
const secret = new URLSearchParams(location.search).get('secret');
let cwd = ${JSON.stringify(process.env.USERPROFILE || 'C:\\Users\\alexi')};
const output = document.getElementById('output');
const input = document.getElementById('cmdInput');
const cwdEl = document.getElementById('cwd');
const history = [];
let histIdx = -1;

function addLine(text, cls) {
  const d = document.createElement('div');
  d.className = 'line ' + cls;
  d.textContent = text;
  output.appendChild(d);
  output.scrollTop = output.scrollHeight;
}

input.addEventListener('keydown', async (e) => {
  if (e.key === 'ArrowUp') { if (histIdx < history.length-1) { histIdx++; input.value = history[histIdx]; } e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { if (histIdx > 0) { histIdx--; input.value = history[histIdx]; } else { histIdx = -1; input.value = ''; } e.preventDefault(); return; }
  if (e.key !== 'Enter') return;
  const cmd = input.value.trim();
  if (!cmd) return;
  history.unshift(cmd);
  histIdx = -1;
  input.value = '';
  addLine('PS > ' + cmd, 'cmd');
  try {
    const r = await fetch('/terminal/run?secret=' + encodeURIComponent(secret), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ command: cmd, cwd })
    });
    const d = await r.json();
    if (d.output) addLine(d.output, 'out');
    if (d.error) addLine(d.error, 'err');
    if (d.cwd) { cwd = d.cwd; cwdEl.textContent = 'PS > ' + cwd; }
  } catch(e) { addLine('Error: ' + e.message, 'err'); }
});
</script>
</body>
</html>`);
});

termApp.use(require('express').json());

termApp.post('/terminal/run', async (req, res) => {
  if (req.query.secret !== process.env.AGENT_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });

  // Handle cd specially so cwd persists
  if (command.trim().toLowerCase().startsWith('cd ')) {
    const newDir = command.trim().slice(3).trim();
    const resolved = require('path').resolve(cwd || process.cwd(), newDir);
    try {
      require('fs').accessSync(resolved);
      return res.json({ output: '', cwd: resolved });
    } catch { return res.json({ error: 'Directory not found: ' + resolved, cwd }); }
  }

  try {
    const output = await new Promise((resolve, reject) => {
      exec(command, {
        shell: 'powershell.exe',
        cwd: cwd || process.cwd(),
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return reject(err);
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      });
    });
    res.json({ output: (output.stdout + output.stderr).trim(), cwd: cwd || process.cwd() });
  } catch (e) {
    res.json({ error: e.message, cwd: cwd || process.cwd() });
  }
});

termApp.listen(TERM_PORT, '0.0.0.0', () => {
  console.log('[Agent] Remote terminal available at http://<ip>:' + TERM_PORT + '/?secret=<AGENT_SECRET>');
});

// Run any shell command
app.post('/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Missing command' });
  try {
    const output = await new Promise((resolve, reject) => {
      exec(command, { shell: 'powershell.exe', timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) return reject(err);
        resolve((stdout || '') + (stderr || ''));
      });
    });
    res.json({ success: true, output: output.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message, output: '' });
  }
});

// Kill process by name (all instances)
app.post('/processes/killbyname', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const safeName = name.replace(/[^a-zA-Z0-9\-_\.]/g, '');
  try {
    await runPS(`taskkill /F /IM "${safeName}.exe" /T`);
    res.json({ success: true, name: safeName });
  } catch (e) {
    try {
      await runPS(`Stop-Process -Name "${safeName}" -Force -ErrorAction SilentlyContinue`);
      res.json({ success: true, name: safeName });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// Kill process by PID
app.post('/processes/kill', async (req, res) => {
  const { pid } = req.body;
  if (!pid) return res.status(400).json({ error: 'Missing pid' });
  try {
    // Try taskkill first (more reliable on Windows for stubborn processes)
    await runPS(`taskkill /F /PID ${parseInt(pid)}`);
    res.json({ success: true, pid });
  } catch (e) {
    try {
      // Fallback to Stop-Process
      await runPS(`Stop-Process -Id ${parseInt(pid)} -Force`);
      res.json({ success: true, pid });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ─── Browser Automation Routes ─────────────────────────────
let browserModule;
try { browserModule = require('./browser'); } catch (e) {
  console.warn('[Agent] Playwright not available:', e.message);
}

app.post('/browser/navigate', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed. Run: npx playwright install chromium' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try { res.json({ success: true, ...(await browserModule.navigate(url)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/instagram/login', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed' });
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) return res.status(400).json({ error: 'INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD not set in agent .env' });
  try { res.json(await browserModule.instagramLogin(username, password)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/instagram/dm', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed' });
  const { recipient, message } = req.body;
  if (!recipient || !message) return res.status(400).json({ error: 'Missing recipient or message' });
  try {
    if (!browserModule.isOpen()) {
      const u = process.env.INSTAGRAM_USERNAME, p = process.env.INSTAGRAM_PASSWORD;
      if (u && p) await browserModule.instagramLogin(u, p);
    }
    res.json(await browserModule.instagramSendDM(recipient, message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch DM — sends to multiple recipients sequentially, closes browser when done
app.post('/browser/instagram/dm/batch', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed' });
  const { recipients, message } = req.body;
  if (!Array.isArray(recipients) || !recipients.length || !message)
    return res.status(400).json({ error: 'Missing recipients array or message' });
  try {
    if (!browserModule.isOpen()) {
      const u = process.env.INSTAGRAM_USERNAME, p = process.env.INSTAGRAM_PASSWORD;
      if (u && p) await browserModule.instagramLogin(u, p);
    }
    const results = [];
    for (const recipient of recipients) {
      try {
        await browserModule.instagramSendDM(recipient, message);
        results.push({ recipient, success: true });
        console.log(`[Agent] DM sent to @${recipient}`);
      } catch (e) {
        results.push({ recipient, success: false, error: e.message });
        console.error(`[Agent] DM failed for @${recipient}: ${e.message}`);
      }
    }
    await browserModule.closeBrowser();
    const allOk = results.every(r => r.success);
    res.json({ success: allOk, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/browser/close', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed' });
  try { await browserModule.closeBrowser(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/browser/info', async (req, res) => {
  if (!browserModule) return res.json({ isOpen: false, error: 'Playwright not installed' });
  res.json({ isOpen: browserModule.isOpen(), ...(await browserModule.getPageInfo()) });
});

app.get('/browser/screenshot', async (req, res) => {
  if (!browserModule) return res.status(503).json({ error: 'Playwright not installed' });
  const img = await browserModule.screenshot();
  if (!img) return res.status(503).json({ error: 'No browser open' });
  res.json({ screenshot: img });
});

const fs = require('fs');
const multer = require('multer');

// Pinned locations
app.get('/files/pinned', (req, res) => {
  const home = os.homedir();
  const pins = [
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Downloads', path: path.join(home, 'Downloads') },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'C:\\', path: 'C:\\' },
  ].filter(p => {
    try { fs.accessSync(p.path); return true; } catch { return false; }
  });
  res.json(pins);
});

// List directory
app.get('/files', (req, res) => {
  const dirPath = req.query.path;
  if (!dirPath) return res.status(400).json({ error: 'Missing path' });
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.map(e => {
      const fullPath = path.join(dirPath, e.name);
      let size = null, modified = null;
      try {
        const stat = fs.statSync(fullPath);
        size = e.isFile() ? stat.size : null;
        modified = stat.mtime.toISOString();
      } catch (_) {}
      return {
        name: e.name,
        path: fullPath,
        isDir: e.isDirectory(),
        size,
        modified
      };
    }).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dirPath, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download file
app.get('/files/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    res.download(filePath, path.basename(filePath));
  } catch (err) {
    res.status(404).json({ error: 'File not found or not readable' });
  }
});

// Upload file
const upload = multer({ dest: os.tmpdir() });
app.post('/files/upload', upload.single('file'), (req, res) => {
  const destDir = req.query.path;
  if (!destDir || !req.file) return res.status(400).json({ error: 'Missing path or file' });
  const destPath = path.join(destDir, req.file.originalname);
  try {
    fs.renameSync(req.file.path, destPath);
    res.json({ success: true, path: destPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file or folder
app.delete('/files', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create folder
app.post('/files/mkdir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'Missing path' });
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Screen Capture Routes ──────────────────────────────────
let screenModule;
try { screenModule = require('./screen'); } catch (e) {
  console.warn('[Agent] screen module not available:', e.message);
}

// GET /screen/monitors — list displays
app.get('/screen/monitors', async (req, res) => {
  if (!screenModule) return res.status(503).json({ error: 'screen module not available' });
  try { res.json({ monitors: await screenModule.getMonitors() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /screen/start — begin streaming frames to hub
app.post('/screen/start', async (req, res) => {
  if (!screenModule) return res.status(503).json({ error: 'screen module not available' });
  const { monitorIndex, callbackUrl, agentSecret, fps } = req.body;
  if (!callbackUrl) return res.status(400).json({ error: 'callbackUrl required' });
  try {
    const result = await screenModule.startStream({ monitorIndex: monitorIndex || 0, callbackUrl, agentSecret, fps });
    // Notify the Electron tray to show sharing notification
    if (process.env.BOUCHHUB_TRAY) {
      try { process.send && process.send({ type: 'screen_sharing_started' }); } catch (_) {}
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /screen/stop — stop streaming
app.post('/screen/stop', async (req, res) => {
  if (!screenModule) return res.status(503).json({ error: 'screen module not available' });
  try {
    await screenModule.stopStream();
    if (process.env.BOUCHHUB_TRAY) {
      try { process.send && process.send({ type: 'screen_sharing_stopped' }); } catch (_) {}
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /screen/input — receive mouse/keyboard events from hub
app.post('/screen/input', async (req, res) => {
  if (!screenModule) return res.status(503).json({ error: 'screen module not available' });
  try { res.json(await screenModule.handleInput(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`[Agent] API listening on port ${PORT}`));

// ─── Heartbeat ─────────────────────────────────────────────
function getLocalIp() {
  const nets = os.networkInterfaces();
  // Prefer Tailscale (100.x.x.x), then private LAN, then fallback
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push({ name, address: net.address });
      }
    }
  }
  const tailscale = candidates.find(c => c.address.startsWith('100.'));
  if (tailscale) return tailscale.address;
  const lan = candidates.find(c => c.address.startsWith('192.168.') || c.address.startsWith('10.') || c.address.startsWith('172.'));
  if (lan) return lan.address;
  return candidates[0]?.address || '127.0.0.1';
}

async function sendHeartbeat() {
  try {
    const res = await fetch(`${HUB_URL}/api/devices/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': AGENT_SECRET },
      body: JSON.stringify({
        id: DEVICE_ID, name: DEVICE_NAME,
        platform: process.platform === 'win32' ? 'windows' : process.platform,
        agentPort: PORT,
        localIp: getLocalIp(),
        version: AGENT_VERSION,
        stats: {
          cpu: cachedStats.cpu.usage, ramUsed: cachedStats.ram.used,
          ramTotal: cachedStats.ram.total, ram: cachedStats.ram.pct,
          uptime: cachedStats.uptime
        }
      }),
      timeout: 10000
    });
    if (!res.ok) console.error(`[Agent] Heartbeat rejected: ${res.status}`);
    else console.log(`[Agent] Heartbeat sent — ${new Date().toLocaleTimeString()}`);
  } catch (err) { console.warn(`[Agent] Hub unreachable: ${err.message}`); }
}

// ─── Offline notification ──────────────────────────────────
async function notifyOffline() {
  try {
    await fetch(`${HUB_URL}/api/devices/${DEVICE_ID}/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': AGENT_SECRET },
      timeout: 5000
    });
    console.log('[Agent] Notified hub: going offline');
  } catch (_) {}
}

// ─── Auto-updater ──────────────────────────────────────────
let updateInProgress = false;

async function checkForUpdates(force = false) {
  if (updateInProgress) return { status: 'already_updating' };
  try {
    await git.fetch('origin', 'main');
    const gitStatus = await git.status();
    if (gitStatus.behind > 0 || force) {
      if (gitStatus.behind === 0 && force) {
        return { status: 'up_to_date' };
      }
      console.log(`[Agent] Update available (${gitStatus.behind} commit(s) behind). Pulling...`);
      updateInProgress = true;
      // Hard reset to avoid local change conflicts — agent files should never be manually edited
      await git.fetch('origin', 'main');
      await git.reset(['--hard', 'origin/main']);
      console.log('[Agent] Pull complete. Reinstalling dependencies...');
      await new Promise((resolve, reject) => {
        exec('npm install --prefix ' + JSON.stringify(__dirname), { cwd: __dirname, windowsHide: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('[Agent] Update applied.');
      if (UNDER_TRAY) {
        // Signal tray wrapper to restart us cleanly
        console.log('[Agent] Signalling tray for restart (exit 42)...');
        setTimeout(() => process.exit(42), 500);
      } else {
        // Standalone fallback: spawn new instance and exit
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [path.join(__dirname, 'agent.js')], {
          detached: true, stdio: 'ignore', env: process.env, windowsHide: true
        });
        child.unref();
        setTimeout(() => process.exit(0), 500);
      }
      return { status: 'updated' };
    } else {
      console.log('[Agent] Already up to date.');
      return { status: 'up_to_date' };
    }
  } catch (err) {
    updateInProgress = false;
    console.warn('[Agent] Update check failed:', err.message);
    return { status: 'error', error: err.message };
  }
}

// ─── Shutdown ──────────────────────────────────────────────
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Agent] Received ${signal}, shutting down...`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (updateTimer) clearInterval(updateTimer);
  if (statsTimer) clearInterval(statsTimer);
  await notifyOffline();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

if (process.platform === 'win32') {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => shutdown('SIGINT'));
}

// ─── Start ─────────────────────────────────────────────────
async function start() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║       BouchHub Agent v2.0          ║');
  console.log('╠════════════════════════════════════╣');
  console.log(`║  Device: ${DEVICE_NAME.padEnd(26)}║`);
  console.log(`║  Hub:    ${HUB_URL.substring(0, 26).padEnd(26)}║`);
  console.log(`║  Port:   ${String(PORT).padEnd(26)}║`);
  console.log('╚════════════════════════════════════╝\n');

  console.log('[Agent] Collecting initial stats...');
  try {
    await Promise.race([
      collectStats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stats timeout')), 10000))
    ]);
  } catch (e) {
    console.warn('[Agent] Initial stats collection skipped:', e.message);
  }

  await sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  statsTimer = setInterval(collectStats, STATS_INTERVAL);

  setTimeout(() => {
    checkForUpdates();
    updateTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
  }, 60 * 1000);

  console.log('[Agent] Running. Press Ctrl+C to stop.');
}

start().catch(err => {
  console.error('[Agent] Fatal error:', err.message);
  process.exit(1);
});



