// bouchhub-agent/claude.js
//
// Drives the Claude Code CLI on this machine, using the owner's Claude Max
// subscription. Two jobs:
//   • status() — read how much of the current Max session is used, and when it
//     resets, from the CLI's own usage output.
//   • work()   — launch a detached Claude Code session in a terminal window,
//     hand it a prompt, and let it run auto-accepting permissions.
//
// Reading usage: `claude` exposes usage via its `/usage` state. We ask it in a
// tiny non-interactive run and parse the "x% used … resets in y" line. Output
// formats drift, so parsing is defensive and returns nulls it can't read.

const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Autopilot work sessions tee their output here so the hub can show a console.
const LOG_PATH = path.join(os.tmpdir(), 'bouchhub-autopilot.log');
const WORK_FOLDER = path.join(os.homedir(), 'Downloads', 'BouchHub2');

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

// Quote a path for a shell command when it contains spaces.
function q(p) { return /\s/.test(p) && !/^".*"$/.test(p) ? `"${p}"` : p; }

// ─── Locate the Claude Code CLI ──────────────────────────────────────────────
// A background agent doesn't always inherit the interactive shell's PATH, so
// `claude` alone can fail even when it's installed. Search hard: PATH, then
// `where`/`which`, then the common install locations, and remember what worked.
let _claudeBin = null;
let _claudeSearch = [];
function claudeCandidates() {
  const home = os.homedir();
  const A = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const L = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [CLAUDE_BIN];
  if (process.platform === 'win32') {
    list.push('claude.cmd', 'claude.exe',
      path.join(A, 'npm', 'claude.cmd'),
      path.join(A, 'npm', 'claude.ps1'),
      path.join(L, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    );
  } else {
    list.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude',
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'));
  }
  return [...new Set(list.filter(Boolean))];
}
async function resolveClaude() {
  if (_claudeBin) return _claudeBin;
  _claudeSearch = [];
  const fs = require('fs');
  // 1) `where claude` (win) / `which claude` — respects the process PATH.
  //    On Windows `where` can list several matches; prefer the EXECUTABLE shim
  //    (.cmd/.exe) over the extensionless Node launcher, which can't be run
  //    directly (that produced "opens a script but doesn't run it").
  try {
    const r = await run(process.platform === 'win32' ? 'where' : 'which', ['claude'], { timeoutMs: 8000 });
    const lines = `${r.out}`.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const best = process.platform === 'win32'
      ? (lines.find(l => /\.cmd$/i.test(l)) || lines.find(l => /\.exe$/i.test(l)) || lines.find(l => /\.bat$/i.test(l)) || lines[0])
      : lines[0];
    _claudeSearch.push(`where/which → ${r.code === 0 && best ? best : 'not found'}`);
    if (r.code === 0 && best) { _claudeBin = q(best); return _claudeBin; }
  } catch (e) { _claudeSearch.push(`where/which errored: ${e.message}`); }
  // 2) Known full-path candidates that exist on disk.
  for (const bin of claudeCandidates()) {
    if (bin.includes(path.sep) || /[\\/]/.test(bin)) {
      try { if (fs.existsSync(bin)) { _claudeSearch.push(`found file: ${bin}`); _claudeBin = q(bin); return _claudeBin; } } catch (_) {}
    }
  }
  // 3) Last resort: try `--version` on each bare candidate (PATH-dependent).
  for (const bin of claudeCandidates()) {
    try {
      const r = await run(q(bin), ['--version'], { timeoutMs: 10000 });
      if (r.code === 0 && /\d/.test(`${r.out}`)) { _claudeSearch.push(`ran: ${bin}`); _claudeBin = q(bin); return _claudeBin; }
    } catch (_) {}
  }
  _claudeSearch.push('exhausted all known locations');
  return null;
}

// Parse a usage blob into { usedPct, resetsInMin }. Handles a few phrasings:
//   "You've used 73% of your current session"
//   "Session usage: 98% (resets in 2h 15m)"
//   "resets at 3:00 PM"  → approximate minutes from now
function parseUsage(text) {
  const t = (text || '').replace(/\[[0-9;]*m/g, ''); // strip ANSI colour
  let usedPct = null, resetsInMin = null;

  const pct = t.match(/(\d{1,3})\s*%\s*(?:of|used|used\b)/i) || t.match(/used\D{0,12}(\d{1,3})\s*%/i) || t.match(/(\d{1,3})\s*%/);
  if (pct) { const n = parseInt(pct[1], 10); if (n >= 0 && n <= 100) usedPct = n; }

  // "resets in 2h 15m", "resets in 45m", "resets in 2h"
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

// Detect a "usage limit reached / rate limited" message and its reset time.
function parseLimit(text) {
  const t = (text || '').replace(/\[[0-9;]*m/g, '');
  const limited = /usage limit|rate.?limit|limit reached|limit will reset|you(?:'ve| have) reached/i.test(t);
  if (!limited) return { limited: false, resetsInMin: null };
  const { resetsInMin } = parseUsage(t);
  return { limited: true, resetsInMin };
}

// Report whether Autopilot may run right now.
//   usedPct     — the Max session % if we can read it (usually null: the CLI
//                 only shows it in the interactive /usage panel, not to scripts)
//   limited     — Claude is currently rate-limited (hard stop)
//   resetsInMin — when the limit lifts, if known
// Because the exact % isn't scriptable, the hub gates on `limited`: run when
// not limited, wait for the reset when we are.
async function status() {
  const bin = await resolveClaude();
  if (!bin) return { usedPct: null, resetsInMin: null, limited: false, readable: false, raw: 'Claude Code not found on this PC' };

  // 1) Best-effort read of the session % (works only if a future CLI exposes it).
  let usedPct = null, resetsInMin = null, raw = '';
  for (const args of [['-p', '/usage'], ['usage']]) {
    const r = await run(bin, args, { timeoutMs: 30000 });
    raw = `${r.out}\n${r.err}`.trim();
    const p = parseUsage(raw);
    if (p.usedPct != null) { usedPct = p.usedPct; resetsInMin = p.resetsInMin; break; }
  }
  if (usedPct != null) return { usedPct, resetsInMin, limited: usedPct >= 100, readable: true, raw: raw.slice(0, 300) };

  // 2) No %: probe whether we're rate-limited right now with a tiny request.
  const probe = await run(bin, ['-p', 'ok', '--output-format', 'json'], { timeoutMs: 45000 });
  const text = `${probe.out}\n${probe.err}`;
  let apiError = null;
  try { const j = JSON.parse(probe.out); apiError = j.api_error_status; } catch (_) {}
  const lim = parseLimit(text);
  const limited = lim.limited || apiError === 429 || /429/.test(String(apiError || ''));
  return {
    usedPct: null, readable: false, limited,
    resetsInMin: lim.resetsInMin,
    raw: (limited ? text : 'not rate-limited').slice(0, 300),
  };
}

// Launch a working session in its own terminal window, detached, so it keeps
// running after this request returns. Auto-accepts permissions when asked.
function work({ prompt, cwd, autoAccept = true } = {}) {
  if (!prompt) throw new Error('work needs a prompt');
  const workDir = cwd
    ? (path.isAbsolute(cwd) ? cwd : path.join(os.homedir(), cwd))
    : path.join(os.homedir(), 'Downloads', 'BouchHub2');

  // Run as a full autonomous task: `-p` (print mode) runs the complete agentic
  // loop — reads the handoff, edits, runs tools, commits, pushes — then exits,
  // instead of dropping into an interactive session that does one turn. Verbose
  // so the tee'd console shows what it's doing.
  const flags = ['-p', '--verbose'];
  if (autoAccept) flags.push('--dangerously-skip-permissions');

  // Pass the prompt via a temp file to avoid quoting nightmares.
  const fs = require('fs');
  const promptFile = path.join(os.tmpdir(), `bouchhub-handoff-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  // Stamp a session header so the console view shows when each run started.
  try { fs.appendFileSync(LOG_PATH, `\n===== BouchHub session started (${new Date().toISOString()}) =====\n`); } catch (_) {}

  // Not awaited above (work is sync), but resolveClaude caches after preflight;
  // fall back to the bare command if it hasn't been resolved yet.
  const bin = _claudeBin || CLAUDE_BIN;
  if (process.platform === 'win32') {
    // Run an agentic `claude -p` and TEE its output to a log the Bot console
    // reads. We run PowerShell HIDDEN in the background (no window): the agent
    // may run in a headless/disconnected session where a window can't render,
    // and the owner monitors via the Bot console anyway.
    // NOTE: PowerShell needs the call operator `&` to EXECUTE a command given
    // as a quoted path/variable — without it, a quoted path is just printed and
    // claude never runs.
    //
    // We log the resolved binary, wrap the run in try/catch, and record the exit
    // code — so if claude fails to START (bad path, not logged in, crash on
    // launch) the Bot console shows WHY instead of just the session header. A
    // launch error is a PowerShell statement error that a bare `2>&1` pipe would
    // miss, which is exactly the "stops at the header" symptom.
    // Pass the handoff as an ARGUMENT, not via stdin. Piping the prompt into
    // `claude -p` on stdin is unreliable here (claude warns "no stdin data
    // received in 3s, proceeding without it" and runs with an empty prompt) —
    // whereas `claude -p "<prompt>"` works. We read the file into a PowerShell
    // variable (avoids all command-line quoting of a long multi-line prompt,
    // since $p expands to a single argument) and hand it to claude directly.
    const tailFlags = flags.filter(f => f !== '-p').join(' '); // --verbose [--dangerously-skip-permissions]
    // Keep the script SIMPLE (no Tee-Object, no try/catch): we redirect the
    // whole PowerShell process's stdout+stderr into the log from Node (below),
    // so claude's output AND any PowerShell parse/startup error land in the log.
    // Write-Output goes to stdout → the log fd.
    //
    // TWO subtle bugs, both found with isolated repros on the target machine:
    //  1) $p = Get-Content -Raw keeps the file's TRAILING NEWLINE. When
    //     PowerShell hands $p to the claude.cmd shim, that newline terminates
    //     the command line and everything AFTER the prompt (the flags) is
    //     dropped — so --dangerously-skip-permissions never applied, claude ran
    //     in default mode, waited for an Edit approval nobody could give, and
    //     exited without committing. Fix: .TrimEnd() the prompt, AND put the
    //     flags BEFORE '-p $p' so nothing important can be truncated.
    const psInner = [
      `$ErrorActionPreference='Continue'`,
      `Set-Location -LiteralPath '${workDir.replace(/'/g, "''")}'`,
      `$p = (Get-Content -Raw '${promptFile.replace(/'/g, "''")}').TrimEnd()`,
      `Write-Output "[launcher] running: ${bin.replace(/"/g, '')} ${tailFlags} -p <prompt>"`,
      `& ${bin} ${tailFlags} -p $p 2>&1`,
      `Write-Output "[launcher] claude exited with code $LASTEXITCODE"`,
    ].join('; ');
    // Call PowerShell by its FULL path. A background agent (e.g. spawned by the
    // Electron app) doesn't always inherit a PATH that includes the PowerShell
    // folder, so bare 'powershell.exe' can fail ENOENT and die silently.
    const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const psFull = path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let psExe = 'powershell.exe';
    try { if (fs.existsSync(psFull)) psExe = psFull; } catch (_) {}
    try {
      fs.appendFileSync(LOG_PATH,
        `[agent] resolved claude bin: ${bin}\n` +
        `[agent] powershell: ${psExe}\n` +
        `[agent] work dir: ${workDir}\n` +
        `[agent] spawning powershell to run claude…\n`);
    } catch (_) {}
    // Redirect the child's stdout+stderr straight to the log file so claude's
    // output AND any PowerShell error land there.
    //
    //  2) DO NOT use detached:true here. On the target machine, a PowerShell
    //     spawned from Node with detached:true starts, exits 0, and executes
    //     NOTHING — not even a single Set-Content — which was the entire
    //     "log stops at the header" symptom (cmd.exe works detached; PowerShell
    //     does not). windowsHide:true alone runs it hidden, and the fd redirect
    //     captures everything. unref() still lets the agent not wait on it.
    let logFd = null;
    try { logFd = fs.openSync(LOG_PATH, 'a'); } catch (_) {}
    const child = spawn(psExe, ['-NoProfile', '-NonInteractive', '-Command', psInner],
      { stdio: ['ignore', logFd || 'ignore', logFd || 'ignore'], windowsHide: true });
    child.on('error', (e) => {
      try { fs.appendFileSync(LOG_PATH, `[agent] FAILED to spawn powershell: ${e.message}\n`); } catch (_) {}
    });
    child.on('spawn', () => {
      try { fs.appendFileSync(LOG_PATH, `[agent] powershell started (pid ${child.pid}).\n`); } catch (_) {}
      // The child has its own duplicated handle now; release ours so repeated
      // runs don't leak file descriptors.
      if (logFd != null) { try { fs.closeSync(logFd); } catch (_) {} }
    });
    child.unref();
    return { launched: true, workDir, promptFile, logPath: LOG_PATH };
  }
  // Non-Windows dev fallback: pass the prompt as an argument too (same reason as
  // above), reading it from the file so we don't have to quote it on the CLI.
  const tail = flags.filter(f => f !== '-p').join(' ');
  const child = spawn('sh', ['-c', `cd '${workDir}' && ${bin} ${tail} -p "$(cat '${promptFile}')" 2>&1 | tee -a '${LOG_PATH}'`], { detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true, workDir, promptFile, logPath: LOG_PATH };
}

// Pre-flight: is everything needed to run Autopilot actually present on this PC?
async function preflight() {
  const fs = require('fs');
  const workFolderExists = fs.existsSync(WORK_FOLDER);
  // A pushable clone needs a .git dir — an empty/regular folder can't commit.
  const workFolderIsRepo = workFolderExists && fs.existsSync(path.join(WORK_FOLDER, '.git'));
  let hasClaude = false, claudeVersion = null;
  const bin = await resolveClaude();
  if (bin) {
    try {
      const r = await run(bin, ['--version'], { timeoutMs: 15000 });
      const v = `${r.out}`.trim().split('\n')[0];
      if (r.code === 0 && /\d/.test(v)) { hasClaude = true; claudeVersion = v; }
      else if (/[\\/]/.test(bin.replace(/"/g, ''))) { hasClaude = true; claudeVersion = 'installed (version check quiet)'; }
    } catch (_) {}
  }
  return {
    hasClaude, claudeVersion, claudeBin: bin || null, claudeSearch: _claudeSearch,
    workFolder: WORK_FOLDER, workFolderExists, workFolderIsRepo, logPath: LOG_PATH,
  };
}

// Recent console output of the work sessions (tail of the tee'd log).
function consoleTail(lines = 250) {
  const fs = require('fs');
  try {
    if (!fs.existsSync(LOG_PATH)) return { lines: [], note: 'No session output yet.' };
    const all = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/);
    return { lines: all.slice(-Math.max(1, Math.min(lines, 1000))) };
  } catch (e) { return { lines: [], note: e.message }; }
}

module.exports = { status, work, parseUsage, parseLimit, preflight, consoleTail, LOG_PATH };
