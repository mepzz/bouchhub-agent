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

async function status() {
  // `claude usage` isn't a stable subcommand across versions; try a couple of
  // ways and parse whatever prints. All are read-only.
  const attempts = [
    [CLAUDE_BIN, ['usage']],
    [CLAUDE_BIN, ['--print', '/usage']],
    [CLAUDE_BIN, ['-p', '"/usage"']],
  ];
  for (const [cmd, args] of attempts) {
    const r = await run(cmd, args, { timeoutMs: 30000 });
    const parsed = parseUsage(`${r.out}\n${r.err}`);
    if (parsed.usedPct != null) return parsed;
  }
  return { usedPct: null, resetsInMin: null, raw: 'could not read usage' };
}

// Launch a working session in its own terminal window, detached, so it keeps
// running after this request returns. Auto-accepts permissions when asked.
function work({ prompt, cwd, autoAccept = true } = {}) {
  if (!prompt) throw new Error('work needs a prompt');
  const workDir = cwd
    ? (path.isAbsolute(cwd) ? cwd : path.join(os.homedir(), cwd))
    : path.join(os.homedir(), 'Downloads', 'BouchHub2');

  const flags = [];
  if (autoAccept) flags.push('--dangerously-skip-permissions');

  // Pass the prompt via a temp file to avoid quoting nightmares, then open a
  // visible terminal running claude with that prompt.
  const fs = require('fs');
  const promptFile = path.join(os.tmpdir(), `bouchhub-handoff-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  if (process.platform === 'win32') {
    // Open a new PowerShell window, cd to the repo, pipe the handoff into claude.
    const psInner = `Set-Location -LiteralPath '${workDir}'; Get-Content -Raw '${promptFile}' | ${CLAUDE_BIN} ${flags.join(' ')}`;
    const child = spawn('powershell.exe', ['-NoExit', '-Command', psInner], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { launched: true, workDir, promptFile };
  }
  // Non-Windows dev fallback: run headless-ish in the background.
  const child = spawn('sh', ['-c', `cd '${workDir}' && cat '${promptFile}' | ${CLAUDE_BIN} ${flags.join(' ')}`], { detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true, workDir, promptFile };
}

module.exports = { status, work, parseUsage };
