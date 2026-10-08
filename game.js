// bouchhub-agent/game.js
//
// "Is Alex playing a game right now?" — for the hub's game mode, which pauses
// all background work (card checks, agents, local AI, the voice worker) while
// a game is running, and brings it back when the game closes.
//
// One PowerShell sample gives the foreground window (process, path, title,
// whether it covers its monitor), Windows' own notification state (3 means a
// full-screen exclusive Direct3D app), and every process with a window. The
// verdict is `classify()`, kept pure so test/game.test.js runs under plain node:
//
//   • a known game, or anything run from a game library folder (Steam, Epic,
//     Riot, Xbox, EA, Ubisoft, GOG, Rockstar), in the foreground — sure;
//   • a full-screen exclusive Direct3D app in the foreground — sure;
//   • a borderless full-screen window with the GPU busy — likely (the hub wants
//     to see it twice in a row before acting on it).
//
// Browsers, video players, editors, launchers and the like never count, so a
// full-screen YouTube video or the Unity editor does not switch game mode on.
// The hub keeps game mode on while the game's process is still alive, so
// alt-tabbing out of a game does not end it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const norm = (n) => String(n || '').toLowerCase().replace(/\.exe$/, '').trim();

// Process names (lower case, no .exe) that are games whatever folder they run from.
const KNOWN_GAMES = new Set([
  'valorant', 'valorant-win64-shipping', 'league of legends', 'fortniteclient-win64-shipping', 'rocketleague',
  'cs2', 'csgo', 'dota2', 'r5apex', 'r5apex_dx12', 'overwatch', 'cod', 'cod24', 'blackops6', 'modernwarfare',
  'eldenring', 'gta5', 'gta5_enhanced', 'playgtav', 'rdr2', 'minecraft.windows', 'robloxplayerbeta',
  'fc25', 'fc26', 'destiny2', 'tslgame', 'marvel-win64-shipping', 'helldivers2', 'bg3', 'bg3_dx11',
  'cyberpunk2077', 'witcher3', 'starfield', 'palworld-win64-shipping', 'deadbydaylight-win64-shipping',
  'rainbowsix', 'rainbowsix_be', 'rainbowsix_vulkan', 'escapefromtarkov', 'discovery', 'forzahorizon5',
  'forzahorizon4', 'rustclient', 'nba2k25', 'nba2k26', 'madden25', 'madden26', 'thefinals',
]);

// Never a game, even full screen, even from a game folder.
const NOT_GAMES = new Set([
  'explorer', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'applicationframehost', 'lockapp',
  'textinputhost', 'photos', 'microsoft.photos', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
  'discord', 'spotify', 'vlc', 'mpc-hc64', 'mpc-be64', 'wmplayer', 'potplayermini64', 'netflix', 'obs64', 'obs32',
  'code', 'devenv', 'rider64', 'idea64', 'pycharm64', 'unity', 'unityhub', 'blender', 'photoshop', 'afterfx',
  'adobe premiere pro', 'resolve', 'windowsterminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'taskmgr',
  'steam', 'steamwebhelper', 'epicgameslauncher', 'epicwebhelper', 'battle.net', 'eadesktop', 'origin',
  'riotclientservices', 'riotclientux', 'riotclientuxrender', 'leagueclient', 'leagueclientux',
  'leagueclientuxrender', 'upc', 'ubisoftconnect', 'galaxyclient', 'rockstarlauncher', 'xboxpcapp', 'gamebar',
  'overwolf', 'wallpaper32', 'wallpaper64', 'losslessscaling', 'nvidia app', 'nvcontainer', 'msiafterburner',
  'rtss', 'rainmeter', 'aida64', 'hwinfo64', 'vrmonitor', 'vrserver', 'vrcompositor', 'vrdashboard',
  'unitycrashhandler64', 'crashreportclient', 'easyanticheat', 'easyanticheat_eos', 'beservice',
  'electron', 'bouchhub agent', 'claude', 'codex', 'node', 'python', 'pythonw', 'ffmpeg',
]);

