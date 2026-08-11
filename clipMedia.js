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

// ── Python discovery ─────────────────────────────────────────────────────────
// The agent runs as SYSTEM. `pip install` run from a normal PowerShell window
// installs into THAT user's site-packages, which SYSTEM cannot see — and SYSTEM's
// PATH often has no `python` at all. So "faster-whisper isn't installed" is
// usually "it's installed, for a different account".
//
// Rather than assume one interpreter, enumerate the plausible ones and pick the
// first that can actually import the package.
function pythonCandidates() {
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  add(process.env.PYTHON_BIN);
  add('python'); add('python3');
  if (process.platform === 'win32') {
    // Per-user installs (the usual case) live under each user's profile, and
    // SYSTEM's homedir is NOT the logged-in user's — so scan C:\Users directly.
    try {
      for (const user of fs.readdirSync('C:\\Users')) {
        const base = path.join('C:\\Users', user, 'AppData', 'Local', 'Programs', 'Python');
        try {
          for (const v of fs.readdirSync(base)) add(path.join(base, v, 'python.exe'));
        } catch (_) {}
      }
    } catch (_) {}
    // Machine-wide installs.
    for (const root of ['C:\\', 'C:\\Program Files\\']) {
      try {
        for (const d of fs.readdirSync(root)) {
          if (/^python\d/i.test(d)) add(path.join(root, d, 'python.exe'));
        }
      } catch (_) {}
    }
  }
  return out;
}

