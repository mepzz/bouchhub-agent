// bouchhub-agent/claude.js
//
// Drives autonomous coding-agent CLIs on this machine so BouchHub can improve
// itself. Originally Claude-only; now multi-provider so several agents can work
// the roadmap in parallel, each in its OWN clone:
//   • claude → Claude Code CLI      (folder BouchHub2)      — gated on Max usage
//   • codex  → OpenAI Codex CLI     (folder BouchHub-Codex) — signed into ChatGPT
//   • gemini → Google Gemini CLI    (folder BouchHub-Gemini)
//
// Each provider: resolveBin() locates its CLI, work() launches it hidden in the
// background teeing output to a per-provider log, preflight() checks it's ready,
// and a per-provider single-session lock stops two sessions sharing one git tree.
// Claude also exposes status() (Max usage gate); the others are always-runnable.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// ── Providers ────────────────────────────────────────────────────────────────
// Each provider's CLI has a slightly different shape. subcmd/promptFlag/flags
// describe how to invoke it; env `<PROVIDER>_FLAGS` / `<PROVIDER>_BIN` override
// defaults if a CLI version needs different flags or an explicit path.
const PROVIDERS = {
  claude: {
    cli: 'claude', binEnv: 'CLAUDE_BIN', defaultFolder: 'BouchHub2',
    subcmd: '', promptFlag: '-p', usageGate: true,
    flags: (auto) => `--verbose${auto ? ' --dangerously-skip-permissions' : ''}`,
  },
  codex: {
    cli: 'codex', binEnv: 'CODEX_BIN', defaultFolder: 'BouchHub-Codex',
    subcmd: 'exec', promptFlag: '', usageGate: false, // prompt is positional after `exec`
    flags: (auto) => (auto ? '--dangerously-bypass-approvals-and-sandbox' : ''),
  },
  gemini: {
    cli: 'gemini', binEnv: 'GEMINI_BIN', defaultFolder: 'BouchHub-Gemini',
    subcmd: '', promptFlag: '-p', usageGate: false,
    flags: (auto) => (auto ? '--yolo' : ''),
  },
};
function providerOf(name) { return PROVIDERS[name] || PROVIDERS.claude; }
function providerFlags(name, auto) {
  const env = process.env[`${name.toUpperCase()}_FLAGS`];
  return env != null ? env : providerOf(name).flags(auto);
}

// Per-provider log so parallel sessions don't interleave. Claude keeps the
// original filename for backward compatibility with existing tooling.
function logPathFor(name) {
  return path.join(os.tmpdir(), name === 'claude' ? 'bouchhub-autopilot.log' : `bouchhub-autopilot-${name}.log`);
}
const LOG_PATH = logPathFor('claude');

function workFolderFor(name) {
  const p = providerOf(name);
  const override = process.env[`${name.toUpperCase()}_WORK_FOLDER`];
  return override || path.join(os.homedir(), 'Downloads', p.defaultFolder);
}

// ── Per-provider single-session lock ─────────────────────────────────────────
// At most ONE session per provider (they'd fight over one git tree otherwise).
const _locks = {}; // name → { child, startedAt, pid }
function workBusy(name) {
  const w = _locks[name];
  if (!w || !w.child) return null;
  if (w.child.exitCode !== null || w.child.killed) return null;
  const ageMin = Math.round((Date.now() - w.startedAt) / 60000);
  if (ageMin >= 180) return null; // a >3h session is treated as stale/hung
  return { pid: w.pid, ageMin };
}

function run(cmd, args, { timeoutMs = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { cwd, shell: true, windowsHide: true });
    const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: e.message }); });
  });
}

function q(p) { return /\s/.test(p) && !/^".*"$/.test(p) ? `"${p}"` : p; }

