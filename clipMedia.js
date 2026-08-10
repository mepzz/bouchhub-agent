// bouchhub-agent/clipMedia.js
//
// The media half of Clip Scanning: find the tools, rebuild a Steam recording
// into a playable MP4, and pull audio-first candidate moments out of it.
//
// Everything here is pure-ish and injectable so it can be unit-tested without
// ffmpeg present — the worker (clipWorker.js) owns the hub conversation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// ── Tool discovery ───────────────────────────────────────────────────────────
// The agent runs as SYSTEM, whose PATH is NOT the user's — a bare `ffmpeg` can
// fail even when it's installed. Search hard, and let local.config.json win.
function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;

  // 1. Machine-specific override (gitignored): {"ffmpegPath": "...", "ffprobePath": "..."}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'local.config.json'), 'utf8'));
    const key = `${name}Path`;
    if (cfg[key] && fs.existsSync(cfg[key])) return cfg[key];
  } catch (_) {}

  // 2. Explicit env override.
  const envKey = `${name.toUpperCase()}_BIN`;
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];

  // 3. PATH.
  try {
    execFileSync(name, ['-version'], { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    return name;
  } catch (_) {}

  // 4. WinGet's Gyan.FFmpeg package layout.
  try {
    const winget = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    for (const dir of fs.readdirSync(winget).filter(d => d.toLowerCase().startsWith('gyan.ffmpeg'))) {
      const dirPath = path.join(winget, dir);
      const sub = fs.readdirSync(dirPath).find(f => f.toLowerCase().startsWith('ffmpeg'));
      if (sub) {
        const bin = path.join(dirPath, sub, 'bin', exe);
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch (_) {}

  // 5. Common install locations.
  for (const c of [
    `C:\\ffmpeg\\bin\\${exe}`,
    `C:\\Program Files\\ffmpeg\\bin\\${exe}`,
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
    `/usr/bin/${name}`, `/usr/local/bin/${name}`,
  ]) if (fs.existsSync(c)) return c;

  return name; // let the spawn fail loudly rather than guessing further
}

let _ffmpeg = null, _ffprobe = null;
function ffmpegBin() { return _ffmpeg || (_ffmpeg = findTool('ffmpeg')); }
function ffprobeBin() { return _ffprobe || (_ffprobe = findTool('ffprobe')); }

function run(bin, args, { timeoutMs = 10 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''), stderr: String(stderr || ''),
      }));
  });
}

// Reports whether the pipeline can actually run — called at worker startup so a
// missing tool is a clear message instead of a mystery failure 10 clips in.
async function preflight() {
  const out = { ffmpeg: ffmpegBin(), ffprobe: ffprobeBin(), ok: true, problems: [] };
  for (const [name, bin] of [['ffmpeg', out.ffmpeg], ['ffprobe', out.ffprobe]]) {
    const r = await run(bin, ['-version'], { timeoutMs: 8000 });
    if (r.code !== 0) { out.ok = false; out.problems.push(`${name} not runnable (tried "${bin}")`); }
  }
  return out;
}

// ── Reconstruction ───────────────────────────────────────────────────────────
// Steam's clip folders vary by client version, so rather than assume one shape
// we INSPECT the folder and pick a strategy. The detected layout is reported
// back so the first real run tells us definitively what this client produces.
const SEG_EXT = /\.(m4s|m4v|mp4|cmfv|cmfa)$/i;

function inspectFolder(dir) {
  const walk = (d, depth = 0) => {
    let out = [];
    if (depth > 3) return out;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) out = out.concat(walk(full, depth + 1));
      else out.push(full);
    }
    return out;
  };
  const files = walk(dir);
  const manifest = files.find(f => /\.mpd$/i.test(f));
  const segments = files.filter(f => SEG_EXT.test(f));
  // An already-complete mp4 (not a fragment) — some clients just write one.
  const whole = files.find(f => /\.mp4$/i.test(f) && /(clip|video|output|session)/i.test(path.basename(f))
    && !/init/i.test(path.basename(f)));
  const inits = files.filter(f => /init/i.test(path.basename(f)));
  return {
    files, manifest: manifest || null, segments, inits, whole: whole || null,
    layout: manifest ? 'dash-manifest' : (segments.length > 1 ? 'segments' : (whole ? 'single-file' : 'unknown')),
  };
}

// Segments are numbered, and "10" must not sort before "9" — sort by the first
// integer in the name, with init segments always first.
function orderSegments(files) {
  // Strip the extension BEFORE looking for the sequence number — otherwise the
  // "4" in ".m4s" is picked up as the number and every segment sorts equal,
  // which would silently scramble the rebuilt video. Take the last number in the
  // stem, so "chunk-stream0-00042" reads as 42, not 0.
  const num = f => {
    const stem = path.basename(f, path.extname(f));
    const m = stem.match(/(\d+)/g);
    return m ? parseInt(m[m.length - 1], 10) : 0;
  };
  const inits = files.filter(f => /init/i.test(path.basename(f)));
  const rest = files.filter(f => !/init/i.test(path.basename(f))).sort((a, b) => num(a) - num(b));
  return [...inits, ...rest];
}