let _python = null;
// Returns { bin, ok, tried } — the first interpreter that can import `mod`.
async function findPython(mod = 'faster_whisper') {
  if (_python && _python.ok) return _python;
  const tried = [];
  for (const bin of pythonCandidates()) {
    const r = await run(bin, ['-c', `import ${mod}; print("ok")`], { timeoutMs: 45000 });
    const ok = r.code === 0 && /ok/.test(r.stdout);
    tried.push({ bin, ok, why: ok ? null : tail(r.stderr || 'not runnable', 120) });
    if (ok) { _python = { bin, ok: true, tried }; return _python; }
  }
  _python = { bin: process.env.PYTHON_BIN || 'python', ok: false, tried };
  return _python;
}
function pythonBin() { return (_python && _python.ok) ? _python.bin : (process.env.PYTHON_BIN || 'python'); }

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
  const out = { ffmpeg: ffmpegBin(), ffprobe: ffprobeBin(), ok: true, problems: [], warnings: [] };
  for (const [name, bin] of [['ffmpeg', out.ffmpeg], ['ffprobe', out.ffprobe]]) {
    const r = await run(bin, ['-version'], { timeoutMs: 8000 });
    if (r.code !== 0) { out.ok = false; out.problems.push(`${name} not runnable (tried "${bin}")`); }
  }
  // Transcription is a WARNING, not a blocker: without it the pipeline still
  // finds moments by audio energy, it just can't tell you what was said — and
  // every score then reads "no speech in the window", which looks like a bug
  // rather than a missing dependency. Surface it explicitly.
  const py = await findPython('faster_whisper');
  out.python = py.bin;
  out.whisper = py.ok;
  out.pythonTried = py.tried;
  if (!out.whisper) {
    // Name every interpreter that was tried. "Not installed" is almost always
    // "installed for your user, not for the SYSTEM account the agent runs as",
    // and without the list that is impossible to tell apart from a real absence.
    const list = py.tried.length
      ? py.tried.map(t => `${t.bin} (${t.why})`).join('; ')
      : 'no python interpreter found at all';
    out.warnings.push(
      `faster-whisper could not be imported by any Python this agent can see, so clips will be picked from audio energy only, ` +
      `with no transcript. Tried: ${list}. ` +
      `NOTE: the agent runs as SYSTEM, so a "pip install" from your own PowerShell window installs somewhere it cannot reach. ` +
      `Fix by installing for all users (an elevated: "<python> -m pip install faster-whisper") or by setting PYTHON_BIN in the agent's .env ` +
      `to the full path of a python.exe that already has it.`);
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

// Group segments into streams so each is concatenated on its own before being
// muxed together.
//
// Steam Game Recording writes MPEG-DASH:  init-stream<N>.m4s  +
// chunk-stream<N>-#####.m4s, where N is the stream index (0 = video, 1 = audio,
// typically). Grouping by that index is what keeps the video and audio chunks
// from being concatenated into each other — the earlier heuristic looked for the
// words "video"/"audio" in the path, which these filenames don't contain, so
// every chunk fell into one bucket.
function groupStreams(segments) {
  const groups = {};
  for (const s of segments) {
    // The stream index comes from the FILENAME (Steam's DASH naming); the
    // video/audio keywords may legitimately live in the DIRECTORY instead, which
    // is how other clients separate the two.
    const base = path.basename(s).toLowerCase();
    const full = s.toLowerCase();
    const dash = base.match(/stream(\d+)/);
    const key = dash ? `stream${dash[1]}`
      : /audio|\baud\b|\.cmfa|_a_|track1/.test(full) ? 'audio'
        : /video|\bvid\b|\.cmfv|_v_|track0/.test(full) ? 'video'
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

  // How long SHOULD this be? DASH segments run ~2-6s each, so even a very
  // conservative 1.5s/segment tells us whether a rebuild kept the recording or
  // threw it away. Used to reject a strategy that "succeeded" but produced
  // almost nothing.
  const expectAtLeastS = info.segments.length > 1 ? info.segments.length * 1.5 : 0;
  const plausible = async () => {
    const d = await probeDuration(outPath);
    if (d == null) return { ok: false, d };
    return { ok: d >= Math.min(expectAtLeastS, 30) || expectAtLeastS === 0, d };
  };

  // Concatenating the segments comes FIRST when there are many of them.
  //
  // Steam writes a LIVE/rolling-buffer manifest: it advertises only the segments
  // currently "available", so ffmpeg reading the .mpd pulls a single segment and
  // reports ~3s — while hundreds of segments sit on disk beside it. Trusting the
  // manifest first is exactly backwards for this content, so it is now only a
  // fallback for when there is nothing to concatenate.
  if (info.segments.length > 1) {
    const streams = groupStreams(info.segments);
    const keys = Object.keys(streams);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcat-'));
    try {
      // Byte-concatenate each stream's segments (init first), then mux. Raw
      // concatenation is correct for fragmented MP4: the init segment carries
      // the moov and each fragment is self-describing.
      const parts = [];
      for (const k of keys) {
        const segs = streams[k];
        // Without the init segment a fragmented stream has no moov and is not
        // decodable — say so rather than producing a mystery failure.
        if (!segs.some(f => /init/i.test(path.basename(f)))) {
          log(`stream "${k}": no init segment found among ${segs.length} fragment(s) — it may not decode`);
        }
        const joined = path.join(tmp, `${sanitize(k)}.mp4`);
        const out = fs.createWriteStream(joined);
        // Stream the fragments through rather than buffering each one: a session
        // is hundreds of chunks and several hundred MB.
        for (const seg of segs) {
          if (!out.write(fs.readFileSync(seg))) await new Promise(res => out.once('drain', res));
        }
        out.end();
        await new Promise(res => out.on('close', res));
        log(`stream "${k}": joined ${segs.length} fragment(s) → ${Math.round(fs.statSync(joined).size / 1048576)}MB`);
        parts.push(joined);
      }
      // +genpts rebuilds presentation timestamps. Byte-concatenated fragments
      // frequently carry gaps or non-monotonic PTS, and a plain `-c copy` remux
      // preserves that damage — the rebuilt file then reports a bogus duration
      // and every later seek lands in the wrong place, which is how a 20s cut
      // request comes back as 3 seconds of video.
      const args = ['-y', '-fflags', '+genpts'];
      for (const p of parts) args.push('-i', p);
      // Map every input's streams into one file.
      parts.forEach((_, i) => args.push('-map', String(i)));
      args.push('-c', 'copy', '-movflags', '+faststart', outPath);
      const r = await run(ffmpeg, args, { timeoutMs: 45 * 60 * 1000 });
      if (r.code === 0 && fs.existsSync(outPath)) {
        const p = await plausible();
        if (p.ok) {
          return { ok: true, strategy: parts.length > 1 ? 'segment-concat-mux' : 'segment-concat', info, duration: p.d };
        }
        log(`segment concat produced only ${p.d}s from ${info.segments.length} segment(s) — trying the manifest`);
      } else {
        log(`segment concat failed: ${tail(r.stderr)}`);
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Fallbacks. The manifest is LAST for segmented content (see above), but it's
  // the right answer when there's nothing else to work from.
  if (info.manifest) {
    const r = await run(ffmpeg, ['-y', '-i', info.manifest, '-c', 'copy', '-movflags', '+faststart', outPath],
      { timeoutMs: 45 * 60 * 1000 });
    if (r.code === 0 && fs.existsSync(outPath)) {
      const p = await plausible();
      if (p.ok) return { ok: true, strategy: 'mpd-remux', info, duration: p.d };
      log(`mpd remux produced only ${p.d}s (Steam's manifest advertises a live window, not the whole buffer)`);
    } else {
      log(`mpd remux failed: ${tail(r.stderr)}`);
    }
  }

  if (info.whole) {
    const r = await run(ffmpeg, ['-y', '-i', info.whole, '-c', 'copy', '-movflags', '+faststart', outPath]);
    if (r.code === 0 && fs.existsSync(outPath)) {
      const p = await plausible();
      if (p.ok || info.segments.length <= 1) return { ok: true, strategy: 'single-remux', info, duration: p.d };
    }
    log(`single-file remux failed or came up short: ${tail(r.stderr)}`);
  }

  // Nothing produced a plausible length. Keep whatever is on disk if it's at
  // least playable, but report it as a failure so the recording is flagged
  // rather than silently yielding a handful of unusable cuts.
  const last = fs.existsSync(outPath) ? await probeDuration(outPath) : null;
  return {
    ok: false, strategy: null, info, duration: last,
    error: `could not rebuild a plausible recording (layout=${info.layout}, ${info.segments.length} segment(s)` +
      `${last != null ? `, best attempt was only ${Math.round(last)}s` : ''}). Files seen: ` +
      info.files.slice(0, 8).map(f => path.basename(f)).join(', ') + (info.files.length > 8 ? ' …' : ''),
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

// Full probe of a produced file: duration, and what streams it actually has.
// Reported to the notes board after reconstruction so a bad rebuild is visible
// immediately instead of being inferred from strange cuts much later.
async function probeMedia(file, { ffprobe = ffprobeBin() } = {}) {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height,nb_frames',
    '-of', 'json', file], { timeoutMs: 120000 });
  try {
    const j = JSON.parse(r.stdout || '{}');
    const streams = (j.streams || []).map(s => ({
      type: s.codec_type, codec: s.codec_name,
      size: s.width ? `${s.width}x${s.height}` : null,
      frames: s.nb_frames ? Number(s.nb_frames) : null,
    }));
    return {
      ok: true,
      duration: j.format && j.format.duration ? parseFloat(j.format.duration) : null,
      bytes: j.format && j.format.size ? Number(j.format.size) : null,
      streams,
      hasVideo: streams.some(s => s.type === 'video'),
      hasAudio: streams.some(s => s.type === 'audio'),
    };
  } catch (_) {
    return { ok: false, error: tail(r.stderr), streams: [] };
  }
}

// Does a rebuilt recording look sane? A Steam clip is minutes long; a rebuild
// that probes to a few seconds, or has no video/audio, means the reconstruction
// went wrong and everything downstream will inherit the damage.
function assessRebuild(probe, { minPlausibleS = 20 } = {}) {
  const problems = [];
  if (!probe || !probe.ok) return { ok: false, problems: ['could not probe the rebuilt file'] };
  if (!probe.hasVideo) problems.push('no video stream');
  if (!probe.hasAudio) problems.push('no audio stream — nothing to listen to');
  if (probe.duration == null) problems.push('no readable duration (timestamps are probably broken)');
  else if (probe.duration < minPlausibleS) problems.push(`only ${Math.round(probe.duration)}s long — the rebuild almost certainly dropped most of the recording`);
  return { ok: problems.length === 0, problems };
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

// Where does speech stop? Used to snap cut boundaries to natural conversation
// breaks so a clip never starts or ends mid-word — the difference between a
// postable clip and a fragment. Returns [{start, end}] of the silent stretches.
async function silenceGaps(wav, { ffmpeg = ffmpegBin(), noiseDb = -32, minDurS = 0.35 } = {}) {
  const r = await run(ffmpeg, ['-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minDurS}`, '-f', 'null', '-'],
    { timeoutMs: 15 * 60 * 1000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const gaps = [];
  let pending = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const t = parseFloat(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === 'start') pending = t;
    else if (pending != null) { gaps.push({ start: pending, end: t }); pending = null; }
  }
  return gaps;
}

// Move a cut boundary to the nearest conversation break within `windowS`.
// `edge` = 'start' snaps to the END of a gap (begin as speech resumes);
// 'end' snaps to the START of a gap (stop as speech finishes).
function snapToSilence(t, gaps, { edge = 'start', windowS = 2.5 } = {}) {
  if (!gaps || !gaps.length) return t;
  let best = t, bestDist = Infinity;
  for (const g of gaps) {
    const cand = edge === 'start' ? g.end : g.start;
    const dist = Math.abs(cand - t);
    if (dist < bestDist && dist <= windowS) { best = cand; bestDist = dist; }
  }
  return Math.round(best * 100) / 100;
}

// Find moments that rise sharply above a ROLLING baseline — that's what a
// laughter burst or a group reaction looks like, and it adapts to clips that are
// loud or quiet overall instead of using one global threshold.
//
// NOTE: this is now a SUPPORTING signal, not the primary one. Loudness alone
// finds "something happened here", which is not the same as a postable moment —
// the transcript-driven selection in clipWorker does the actual choosing, and
// uses these peaks as an annotation of where the energy is.
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
// Cut a candidate into its own file that a BROWSER can actually play.
//
// Two things are non-negotiable here and both were learned the hard way:
//
//   • -movflags +faststart — puts the moov atom at the FRONT of the file. Without
//     it a progressive <video> download can't start playing until it has the
//     whole file, which reads as "the clip is broken".
//   • re-encode by default — a stream copy can only cut on a keyframe, so the
//     output often begins mid-GOP. The player shows one decoded frame and then
//     stalls, which also reads as "broken". These clips are 7-30s, so encoding
//     them is cheap and guarantees a keyframe at frame 0.
//
// Set CLIPSCAN_FAST_CUT=1 to prefer the copy path anyway (faster, riskier).
async function cutClip(source, start, end, outPath, { ffmpeg = ffmpegBin(), forceEncode = false, allowCopy = process.env.CLIPSCAN_FAST_CUT === '1' } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dur = Math.max(0.1, end - start);

  if (allowCopy && !forceEncode) {
    const r = await run(ffmpeg, ['-y', '-ss', String(start), '-i', source, '-t', String(dur),
      '-c', 'copy', '-movflags', '+faststart', outPath]);
    if (r.code === 0 && fs.existsSync(outPath)) {
      const got = await probeDuration(outPath);
      if (got != null && got >= dur * 0.6) return { ok: true, mode: 'copy', duration: got };
    }
  }

  // Fast seek: -ss before -i. Cheap, but it relies on the source's timestamps
  // being sane — and a rebuilt-from-fragments MP4 often has gaps or non-monotonic
  // PTS, in which case ffmpeg silently emits a few seconds instead of what was
  // asked for. So we ALWAYS verify the result against what we requested.
  const enc = ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  const fast = await run(ffmpeg, ['-y', '-ss', String(start), '-i', source, '-t', String(dur), ...enc, outPath]);
  let got = (fast.code === 0 && fs.existsSync(outPath)) ? await probeDuration(outPath) : null;

  if (got != null && got >= dur * 0.8) return { ok: true, mode: 'encode', duration: got, requested: dur };

  // Short output → the source's timestamps can't be trusted. Redo it with an
  // ACCURATE seek (-ss AFTER -i, so ffmpeg decodes from the start and counts
  // frames rather than trusting PTS) plus -fflags +genpts to rebuild timestamps.
  // Much slower on a long recording, but it produces the length actually asked
  // for — which is the difference between a postable clip and a 3-second stub.
  const accurate = await run(ffmpeg, ['-y', '-fflags', '+genpts', '-i', source,
    '-ss', String(start), '-t', String(dur), ...enc, outPath], { timeoutMs: 30 * 60 * 1000 });
  if (accurate.code === 0 && fs.existsSync(outPath)) {
    const got2 = await probeDuration(outPath);
    if (got2 != null && got2 >= 0.5) {
      return {
        ok: true, mode: 'encode-accurate', duration: got2, requested: dur,
        short: got2 < dur * 0.8 ? `asked for ${Math.round(dur)}s, got ${Math.round(got2)}s` : null,
      };
    }
  }
  if (got != null && got >= 0.5) {
    // Accurate seek failed too — keep the short one rather than losing the moment,
    // but report that it's short so it's visible rather than mysterious.
    return { ok: true, mode: 'encode-short', duration: got, requested: dur, short: `asked for ${Math.round(dur)}s, got ${Math.round(got)}s` };
  }
  return { ok: false, error: tail(accurate.stderr || fast.stderr) };
}

// A browser-friendly copy of a cut, for the review grid only.
//
// The real cuts keep the capture's full 3840x1080 — that's what gets edited.
// But a frame that wide in H.264 pushes past what phone browsers will decode,
// and the symptom is nasty: it plays for a fraction of a second and stops, which
// looks like a broken file rather than a decoder limit. So the grid streams a
// downscaled, conservatively-encoded copy instead.
//
// Constrained Baseline-ish settings on purpose: yuv420p, level 4.0, no B-frames.
// Ugly-but-plays beats pretty-but-stalls for something you only use to judge a
// moment.
async function makePreview(src, outPath, {
  ffmpeg = ffmpegBin(),
  maxWidth = parseInt(process.env.CLIPSCAN_PREVIEW_WIDTH || '960', 10),
  maxRateK = parseInt(process.env.CLIPSCAN_PREVIEW_KBPS || '700', 10),
} = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // SIZE is the constraint, not quality. These are streamed from a home
  // connection to a phone, and an 11MB preview stalls long before it finishes
  // — the browser reports "waiting on data that is not arriving", which reads
  // like a broken file. A hard bitrate cap plus 30fps puts a 60s clip at a few
  // MB, which arrives fast enough to actually watch.
  const r = await run(ffmpeg, ['-y',
    // Normalise timestamps. The source is byte-concatenated from hundreds of
    // fragments, so its PTS can be non-monotonic or negative. Desktop players
    // shrug that off; browsers play the first fraction of a second and then stop
    // waiting for a timestamp that never comes — which looks exactly like a
    // broken file even though the clip opens fine in VLC.
    '-fflags', '+genpts',
    '-i', src,
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '1024',
    // Never upscale, and force even dimensions (H.264 requires them).
    '-vf', `scale='min(${maxWidth},iw)':-2`,
    '-r', '30', '-vsync', 'cfr',   // constant frame rate → evenly spaced, monotonic PTS
    '-c:v', 'libx264', '-profile:v', 'main', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-preset', 'veryfast',
    '-crf', '30', '-maxrate', `${maxRateK}k`, '-bufsize', `${maxRateK * 2}k`,
    '-g', '60',                                  // keyframe every 2s so seeking works
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1',    // mono is plenty for judging a moment
    '-movflags', '+faststart', outPath], { timeoutMs: 20 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(outPath)) return { ok: false, error: tail(r.stderr) };
  const dur = await probeDuration(outPath);
  if (dur == null || dur < 0.5) return { ok: false, error: `preview has no usable duration (${dur})` };
  let bytes = 0;
  try { bytes = fs.statSync(outPath).size; } catch (_) {}
  return { ok: true, duration: dur, bytes, mb: Math.round(bytes / 1048576 * 10) / 10 };
}

async function thumbnail(video, outPath, { ffmpeg = ffmpegBin(), atS = null } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dur = atS != null ? atS : ((await probeDuration(video)) || 2) / 2;
  const r = await run(ffmpeg, ['-y', '-ss', String(dur), '-i', video, '-frames:v', '1', outPath]);
  return r.code === 0 && fs.existsSync(outPath);
}

module.exports = {
  findTool, ffmpegBin, ffprobeBin, findPython, pythonBin, pythonCandidates, preflight, run,
  inspectFolder, orderSegments, groupStreams, reconstruct,
  probeDuration, probeMedia, assessRebuild, extractAudio, loudnessTrack, findPeaks, mergeOverlaps,
  silenceGaps, snapToSilence,
  cutClip, makePreview, thumbnail,
};