// ─── Locate a provider's CLI ─────────────────────────────────────────────────
// A background agent doesn't always inherit the interactive shell's PATH, so a
// bare `claude`/`codex`/`gemini` can fail even when installed. Search hard:
// where/which, then common install locations, then a --version probe. Cached.
const _bins = {};    // name → resolved bin (quoted)
const _search = {};  // name → search trace
function binCandidates(name) {
  const p = providerOf(name);
  const cli = p.cli;
  const home = os.homedir();
  const A = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const L = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [process.env[p.binEnv], cli].filter(Boolean);
  if (process.platform === 'win32') {
    list.push(`${cli}.cmd`, `${cli}.exe`,
      path.join(A, 'npm', `${cli}.cmd`),
      path.join(A, 'npm', `${cli}.ps1`),
      path.join(L, 'Programs', cli, `${cli}.exe`),
      path.join(home, '.local', 'bin', `${cli}.exe`),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', `${cli}.exe`));
  } else {
    list.push(`/usr/local/bin/${cli}`, `/opt/homebrew/bin/${cli}`,
      path.join(home, '.local', 'bin', cli), path.join(home, '.npm-global', 'bin', cli));
  }
  return [...new Set(list.filter(Boolean))];
}
async function resolveBin(name = 'claude') {
  if (_bins[name]) return _bins[name];
  const cli = providerOf(name).cli;
  const trace = _search[name] = [];
  const fs = require('fs');
  try {
    const r = await run(process.platform === 'win32' ? 'where' : 'which', [cli], { timeoutMs: 8000 });
    const lines = `${r.out}`.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const best = process.platform === 'win32'
      ? (lines.find(l => /\.cmd$/i.test(l)) || lines.find(l => /\.exe$/i.test(l)) || lines.find(l => /\.bat$/i.test(l)) || lines[0])
      : lines[0];
    trace.push(`where/which → ${r.code === 0 && best ? best : 'not found'}`);
    if (r.code === 0 && best) { _bins[name] = q(best); return _bins[name]; }
  } catch (e) { trace.push(`where/which errored: ${e.message}`); }
  for (const bin of binCandidates(name)) {
    if (/[\\/]/.test(bin)) {
      try { if (fs.existsSync(bin)) { trace.push(`found file: ${bin}`); _bins[name] = q(bin); return _bins[name]; } } catch (_) {}
    }
  }
  for (const bin of binCandidates(name)) {
    try {
      const r = await run(q(bin), ['--version'], { timeoutMs: 10000 });
      if (r.code === 0 && /\d/.test(`${r.out}`)) { trace.push(`ran: ${bin}`); _bins[name] = q(bin); return _bins[name]; }
    } catch (_) {}
  }
  trace.push('exhausted all known locations');
  return null;
}
// Back-compat alias used elsewhere/tests.
async function resolveClaude() { return resolveBin('claude'); }

// Parse a usage blob into { usedPct, resetsInMin } (Claude Max only).
function parseUsage(text) {
  const t = (text || '').replace(/\[[0-9;]*m/g, '');
  let usedPct = null, resetsInMin = null;
  const pct = t.match(/(\d{1,3})\s*%\s*(?:of|used|used\b)/i) || t.match(/used\D{0,12}(\d{1,3})\s*%/i) || t.match(/(\d{1,3})\s*%/);
  if (pct) { const n = parseInt(pct[1], 10); if (n >= 0 && n <= 100) usedPct = n; }
  const relHM = t.match(/reset[^0-9]*?(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
  const relM = t.match(/reset[^0-9]*?(\d+)\s*m\b/i);
  if (relHM) {
    resetsInMin = parseInt(relHM[1], 10) * 60 + parseInt(relHM[2] || '0', 10);
  } else if (relM) {
    resetsInMin = parseInt(relM[1], 10);
  } else {
    const at = t.match(/reset[^0-9]*at\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (at) {
      const now = new Date();
      let h = parseInt(at[1], 10); const m = parseInt(at[2], 10);
      const ap = (at[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      const target = new Date(now); target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      resetsInMin = Math.round((target - now) / 60000);
    }
  }
  return { usedPct, resetsInMin, raw: t.slice(0, 500) };
}
function parseLimit(text) {
  const t = (text || '').replace(/\[[0-9;]*m/g, '');
  const limited = /usage limit|rate.?limit|limit reached|limit will reset|you(?:'ve| have) reached/i.test(t);
  if (!limited) return { limited: false, resetsInMin: null };
  const { resetsInMin } = parseUsage(t);
  return { limited: true, resetsInMin };
}

// Whether a provider may run right now. Only Claude has a usage gate; Codex and
// Gemini have no scriptable usage, so they report always-runnable.
async function status(provider = 'claude') {
  const bin = await resolveBin(provider);
  if (!bin) return { provider, usedPct: null, resetsInMin: null, limited: false, readable: false, raw: `${provider} CLI not found on this PC` };
  if (!providerOf(provider).usageGate) {
    return { provider, usedPct: null, resetsInMin: null, limited: false, readable: false, raw: `${provider}: no usage gate` };
  }
  let usedPct = null, resetsInMin = null, raw = '';
  for (const args of [['-p', '/usage'], ['usage']]) {
    const r = await run(bin, args, { timeoutMs: 30000 });
    raw = `${r.out}\n${r.err}`.trim();
    const p = parseUsage(raw);
    if (p.usedPct != null) { usedPct = p.usedPct; resetsInMin = p.resetsInMin; break; }
  }
  if (usedPct != null) return { provider, usedPct, resetsInMin, limited: usedPct >= 100, readable: true, raw: raw.slice(0, 300) };
  const probe = await run(bin, ['-p', 'ok', '--output-format', 'json'], { timeoutMs: 45000 });
  const text = `${probe.out}\n${probe.err}`;
  let apiError = null;
  try { const j = JSON.parse(probe.out); apiError = j.api_error_status; } catch (_) {}
  const lim = parseLimit(text);
  const limited = lim.limited || apiError === 429 || /429/.test(String(apiError || ''));
  return { provider, usedPct: null, readable: false, limited, resetsInMin: lim.resetsInMin, raw: (limited ? text : 'not rate-limited').slice(0, 300) };
}

// Launch an autonomous session for `provider`, hidden in the background, teeing
// output to the provider's log. Auto-accepts permissions when asked.
function work({ provider = 'claude', prompt, cwd, autoAccept = true } = {}) {
  if (!prompt) throw new Error('work needs a prompt');
  if (!PROVIDERS[provider]) throw new Error(`unknown provider: ${provider}`);
  const fs = require('fs');
  const LOG = logPathFor(provider);
  const p = providerOf(provider);

  // Per-provider single-session lock.
  const busy = workBusy(provider);
  if (busy) {
    try { fs.appendFileSync(LOG, `\n[agent] a ${provider} session is already running (pid ${busy.pid}, ${busy.ageMin}m in) — skipping to avoid two sessions in one git tree.\n`); } catch (_) {}
    return { launched: false, busy: true, provider, pid: busy.pid, ageMin: busy.ageMin };
  }

  const workDir = cwd
    ? (path.isAbsolute(cwd) ? cwd : path.join(os.homedir(), cwd))
    : workFolderFor(provider);

  const flags = providerFlags(provider, autoAccept);
  const promptFile = path.join(os.tmpdir(), `bouchhub-handoff-${provider}-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
  try { fs.appendFileSync(LOG, `\n===== BouchHub ${provider} session started (${new Date().toISOString()}) =====\n`); } catch (_) {}

  const bin = _bins[provider] || process.env[p.binEnv] || p.cli;

  if (process.platform === 'win32') {
    // Build the CLI invocation with the prompt held in $p (a single argument —
    // avoids all quoting of a long multi-line prompt). Order: bin, subcmd, flags,
    // then the prompt LAST. .TrimEnd() the prompt so a trailing newline can't
    // truncate the command line and drop flags.
    const runExpr = ['&', bin, p.subcmd, flags, p.promptFlag, '$p'].filter(Boolean).join(' ');
    const display = ['&', bin.replace(/"/g, ''), p.subcmd, flags, p.promptFlag, '<prompt>'].filter(Boolean).join(' ');
    const psInner = [
      `$ErrorActionPreference='Continue'`,
      `Set-Location -LiteralPath '${workDir.replace(/'/g, "''")}'`,
      `$p = (Get-Content -Raw '${promptFile.replace(/'/g, "''")}').TrimEnd()`,
      `Write-Output "[launcher] running: ${display}"`,
      `${runExpr} 2>&1`,
      `Write-Output "[launcher] ${provider} exited with code $LASTEXITCODE"`,
    ].join('; ');
    // Full path to PowerShell (a background agent's PATH may not include it), and
    // NEVER detached (a detached PowerShell here starts, exits 0, runs nothing).
    const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const psFull = path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let psExe = 'powershell.exe';
    try { if (fs.existsSync(psFull)) psExe = psFull; } catch (_) {}
    try {
      fs.appendFileSync(LOG,
        `[agent] provider: ${provider}\n` +
        `[agent] resolved bin: ${bin}\n` +
        `[agent] powershell: ${psExe}\n` +
        `[agent] work dir: ${workDir}\n` +
        `[agent] spawning powershell to run ${provider}…\n`);
    } catch (_) {}
    let logFd = null;
    try { logFd = fs.openSync(LOG, 'a'); } catch (_) {}
    const child = spawn(psExe, ['-NoProfile', '-NonInteractive', '-Command', psInner],
      { stdio: ['ignore', logFd || 'ignore', logFd || 'ignore'], windowsHide: true });
    child.on('error', (e) => { try { fs.appendFileSync(LOG, `[agent] FAILED to spawn powershell: ${e.message}\n`); } catch (_) {} });
    child.on('spawn', () => {
      try { fs.appendFileSync(LOG, `[agent] powershell started (pid ${child.pid}).\n`); } catch (_) {}
      if (logFd != null) { try { fs.closeSync(logFd); } catch (_) {} }
    });
    _locks[provider] = { child, startedAt: Date.now(), pid: child.pid };
    child.on('exit', () => { if (_locks[provider] && _locks[provider].child === child) _locks[provider] = null; });
    child.unref();
    return { launched: true, provider, workDir, promptFile, logPath: LOG };
  }

  // Non-Windows dev fallback.
  const shRun = [bin, p.subcmd, flags, p.promptFlag, `"$(cat '${promptFile}')"`].filter(Boolean).join(' ');
  const child = spawn('sh', ['-c', `cd '${workDir}' && ${shRun} 2>&1 | tee -a '${LOG}'`], { detached: true, stdio: 'ignore' });
  _locks[provider] = { child, startedAt: Date.now(), pid: child.pid };
  child.on('exit', () => { if (_locks[provider] && _locks[provider].child === child) _locks[provider] = null; });
  child.unref();
  return { launched: true, provider, workDir, promptFile, logPath: LOG };
}

// Pre-flight: is the provider's CLI + its work folder ready?
async function preflight(provider = 'claude') {
  const fs = require('fs');
  const folder = workFolderFor(provider);
  const workFolderExists = fs.existsSync(folder);
  const workFolderIsRepo = workFolderExists && fs.existsSync(path.join(folder, '.git'));
  let hasClaude = false, claudeVersion = null;
  const bin = await resolveBin(provider);
  if (bin) {
    try {
      const r = await run(bin, ['--version'], { timeoutMs: 15000 });
      const v = `${r.out}`.trim().split('\n')[0];
      if (r.code === 0 && /\d/.test(v)) { hasClaude = true; claudeVersion = v; }
      else if (/[\\/]/.test(bin.replace(/"/g, ''))) { hasClaude = true; claudeVersion = 'installed (version check quiet)'; }
    } catch (_) {}
  }
  return {
    provider,
    hasClaude, claudeVersion, claudeBin: bin || null, claudeSearch: _search[provider] || [],
    workFolder: folder, workFolderExists, workFolderIsRepo, logPath: logPathFor(provider),
  };
}

function consoleTail(arg, maybeLines) {
  // Back-compat: consoleTail(lines) → claude; new: consoleTail(provider, lines).
  let provider = 'claude', lines = 250;
  if (typeof arg === 'string') { provider = arg; if (maybeLines != null) lines = maybeLines; }
  else if (arg != null) lines = arg;
  const fs = require('fs');
  const LOG = logPathFor(provider);
  try {
    if (!fs.existsSync(LOG)) return { provider, lines: [], note: 'No session output yet.' };
    const all = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
    return { provider, lines: all.slice(-Math.max(1, Math.min(lines, 1000))) };
  } catch (e) { return { provider, lines: [], note: e.message }; }
}

module.exports = {
  status, work, parseUsage, parseLimit, preflight, consoleTail,
  resolveBin, resolveClaude, PROVIDERS, logPathFor, workFolderFor, LOG_PATH,
};