const GAME_DIR = /\\steamapps\\common\\|\\epic games\\|\\riot games\\|\\xboxgames\\|\\ea games\\|\\ubisoft game launcher\\games\\|\\gog galaxy\\games\\|\\rockstar games\\/i;

const D3D_FULL_SCREEN = 3;   // SHQueryUserNotificationState: QUNS_RUNNING_D3D_FULL_SCREEN
const BUSY_GPU_PCT = 60;

function gameReason(p) {
  const name = norm(p && p.name);
  if (!name || NOT_GAMES.has(name)) return null;
  if (KNOWN_GAMES.has(name)) return 'known game';
  if (name === 'javaw' && /minecraft/i.test(p.title || '')) return 'known game';
  if (GAME_DIR.test(String(p.path || ''))) return 'game library folder';
  return null;
}

// sample: { fg: {pid,name,path,title,fullscreen}, quns, windows: [{pid,name,path,title}] }
// → { game: {pid,name,title,reason,sure} | null, pids: [every windowed process] }
function classify(sample, { gpuUsage = null } = {}) {
  const s = sample || {};
  const fg = s.fg && s.fg.pid ? s.fg : null;
  let game = null;
  if (fg && !NOT_GAMES.has(norm(fg.name))) {
    const why = gameReason(fg);
    const at = (reason, sure) => ({ pid: Number(fg.pid), name: norm(fg.name), title: String(fg.title || '').slice(0, 120), reason, sure });
    if (why) game = at(why, true);
    else if (Number(s.quns) === D3D_FULL_SCREEN) game = at('full-screen Direct3D', true);
    else if (fg.fullscreen && Number(gpuUsage) >= BUSY_GPU_PCT) game = at(`full screen with the GPU at ${Number(gpuUsage)}%`, false);
  }
  const windows = Array.isArray(s.windows) ? s.windows : (s.windows ? [s.windows] : []);
  const pids = [...new Set(windows.map((w) => Number(w && w.pid)).filter(Boolean).concat(fg ? [Number(fg.pid)] : []))];
  return { game, pids };
}

const PS1 = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BHGame {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@
$h = [BHGame]::GetForegroundWindow()
[uint32]$fpid = 0; [void][BHGame]::GetWindowThreadProcessId($h, [ref]$fpid)
$r = New-Object BHGame+RECT; [void][BHGame]::GetWindowRect($h, [ref]$r)
$b = [System.Windows.Forms.Screen]::FromHandle($h).Bounds
$full = ($r.L -le $b.X) -and ($r.T -le $b.Y) -and ($r.R -ge ($b.X + $b.Width)) -and ($r.B -ge ($b.Y + $b.Height))
[int]$q = 0; [void][BHGame]::SHQueryUserNotificationState([ref]$q)
$fp = Get-Process -Id $fpid
$wins = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; path = $_.Path; title = $_.MainWindowTitle } })
@{ fg = @{ pid = [int]$fpid; name = $fp.ProcessName; path = $fp.Path; title = $fp.MainWindowTitle; fullscreen = [bool]$full }; quns = $q; windows = $wins } | ConvertTo-Json -Compress -Depth 4
`;

let _ps1 = null;
function sample({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve(null);
    try {
      if (!_ps1) { _ps1 = path.join(os.tmpdir(), 'bouchhub-game-sample.ps1'); fs.writeFileSync(_ps1, PS1); }
    } catch (e) { return reject(e); }
    exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${_ps1}"`,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (!out) return reject(new Error(err ? err.message : 'no output from the game check'));
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`unreadable game check output: ${e.message}`)); }
      });
  });
}

// What /game answers.
async function detect({ gpuUsage = null } = {}) {
  const s = await sample();
  if (!s) return { supported: false, game: null, pids: [] };
  const { game, pids } = classify(s, { gpuUsage });
  return { supported: true, game, pids, foreground: s.fg ? { name: norm(s.fg.name), fullscreen: !!s.fg.fullscreen } : null, gpuUsage };
}

module.exports = { classify, detect, gameReason, KNOWN_GAMES, NOT_GAMES, GAME_DIR, BUSY_GPU_PCT };