// Group segments into streams (video/audio) when the folder separates them, so
// each stream is concatenated on its own before being muxed together.
function groupStreams(segments) {
  const groups = {};
  for (const s of segments) {
    const rel = s.toLowerCase();
    const key = /audio|\baud\b|\.cmfa|_a_|track1/.test(rel) ? 'audio'
      : /video|\bvid\b|\.cmfv|_v_|track0/.test(rel) ? 'video'
        : path.dirname(s);
    (groups[key] = groups[key] || []).push(s);
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, orderSegments(v)]));
}

// Rebuild `folder` into a single MP4 at `outPath`. Never touches the source.
async function reconstruct(folder, outPath, { ffmpeg = ffmpegBin(), onLog } = {}) {
  const info = inspectFolder(folder);
  const log = m => { if (onLog) onLog(m); };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  log(`layout=${info.layout} files=${info.files.length} segments=${info.segments.length}`);

  if (info.layout === 'dash-manifest') {
    const r = await run(ffmpeg, ['-y', '-i', info.manifest, '-c', 'copy', outPath]);
    if (r.code === 0 && fs.existsSync(outPath)) return { ok: true, strategy: 'mpd-remux', info };
    log(`mpd remux failed: ${tail(r.stderr)}`);
  }

  if (info.layout === 'single-file') {
    const r = await run(ffmpeg, ['-y', '-i', info.whole, '-c', 'copy', outPath]);
    if (r.code === 0 && fs.existsSync(outPath)) return { ok: true, strategy: 'single-remux', info };
    log(`single-file remux failed: ${tail(r.stderr)}`);
  }

  if (info.segments.length) {
    const streams = groupStreams(info.segments);
    const keys = Object.keys(streams);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcat-'));
    try {
      // Byte-concatenate each stream's segments (init first), then mux. Raw
      // concatenation is correct for fragmented MP4: the init segment carries
      // the moov and each fragment is self-describing.
      const parts = [];
      for (const k of keys) {
        const joined = path.join(tmp, `${sanitize(k)}.mp4`);
        const out = fs.createWriteStream(joined);
        for (const seg of streams[k]) out.write(fs.readFileSync(seg));
        out.end();
        await new Promise(res => out.on('close', res));
        parts.push(joined);
      }
      const args = ['-y'];
      for (const p of parts) args.push('-i', p);
      // Map every input's streams into one file.
      parts.forEach((_, i) => args.push('-map', String(i)));
      args.push('-c', 'copy', outPath);
      const r = await run(ffmpeg, args);
      if (r.code === 0 && fs.existsSync(outPath)) {
        return { ok: true, strategy: parts.length > 1 ? 'segment-concat-mux' : 'segment-concat', info };
      }
      log(`segment concat failed: ${tail(r.stderr)}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return {
    ok: false, strategy: null, info,
    error: `could not reconstruct (layout=${info.layout}). Files seen: ` +
      info.files.slice(0, 12).map(f => path.basename(f)).join(', ') + (info.files.length > 12 ? ' …' : ''),
  };
}

function sanitize(s) { return String(s).replace(/[^a-z0-9]+/gi, '_').slice(-40); }
function tail(s, n = 400) { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; }

async function probeDuration(file, { ffprobe = ffprobeBin() } = {}) {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeoutMs: 60000 });
  const d = parseFloat(String(r.stdout).trim());
  return Number.isFinite(d) ? d : null;
}

async function extractAudio(video, wavOut, { ffmpeg = ffmpegBin() } = {}) {
  fs.mkdirSync(path.dirname(wavOut), { recursive: true });
  const r = await run(ffmpeg, ['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wavOut]);
  return { ok: r.code === 0 && fs.existsSync(wavOut), stderr: tail(r.stderr) };
}

// ── Audio-first detection ────────────────────────────────────────────────────
// Per-window loudness via ffmpeg's astats. Returns [{t, rms}] at `windowS`
// resolution — the raw signal the peak finder works on.
async function loudnessTrack(wav, { ffmpeg = ffmpegBin(), windowS = 0.5 } = {}) {
  const r = await run(ffmpeg, ['-i', wav, '-af',
    `astats=metadata=1:reset=${Math.max(1, Math.round(windowS * 16000 / 1024))},ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    '-f', 'null', '-'], { timeoutMs: 15 * 60 * 1000 });
  const out = [];
  const re = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.inf]+)/g;
  let m;
  const text = `${r.stdout}\n${r.stderr}`;
  while ((m = re.exec(text)) !== null) {
    const t = parseFloat(m[1]);
    const db = parseFloat(m[2]);
    if (Number.isFinite(t)) out.push({ t, db: Number.isFinite(db) ? db : -90 });
  }
  return out;
}

