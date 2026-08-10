// bouchhub-agent/clipWorker.js
//
// The Clip Scanning worker. N of these loops run concurrently on this machine
// (4 by default). Each one repeatedly:
//
//   claim a recording from the hub → reconstruct it → find audio-first
//   candidates → make sure the game's viral rubric exists → score each candidate
//   against it → cut the keepers into their own files → register them
//
// The hub hands out the work, so two loops can never land on the same recording
// no matter how fast they run. Everything a loop does is narrated to the shared
// notes board, which is both the human feed and how the loops stay out of each
// other's way.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const media = require('./clipMedia');

const { HUB_URL, AGENT_SECRET } = process.env;

const POLL_IDLE_MS = 20 * 1000;     // nothing to claim → wait before asking again
const HEARTBEAT_MS = 15 * 1000;

let running = false;
let loops = [];
const state = {};                    // workerId → { status, task }

// ── Hub conversation ─────────────────────────────────────────────────────────
async function hub(method, endpoint, body, { timeoutMs = 60000 } = {}) {
  const nodeFetch = global.fetch || require('node-fetch');
  const res = await nodeFetch(`${HUB_URL}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': AGENT_SECRET },
    body: body == null ? undefined : JSON.stringify(body),
    timeout: timeoutMs,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
  if (!res.ok) throw new Error((json && json.error) || `hub ${res.status}`);
  return json;
}

async function note(agentId, kind, body, extra = {}) {
  try { await hub('POST', '/api/clipscan/notes', { agent_id: agentId, kind, body, ...extra }); }
  catch (_) { /* the board is best-effort; never fail a job over a note */ }
}
async function beat(agentId, currentTask, status = 'working') {
  state[agentId] = { status, task: currentTask };
  try {
    await hub('POST', `/api/clipscan/agents/${agentId}/heartbeat`, {
      current_task: currentTask, status, machine: process.env.CLIPSCAN_MACHINE || require('os').hostname(),
      name: `Agent ${agentId}`,
    });
  } catch (_) {}
}
async function setStatus(agentId, recId, status, extra = {}) {
  try { await hub('PUT', `/api/clipscan/recordings/${recId}/status`, { status, agent_id: agentId, ...extra }); }
  catch (_) {}
}

// ── Transcription ────────────────────────────────────────────────────────────
// Runs the standalone clip_transcribe.py. Windows-only transcription (the peak
// moments) rather than whole tracks — far faster across a batch, and the audio
// pass has already told us where the interesting parts are.
function transcribe(wav, windows, { pythonBin = process.env.PYTHON_BIN || 'python', timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'scripts', 'clip_transcribe.py'), wav];
    if (windows && windows.length) args.push('--windows', JSON.stringify(windows));
    let out = '', err = '';
    let child;
    try { child = spawn(pythonBin, args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: e.message, segments: [] }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message, segments: [] }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}');
        resolve({ segments: [], ...parsed });
      } catch (_) {
        resolve({ ok: false, error: (err || out || 'transcriber produced no JSON').slice(-300), segments: [] });
      }
    });
  });
}

// Attach whichever transcript lines fall inside each candidate window.
function attachTranscripts(candidates, segments) {
  return candidates.map(c => {
    const lines = (segments || [])
      .filter(s => s.end >= c.start_s && s.start <= c.end_s)
      .map(s => s.text.trim())
      .filter(Boolean);
    return { ...c, transcript: lines.join(' ') || null, trigger: lines.length ? 'combined' : c.trigger };
  });
}

// ── Claude ───────────────────────────────────────────────────────────────────
// Scoring and rubric-writing both go through the provider runner, so they use
// the logged-in subscription (never metered credits — providerEnv blanks the
// API key for the claude family).
async function ask(prompt, { provider = process.env.CLIPSCAN_PROVIDER || 'claude', timeoutMs = 180000 } = {}) {
  const claude = require('./claude');
  const r = await claude.complete({ provider, prompt, timeoutMs });
  return (r && (r.text || r.output || r.stdout)) || '';
}

// Models sometimes wrap JSON in prose or a fence — take the first balanced object.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// ── The viral rubric ─────────────────────────────────────────────────────────
// Studied once per game under its own claim. Other loops just read it.
async function ensureRubric(agentId, appId, gameName) {
  const existing = await hub('GET', `/api/clipscan/game_meta/${appId}`).catch(() => null);
  if (existing && existing.studied) return existing;

  const claim = await hub('POST', '/api/clipscan/study/claim', { agent_id: agentId, app_id: appId }).catch(() => null);
  if (!claim || !claim.ok) {
    // Another loop is on it (or it just landed) — wait briefly, then use whatever
    // exists. Never block a recording forever on the study.
    await sleep(15000);
    return await hub('GET', `/api/clipscan/game_meta/${appId}`).catch(() => null);
  }

  await beat(agentId, `Studying what's going viral for ${gameName || appId}`, 'studying');
  await note(agentId, 'status', `Agent ${agentId} studying ${gameName || appId} virals — writing the rubric; others read game_meta when it lands.`);

  const references = await gatherReferences(gameName || `app ${appId}`).catch(() => []);
  const prompt = [
    `You are building a "what performs right now" rubric for short-form clips of the game ${gameName || appId}.`,
    references.length
      ? `Here is what recent top-performing clips of this game look like:\n${references.map((r, i) => `${i + 1}. ${r.title || ''} — ${r.url || ''}\n   ${(r.summary || '').slice(0, 400)}`).join('\n')}`
      : `No reference clips could be fetched, so reason from what you know about this game and short-form conventions generally.`,
    ``,
    `Return ONLY JSON in exactly this shape:`,
    `{"ideal_length_s":[min,max],"hook":"...","winning_patterns":["..."],"caption_style":"...","pacing":"...","avoid":["..."]}`,
    `Be concrete and specific to THIS game's moment-to-moment action, not generic advice.`,
  ].join('\n');

  const rubric = extractJson(await ask(prompt)) || {
    ideal_length_s: [8, 22],
    hook: 'payoff visible in the first 1-2s',
    winning_patterns: ['genuine group laughter', 'last-second escape', 'absurd failure'],
    caption_style: 'short, reaction-led, lowercase',
    pacing: 'one clear payoff, no slow lead-in',
    avoid: ['long setup', 'dead air', 'context that needs explaining'],
    _note: 'fallback rubric — the study step could not produce JSON',
  };

  return await hub('POST', `/api/clipscan/game_meta/${appId}`, {
    agent_id: agentId, rubric, game_name: gameName,
    source_urls: references.map(r => r.url).filter(Boolean),
  });
}

// Pull a few recent top clips for the game via the agent's own logged-in browser.
// Best-effort: no references just means the rubric is reasoned rather than observed.
async function gatherReferences(gameName) {
  const browser = require('./browser');
  const out = [];
  const queries = [
    `https://www.tiktok.com/search?q=${encodeURIComponent(gameName + ' funny clips')}`,
    `https://www.youtube.com/results?search_query=${encodeURIComponent(gameName + ' funny moments shorts')}&sp=CAI%253D`,
  ];
  for (const url of queries) {
    try {
      const page = await browser.extractPage(url);
      if (page && (page.text || page.title)) {
        out.push({ url, title: page.title || '', summary: String(page.text || '').slice(0, 1500) });
      }
    } catch (_) { /* platform blocked or not logged in — skip */ }
  }
  return out;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
async function scoreCandidate(candidate, rubric, gameName) {
  const len = Math.round((candidate.end_s - candidate.start_s) * 10) / 10;
  const prompt = [
    `You are judging whether one moment from a ${gameName || 'game'} recording is worth posting as a short-form clip.`,
    ``,
    `THE VIRAL RUBRIC for this game (what's performing right now):`,
    JSON.stringify(rubric || {}, null, 2),
    ``,
    `THE CANDIDATE MOMENT:`,
    `- length: ${len}s (${candidate.start_s}s → ${candidate.end_s}s)`,
    `- audio peak strength: ${candidate.audio_score} (0..1; high means a sharp burst above the clip's baseline — laughter, shouting, group reaction)`,
    `- what's said: ${candidate.transcript ? JSON.stringify(candidate.transcript) : '(no speech detected in this window)'}`,
    ``,
    `Score 0-100 for how strongly you'd recommend POSTING this. Blend: audio strength, whether there's a clear payoff, and fit to the rubric above.`,
    `Be honest — most moments are mediocre. Reserve 80+ for clips you'd actually post.`,
    ``,
    `Return ONLY JSON:`,
    `{"score":0-100,"rationale":"why this works and how it maps to the rubric","goods":["..."],"bads":["..."],"recommended_length_s":[start,end]}`,
    `"recommended_length_s" must be absolute seconds within ${candidate.start_s}-${candidate.end_s}, tightening the cut to the good part.`,
  ].join('\n');

  const j = extractJson(await ask(prompt));
  if (!j || typeof j.score !== 'number') {
    // Never drop a candidate because the judge misbehaved — fall back to the
    // audio signal alone and say so.
    return {
      score: Math.round(candidate.audio_score * 55),
      rationale: 'Scored from audio strength alone — the judgment step did not return usable JSON.',
      goods: [], bads: ['unjudged — review manually'],
      recommended_length_s: [candidate.start_s, candidate.end_s],
    };
  }
  return j;
}

// ── One recording, end to end ────────────────────────────────────────────────
async function processRecording(agentId, rec, cfg) {
  const workDir = path.join(cfg.workDir, String(rec.id));
  const label = rec.folder_name || `#${rec.id}`;
  fs.mkdirSync(workDir, { recursive: true });

  // 1. Reconstruct
  await setStatus(agentId, rec.id, 'reconstructing', { progress: 'rebuilding the recording' });
  await beat(agentId, `Reconstructing ${label}`);
  const mp4 = path.join(workDir, 'reconstructed.mp4');
  const built = await media.reconstruct(rec.folder_path, mp4, {
    onLog: m => note(agentId, 'status', `[${label}] ${m}`, { recording_id: rec.id }),
  });
  if (!built.ok) {
    await note(agentId, 'warning', `Recording ${label} could not be reconstructed: ${built.error}`, { recording_id: rec.id });
    await setStatus(agentId, rec.id, 'error', { error_msg: built.error });
    return;
  }
  const duration = await media.probeDuration(mp4);
  await note(agentId, 'coordination',
    `[${label}] rebuilt via ${built.strategy} (layout ${built.info.layout}), ${duration ? Math.round(duration) + 's' : 'unknown length'}.`,
    { recording_id: rec.id });

  // 2. Audio-first candidate detection
  await setStatus(agentId, rec.id, 'analyzing', { progress: 'audio pass', duration_s: duration });
  await beat(agentId, `Audio pass on ${label}`);
  const wav = path.join(workDir, 'audio.wav');
  const audio = await media.extractAudio(mp4, wav);
  if (!audio.ok) {
    await setStatus(agentId, rec.id, 'error', { error_msg: `audio extraction failed: ${audio.stderr}` });
    await note(agentId, 'warning', `[${label}] audio extraction failed.`, { recording_id: rec.id });
    return;
  }
  const track = await media.loudnessTrack(wav);
  let candidates = media.findPeaks(track, {
    minLenS: cfg.clipLenS[0], maxLenS: cfg.clipLenS[1], durationS: duration,
  });
  await note(agentId, 'status', `[${label}] audio pass found ${candidates.length} candidate moment(s).`, { recording_id: rec.id });

  if (!candidates.length) {
    await setStatus(agentId, rec.id, 'done', { progress: 'no candidates' });
    await note(agentId, 'finding', `[${label}] nothing rose above the room tone — no candidates.`, { recording_id: rec.id });
    return;
  }

  // 3. Speech on the peak windows only (much faster than whole tracks)
  await beat(agentId, `Transcribing ${candidates.length} moment(s) in ${label}`);
  const t = await transcribe(wav, candidates.map(c => [c.start_s, c.end_s]));
  if (!t.ok) {
    await note(agentId, 'warning', `[${label}] transcription unavailable (${t.error}) — scoring on audio + rubric only.`, { recording_id: rec.id });
  }
  candidates = attachTranscripts(candidates, t.segments);
  await hub('POST', `/api/clipscan/recordings/${rec.id}/candidates`, { candidates }).catch(() => {});

  // 4. Rubric (studied once per game)
  const meta = await ensureRubric(agentId, rec.app_id, rec.game_name);
  const rubric = (meta && meta.rubric) || null;

  // 5. Score + cut
  await setStatus(agentId, rec.id, 'cutting', { progress: `${candidates.length} candidates` });
  const gameDir = path.join(cfg.outDir, sanitizeName(rec.game_name || rec.app_id), (rec.recorded_at || '').slice(0, 10) || 'undated');
  let made = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    await beat(agentId, `Scoring ${label} (${i + 1}/${candidates.length})`);
    const judged = await scoreCandidate(c, rubric, rec.game_name);

    // Honour the tightened window when it's sane, else keep the detected one.
    let [s, e] = Array.isArray(judged.recommended_length_s) ? judged.recommended_length_s : [c.start_s, c.end_s];
    if (!(Number.isFinite(s) && Number.isFinite(e)) || e - s < 1) { s = c.start_s; e = c.end_s; }
    s = Math.max(0, Math.min(s, c.start_s));
    e = Math.max(s + 1, Math.min(e, duration || e));

    if (judged.score < cfg.minScore && cfg.lowScore === 'skip') {
      await note(agentId, 'status', `[${label}] skipped a ${judged.score}-scoring moment (below the floor).`, { recording_id: rec.id });
      continue;
    }

    const base = `score${String(judged.score).padStart(2, '0')}_${rec.folder_name || rec.id}_${Math.round(s)}s_agent${agentId}`;
    const outPath = path.join(gameDir, `${base}.mp4`);
    await beat(agentId, `Cutting ${label} (${i + 1}/${candidates.length})`);
    const cut = await media.cutClip(mp4, s, e, outPath);
    if (!cut.ok) {
      await note(agentId, 'warning', `[${label}] cut failed at ${s}s: ${cut.error}`, { recording_id: rec.id });
      continue;
    }
    const thumbPath = path.join(gameDir, `${base}_thumb.jpg`);
    await media.thumbnail(outPath, thumbPath).catch(() => false);

    const registered = await hub('POST', '/api/clipscan/cuts', {
      recording_id: rec.id, candidate_id: null, agent_id: agentId,
      output_path: outPath, thumbnail_path: fs.existsSync(thumbPath) ? thumbPath : null,
      start_s: s, end_s: e, score: judged.score, rationale: judged.rationale,
      goods: judged.goods || [], bads: judged.bads || [],
    }).catch(e => { note(agentId, 'warning', `[${label}] could not register a cut: ${e.message}`); return null; });

    // Sidecar JSON so the files are self-describing outside BouchHub too.
    try {
      fs.writeFileSync(path.join(gameDir, `${base}.json`), JSON.stringify({
        game: rec.game_name, app_id: rec.app_id, source_folder: rec.folder_path,
        in_s: s, out_s: e, length_s: Math.round((e - s) * 10) / 10,
        score: judged.score, rationale: judged.rationale,
        goods: judged.goods || [], bads: judged.bads || [],
        transcript: c.transcript || null, audio_score: c.audio_score,
        agent: `Agent ${agentId}`, cut_mode: cut.mode, created_at: new Date().toISOString(),
      }, null, 2));
    } catch (_) {}

    if (registered) made++;
  }

  await setStatus(agentId, rec.id, 'done', { progress: `${made} cut(s)` });
  await note(agentId, 'finding', `[${label}] done — ${made} cut(s) from ${candidates.length} candidate(s).`, { recording_id: rec.id });
}

function sanitizeName(s) { return String(s || 'unknown').replace(/[<>:"/\\|?*]/g, '').trim() || 'unknown'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── The loop ─────────────────────────────────────────────────────────────────
async function workerLoop(agentId) {
  while (running) {
    let cfg;
    try {
      const ov = await hub('GET', '/api/clipscan/overview');
      cfg = ov.config;
    } catch (e) {
      await beat(agentId, `Hub unreachable (${e.message})`, 'error');
      await sleep(POLL_IDLE_MS);
      continue;
    }
    try {
      const claimed = await hub('POST', '/api/clipscan/claim', {
        agent_id: agentId, app_id: cfg.targetApp || null,
      });
      if (!claimed || !claimed.recording) {
        await beat(agentId, 'Idle — queue empty', 'idle');
        await sleep(POLL_IDLE_MS);
        continue;
      }
      await processRecording(agentId, claimed.recording, cfg);
    } catch (e) {
      await beat(agentId, `Error: ${e.message}`, 'error');
      await note(agentId, 'warning', `Agent ${agentId} hit an error: ${e.message}`);
      await sleep(POLL_IDLE_MS);
    }
  }
  await beat(agentId, '', 'offline');
}

async function start({ count = parseInt(process.env.CLIPSCAN_AGENT_COUNT || '4', 10) } = {}) {
  if (running) return { running: true, workers: loops.length };
  const pre = await media.preflight();
  if (!pre.ok) {
    await note(null, 'warning', `Clip scanning cannot start: ${pre.problems.join('; ')}`);
    return { running: false, error: pre.problems.join('; ') };
  }
  running = true;
  loops = [];
  for (let i = 1; i <= count; i++) loops.push(workerLoop(i));
  await note(null, 'coordination', `${count} clip-scan worker(s) started on ${process.env.CLIPSCAN_MACHINE || require('os').hostname()}.`);
  // Keep the dashboard's agent panel warm even while a loop is deep in ffmpeg.
  const hb = setInterval(() => {
    for (let i = 1; i <= count; i++) {
      const s = state[i];
      if (s) beat(i, s.task, s.status).catch(() => {});
    }
  }, HEARTBEAT_MS);
  if (hb.unref) hb.unref();
  return { running: true, workers: count, tools: pre };
}

function stop() {
  running = false;
  return { running: false };
}

function status() {
  return {
    running, workers: loops.length,
    agents: Object.entries(state).map(([id, s]) => ({ id: Number(id), ...s })),
  };
}

module.exports = {
  start, stop, status,
  // exported for tests
  attachTranscripts, extractJson, transcribe, processRecording, sanitizeName,
};