// Find moments that rise sharply above a ROLLING baseline — that's what a
// laughter burst or a group reaction looks like, and it adapts to clips that are
// loud or quiet overall instead of using one global threshold.
//
// Pure function over the loudness track, so it's unit-testable with no audio.
function findPeaks(track, {
  padBeforeS = 2, padAfterS = 2, minLenS = 7, maxLenS = 30,
  baselineWindowS = 20, thresholdDb = 6, durationS = null,
} = {}) {
  if (!track || track.length < 3) return [];
  const times = track.map(p => p.t);
  const step = Math.max(0.05, (times[times.length - 1] - times[0]) / Math.max(1, track.length - 1));
  const halfWin = Math.max(1, Math.round((baselineWindowS / step) / 2));

  // Rolling median baseline (median, not mean, so one loud burst doesn't raise
  // the bar against itself).
  const excess = track.map((p, i) => {
    const lo = Math.max(0, i - halfWin), hi = Math.min(track.length, i + halfWin);
    const window = track.slice(lo, hi).map(x => x.db).sort((a, b) => a - b);
    const med = window[Math.floor(window.length / 2)];
    return { t: p.t, db: p.db, over: p.db - med };
  });

  // Contiguous runs above threshold become raw moments.
  const runs = [];
  let cur = null;
  for (const e of excess) {
    if (e.over >= thresholdDb) {
      if (!cur) cur = { start: e.t, end: e.t, peak: e.over, sum: e.over, n: 1 };
      else { cur.end = e.t; cur.peak = Math.max(cur.peak, e.over); cur.sum += e.over; cur.n++; }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  if (!runs.length) return [];

  // Pad, clamp to the clip, enforce the short-form length window.
  const maxT = durationS != null ? durationS : times[times.length - 1];
  const padded = runs.map(r => {
    let start = Math.max(0, r.start - padBeforeS);
    let end = Math.min(maxT, r.end + padAfterS);
    if (end - start < minLenS) {
      const grow = (minLenS - (end - start)) / 2;
      start = Math.max(0, start - grow);
      end = Math.min(maxT, end + grow);
    }
    if (end - start > maxLenS) end = start + maxLenS;
    // Normalize peak strength into 0..1 for the score blend.
    return { start_s: round2(start), end_s: round2(end), audio_score: round2(Math.min(1, r.peak / 20)), trigger: 'audio_peak' };
  }).filter(r => r.end_s - r.start_s >= Math.min(minLenS, 1));

  return mergeOverlaps(padded, maxLenS);
}

// Overlapping windows are one moment, not several — but never merge past the
// max clip length, or two nearby laughs would fuse into an unpostable blob.
function mergeOverlaps(list, maxLenS = 30) {
  const sorted = [...list].sort((a, b) => a.start_s - b.start_s);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start_s <= last.end_s && (Math.max(last.end_s, c.end_s) - last.start_s) <= maxLenS) {
      last.end_s = Math.max(last.end_s, c.end_s);
      last.audio_score = Math.max(last.audio_score, c.audio_score);
    } else out.push({ ...c });
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Cut a candidate into its own file. Tries stream-copy first (fast) and falls
// back to a re-encode when keyframe alignment makes the copy imprecise —
// an empty or badly-truncated output is the tell.
async function cutClip(source, start, end, outPath, { ffmpeg = ffmpegBin(), forceEncode = false } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dur = Math.max(0.1, end - start);
  if (!forceEncode) {
    const r = await run(ffmpeg, ['-y', '-ss', String(start), '-i', source, '-t', String(dur), '-c', 'copy', outPath]);
    if (r.code === 0 && fs.existsSync(outPath)) {
      const got = await probeDuration(outPath);
      // Accept the copy only if it's close to what we asked for.
      if (got != null && got >= dur * 0.6) return { ok: true, mode: 'copy', duration: got };
    }
  }
  const r2 = await run(ffmpeg, ['-y', '-ss', String(start), '-i', source, '-t', String(dur),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'aac', outPath]);
  if (r2.code === 0 && fs.existsSync(outPath)) return { ok: true, mode: 'encode', duration: await probeDuration(outPath) };
  return { ok: false, error: tail(r2.stderr) };
}

async function thumbnail(video, outPath, { ffmpeg = ffmpegBin(), atS = null } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dur = atS != null ? atS : ((await probeDuration(video)) || 2) / 2;
  const r = await run(ffmpeg, ['-y', '-ss', String(dur), '-i', video, '-frames:v', '1', outPath]);
  return r.code === 0 && fs.existsSync(outPath);
}

module.exports = {
  findTool, ffmpegBin, ffprobeBin, preflight, run,
  inspectFolder, orderSegments, groupStreams, reconstruct,
  probeDuration, extractAudio, loudnessTrack, findPeaks, mergeOverlaps,
  cutClip, thumbnail,
};
