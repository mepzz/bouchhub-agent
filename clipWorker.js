// bouchhub-agent/clipWorker.js
//
// The Clip Scanning worker. N of these loops run concurrently on this machine
// (4 by default). Each one repeatedly:
//
//   claim a recording from the hub → reconstruct it → TRANSCRIBE THE WHOLE THING
//   → make sure the game's viral rubric exists → let the model pick complete
//   postable moments out of the transcript → score, cut and register them
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
// Why the last provider call failed, so the worker can say so on the board
// instead of leaving every cut marked "unjudged" with no explanation.
let lastAskProblem = null;

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
// Runs the standalone clip_transcribe.py. Pass windows to transcribe only those
// stretches; pass null to do the WHOLE recording, which is what the pipeline
// does now — transcribing slivers around audio spikes meant the picker never
// knew what was actually said and chose loud noises over moments.
// Uses whichever interpreter clipMedia found that can actually import
// faster_whisper — NOT a bare "python", which under the SYSTEM account the agent
// runs as usually resolves to nothing (or to an install without the package).
async function transcribe(wav, windows, opts = {}) {
  const pythonBin = opts.pythonBin || (await media.findPython('faster_whisper')).bin;
  return transcribeWith(pythonBin, wav, windows, opts);
}

function transcribeWith(pythonBin, wav, windows, { timeoutMs = 20 * 60 * 1000 } = {}) {
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
// Returns { text, error }. NEVER swallow the reason: when the provider is rate
// limited or its CLI fails, every cut silently came back "unjudged — review
// manually" with no way to tell a usage limit from a broken install.
// Model calls are SERIALISED across all workers on this machine.
//
// claude.js warns that concurrent sessions need separate config dirs — a shared
// ~/.claude races on .claude.json and credentials. All four clip-scan workers
// were calling the same provider at once, so the CLI exited 0 with no output and
// every moment came back unscored. Scoring is not the bottleneck here (ffmpeg
// and transcription are), so taking these one at a time costs almost nothing.
let _askChain = Promise.resolve();
function serialise(fn) {
  const run = _askChain.then(fn, fn);
  _askChain = run.catch(() => {});
  return run;
}

// Serialising covers the clip-scan workers, but not a mascot session holding
// ~/.claude at the same moment — that collision looks identical (exit 0, no
// output) and is transient, so an empty reply is retried once before giving up.
const RETRY_DELAY_MS = Number(process.env.CLIPSCAN_RETRY_MS || 8000);

async function ask(prompt, { provider = process.env.CLIPSCAN_PROVIDER || 'claude', timeoutMs = 180000, allowTools = [] } = {}) {
  const first = await serialise(() => askNow(prompt, { provider, timeoutMs, allowTools }));
  if (first.text) return first;
  // A dead login is not transient — retrying it just doubles the wait on every
  // cut and buries the one thing you need to be told.
  if (require('./claude').authFailure(first.error)) return first;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await serialise(() => askNow(prompt, { provider, timeoutMs, allowTools }));
  if (second.text) return second;
  return { text: '', error: `${second.error} (retried once)` };
}

async function askNow(prompt, { provider, timeoutMs, allowTools = [] }) {
  const claude = require('./claude');
  try {
    const r = await claude.complete({ provider, prompt, timeoutMs, allowTools });
    const text = (r && (r.text || r.output || r.stdout)) || '';
    // A non-zero exit with output is the CLI explaining a problem, not answering.
    if (r && r.code) return { text: '', error: `provider "${provider}" exited ${r.code}: ${text.slice(0, 200)}` };
    if (text) return { text, error: null };
    const why = (r && (r.error || r.stderr)) || 'no output';
    return { text: '', error: `provider "${provider}" returned nothing (${String(why).slice(-200)})` };
  } catch (e) {
    return { text: '', error: `provider "${provider}" failed: ${e.message}` };
  }
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
// A sane default so a candidate is NEVER judged with no rubric at all. Scoring
// blind produces "no rubric details provided to confirm fit" in every rationale,
// which is useless feedback.
const FALLBACK_RUBRIC = {
  ideal_length_s: [20, 60],
  hook: 'payoff visible in the first 1-2s',
  winning_patterns: ['genuine group laughter', 'last-second escape', 'absurd failure', 'sudden reveal'],
  caption_style: 'short, reaction-led, lowercase',
  pacing: 'one clear payoff, no slow lead-in',
  avoid: ['long setup', 'dead air', 'context that needs explaining'],
  _fallback: true,
};

async function ensureRubric(agentId, appId, gameName) {
  const existing = await hub('GET', `/api/clipscan/game_meta/${appId}`).catch(() => null);
  if (existing && existing.studied) return existing;

  const claim = await hub('POST', '/api/clipscan/study/claim', { agent_id: agentId, app_id: appId }).catch(() => null);
  if (!claim || !claim.ok) {
    // Another loop is studying. Studying takes a browser fetch plus a model call,
    // so a single 15s wait was far too short — the other three agents all gave up
    // and scored their whole batch with a null rubric. Poll until it lands.
    for (let i = 0; i < 20; i++) {
      await sleep(15000);
      const got = await hub('GET', `/api/clipscan/game_meta/${appId}`).catch(() => null);
      if (got && got.studied) return got;
      await beat(agentId, `Waiting on the ${gameName || appId} rubric (${(i + 1) * 15}s)`, 'studying');
    }
    // The studier died or is wedged. Take the study over rather than scoring blind.
    await note(agentId, 'warning', `Rubric for ${gameName || appId} never landed — agent ${agentId} is taking the study over.`);
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

  const askedRubric = await ask(prompt);
  if (!askedRubric.text) lastAskProblem = askedRubric.error;
  const rubric = extractJson(askedRubric.text) || FALLBACK_RUBRIC;
  if (rubric._fallback) {
    await note(agentId, 'warning', `Could not study ${gameName || appId} virals — using a generic rubric. Scores will be less game-specific.`);
  }

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
// ── Moment selection (the heart of it) ───────────────────────────────────────
//
// The first version of this found loud spots and padded them to a minimum
// length. That finds "something happened here", which is NOT the same as a
// postable clip — it produced 3-second fragments with no context.
//
// What the real tools (OpusClip et al) do, and what this now does:
//   • transcribe the WHOLE recording, not slivers around audio spikes
//   • hand the model the full timestamped transcript, annotated with where the
//     audio energy spikes are, and let IT pick complete moments
//   • target 20-60s — long enough to carry setup → payoff
//   • snap the boundaries to natural conversation breaks
//
// Build the annotated timeline the model reads: every transcript line with its
// timestamp, and a marker where a reaction spike lands.
function buildTimeline(segments, peaks, durationS) {
  const lines = [];
  const peakAt = t => (peaks || []).some(p => t >= p.start_s - 1 && t <= p.end_s + 1);
  for (const s of segments || []) {
    lines.push(`[${fmtTs(s.start)}–${fmtTs(s.end)}]${peakAt(s.start) ? ' 🔊' : ''} ${s.text}`);
  }
  // Reaction spikes with no speech still matter (pure laughter, screaming).
  for (const p of peaks || []) {
    const covered = (segments || []).some(s => s.end >= p.start_s && s.start <= p.end_s);
    if (!covered) lines.push(`[${fmtTs(p.start_s)}–${fmtTs(p.end_s)}] 🔊 (loud reaction, no words — energy ${p.audio_score})`);
  }
  return lines
    .sort((a, b) => parseTs(a) - parseTs(b))
    .join('\n');
}
function fmtTs(s) {
  s = Math.max(0, Number(s) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function parseTs(line) {
  const m = /^\[(\d+):(\d+)/.exec(line);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}

// Ask the model to choose the postable moments out of the whole recording.
async function selectMoments(timeline, rubric, gameName, durationS, clipLenS) {
  const [minLen, maxLen] = clipLenS;
  const prompt = [
    `You are choosing which moments from a ${Math.round(durationS || 0)}s ${gameName || 'game'} recording are worth posting as short-form clips (TikTok / Reels / Shorts).`,
    ``,
    `WHAT PERFORMS FOR THIS GAME:`,
    JSON.stringify(rubric || {}, null, 2),
    ``,
    `THE FULL RECORDING — every line that was said, with timestamps. 🔊 marks a spike in audio energy (laughter, shouting, a group reaction):`,
    timeline || '(no speech was detected in this recording)',
    ``,
    `Pick the BEST moments. Rules:`,
    `1. Each clip must be ${minLen}-${maxLen} SECONDS long. This is the single most important rule — a shorter clip has no room for setup and payoff and is unpostable. If a moment is too short on its own, widen it to include the lead-up and the reaction after.`,
    `2. Each clip must be a COMPLETE moment: something sets it up, something happens, people react. A viewer with no context should understand it.`,
    `3. Start ON or just before the line that hooks the viewer — no slow lead-in, but don't cut off the setup that makes the payoff land.`,
    `4. End just after the reaction, not mid-sentence.`,
    `5. Prefer moments with a genuine reaction (🔊 with speech around it) over quiet stretches.`,
    `6. Return 0 to 8 moments. QUALITY over quantity — if only two are genuinely worth posting, return two. If nothing is, return an empty list. Do not pad the list.`,
    ``,
    `Return ONLY JSON:`,
    `{"moments":[{"start_s":<seconds>,"end_s":<seconds>,"title":"short label","why":"what happens and why it works"}]}`,
    `start_s/end_s are absolute seconds from the beginning of the recording. Do not exceed ${Math.round(durationS || 0)}s.`,
  ].join('\n');

  const a = await ask(prompt);
  const j = extractJson(a.text);
  if (!j) lastAskProblem = a.error || `the picker replied but not with JSON: ${String(a.text).slice(0, 200)}`;
  const list = (j && Array.isArray(j.moments)) ? j.moments : [];
  return list
    .map(m => ({
      start_s: Number(m.start_s), end_s: Number(m.end_s),
      title: String(m.title || '').slice(0, 120),
      why: String(m.why || '').slice(0, 600),
    }))
    .filter(m => Number.isFinite(m.start_s) && Number.isFinite(m.end_s) && m.end_s > m.start_s);
}

// The judge's `recommended_length_s` is a SUGGESTION, not a licence to produce
// something unpostable — trusting it blindly emitted a 3s clip when the
// configured minimum was 7s. Clamp it back into the length window (growing
// around the midpoint if it came back too short), then fit it inside the
// recording while preserving the length wherever there's room.
function clampWindow(recommended, candidate, clipLenS = [7, 30], durationS = null) {
  const [minLen, maxLen] = clipLenS;
  let s, e;
  if (Array.isArray(recommended) && recommended.length === 2) [s, e] = recommended.map(Number);
  if (!(Number.isFinite(s) && Number.isFinite(e)) || e <= s) { s = candidate.start_s; e = candidate.end_s; }

  const hardEnd = durationS || Math.max(e, candidate.end_s);
  if (e - s < minLen) {
    const mid = (s + e) / 2;
    s = mid - minLen / 2;
    e = mid + minLen / 2;
  }
  if (e - s > maxLen) e = s + maxLen;
  if (s < 0) { e += -s; s = 0; }
  if (e > hardEnd) { s = Math.max(0, s - (e - hardEnd)); e = hardEnd; }
  return { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}

async function scoreCandidate(candidate, rubric, gameName, frames = []) {
  const len = Math.round((candidate.end_s - candidate.start_s) * 10) / 10;
  const rel = (t) => Math.round((t - candidate.start_s) * 10) / 10;
  const prompt = [
    `You are judging whether one moment from a ${gameName || 'game'} recording is worth posting as a short-form clip.`,
    ``,
    `THE VIRAL RUBRIC for this game (what's performing right now):`,
    JSON.stringify(rubric || {}, null, 2),
    ``,
    `THE MOMENT (${len}s, ${candidate.start_s}s → ${candidate.end_s}s):`,
    candidate.title ? `- picked as: ${candidate.title}` : '',
    candidate.why ? `- why it was picked: ${candidate.why}` : '',
    `- what is said during it: ${candidate.transcript ? JSON.stringify(candidate.transcript) : '(no speech in this window)'}`,
    `- audio energy: ${candidate.audio_score == null ? 'no spike' : candidate.audio_score + ' (0..1 above the recording baseline)'}`,
    ``,
    ...(frames.length ? [
      `WHAT IS ACTUALLY ON SCREEN. Read each of these frame grabs before scoring —`,
      `they are stills from this exact window, and the first one is the opening frame:`,
      ...frames.map(f => `- ${f.path}  (at ${rel(f.atS)}s into the clip)`),
      ``,
      `Judge the VISUALS from these frames. Do not say the visual is unconfirmed —`,
      `you can see it. If the frames show the payoff is missing, unreadable or`,
      `off-screen, say so and score it down; that is a real finding.`,
      ``,
    ] : [
      `NOTE: no frame grabs are available for this moment, so you are judging from`,
      `audio and transcript alone. Say so plainly in the rationale rather than`,
      `speculating about what might be on screen.`,
      ``,
    ]),
    `Score 0-100 for how strongly you'd recommend POSTING this, blending: is there a clear payoff, would a viewer with no context understand it, and does it fit what performs for this game.`,
    `Be honest — most moments are mediocre. Reserve 80+ for clips you'd actually post.`,
    `The cut length is already decided and snapped to conversation breaks — judge the MOMENT, not the trim.`,
    ``,
    `Return ONLY JSON:`,
    `{"score":0-100,"rationale":"what happens and why it does or doesn't work","goods":["..."],"bads":["..."]}`,
  ].filter(Boolean).join('\n');

  // Reading the frames needs the Read tool; a text-only call has none.
  let a = await ask(prompt, frames.length ? { allowTools: ['Read'] } : {});
  let j = extractJson(a.text);
  // If looking at the frames didn't work — the CLI rejected the tool, stalled on
  // a permission prompt, whatever — fall back to the text-only judgement that
  // was working before rather than losing the score entirely. Scoring blind is
  // worse than scoring with eyes; it is much better than "review manually".
  if (frames.length && (!j || typeof j.score !== 'number')) {
    lastAskProblem = a.error || 'the judge could not use the frame grabs';
    const blind = await scoreCandidate(candidate, rubric, gameName, []);
    if (!blind._error) {
      blind.bads = [...(blind.bads || []), 'judged without frames — the visual read is unverified'];
      return blind;
    }
    a = { text: a.text, error: lastAskProblem };
    j = null;
  }
  if (!j || typeof j.score !== 'number') {
    lastAskProblem = a.error || `the judge replied but not with JSON: ${String(a.text).slice(0, 200)}`;
    // Never drop a moment because the judge misbehaved — the picker already
    // decided this was worth cutting, so keep it and flag it for manual review.
    return {
      score: candidate.audio_score != null ? Math.round(candidate.audio_score * 55) : 45,
      rationale: candidate.why || 'The judgment step did not return usable JSON — review this one manually.',
      goods: [], bads: [`unjudged (${a.error ? 'provider error' : 'bad reply'}) — review manually`],
      _error: lastAskProblem,
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
  // Probe the rebuild and REPORT it. A bad reconstruction poisons everything
  // downstream (a 20s cut request coming back as 3s of video, say), so surface
  // exactly what came out instead of leaving it to be inferred from odd clips.
  const probe = await media.probeMedia(mp4);
  const duration = probe.duration;
  const health = media.assessRebuild(probe);
  await note(agentId, 'coordination',
    `[${label}] rebuilt via ${built.strategy} (layout ${built.info.layout}) — ` +
    `${duration ? Math.round(duration) + 's' : 'unknown length'}, ` +
    `${(probe.streams || []).map(s => `${s.type}/${s.codec}${s.size ? ' ' + s.size : ''}`).join(' + ') || 'no streams'}.`,
    { recording_id: rec.id });
  if (!health.ok) {
    await note(agentId, 'warning',
      `[${label}] the rebuilt recording looks wrong: ${health.problems.join('; ')}. ` +
      `Source layout was "${built.info.layout}" with ${built.info.segments.length} segment(s). ` +
      `Cuts from this recording will be unreliable.`,
      { recording_id: rec.id });
  }

  // 2. LISTEN to the whole thing. Transcribing only slivers around audio spikes
  // was the original mistake — it meant the picker never knew what was actually
  // said, so it chose loud noises instead of moments.
  await setStatus(agentId, rec.id, 'analyzing', { progress: 'extracting audio', duration_s: duration });
  await beat(agentId, `Audio pass on ${label}`);
  const wav = path.join(workDir, 'audio.wav');
  const audio = await media.extractAudio(mp4, wav);
  if (!audio.ok) {
    await setStatus(agentId, rec.id, 'error', { error_msg: `audio extraction failed: ${audio.stderr}` });
    // Say what was tried, not just that it failed — "audio extraction failed"
    // on its own sent us digging through raw ffmpeg logs to learn anything.
    await note(agentId, 'warning', `[${label}] audio extraction failed — ${audio.stderr}`, { recording_id: rec.id });
    return;
  }
  if (audio.partial) {
    await note(agentId, 'warning',
      `[${label}] the recorded audio is damaged; recovered ${Math.round(audio.durationS)}s of ${Math.round(duration)}s via ${audio.how}. ` +
      `Moments after that point won't be found.`, { recording_id: rec.id });
  }

  const track = await media.loudnessTrack(wav);
  // Peaks are now an ANNOTATION of where the energy is, not the thing being cut.
  const peaks = media.findPeaks(track, { minLenS: 3, maxLenS: 45, durationS: duration });

  await setStatus(agentId, rec.id, 'analyzing', { progress: 'transcribing the full recording' });
  await beat(agentId, `Listening to ${label} (full transcript)`);
  const t = await transcribe(wav, null);   // null = whole file
  if (!t.ok) {
    await note(agentId, 'warning', `[${label}] transcription unavailable (${t.error}) — falling back to reaction peaks only, which produces weaker clips.`, { recording_id: rec.id });
  }
  const segCount = (t.segments || []).length;
  await note(agentId, 'status', `[${label}] heard ${segCount} line(s) of speech and ${peaks.length} reaction spike(s).`, { recording_id: rec.id });

  // 3. Rubric (studied once per game) — needed BEFORE selection now, because the
  // model chooses the moments against it rather than merely scoring them after.
  const meta = await ensureRubric(agentId, rec.app_id, rec.game_name).catch(() => null);
  const rubric = (meta && meta.rubric) || FALLBACK_RUBRIC;

  // 4. Let the model pick complete moments out of the whole recording.
  await beat(agentId, `Picking the best moments in ${label}`);
  const timeline = buildTimeline(t.segments, peaks, duration);
  let moments = await selectMoments(timeline, rubric, rec.game_name, duration, cfg.clipLenS);

  // No speech at all (or the picker returned nothing) → fall back to the reaction
  // peaks, but widened to a postable length rather than emitted as fragments.
  if (!moments.length && peaks.length) {
    await note(agentId, 'status', `[${label}] no moments chosen from speech — falling back to the ${peaks.length} strongest reaction(s).`, { recording_id: rec.id });
    moments = peaks
      .sort((a, b) => b.audio_score - a.audio_score)
      .slice(0, 5)
      .map(p => ({ start_s: p.start_s, end_s: p.end_s, title: 'Reaction spike', why: 'Chosen on audio energy — no usable speech in this recording.' }));
  }

  if (!moments.length) {
    await setStatus(agentId, rec.id, 'done', { progress: 'nothing worth cutting' });
    await note(agentId, 'finding', `[${label}] nothing worth posting in this recording.`, { recording_id: rec.id });
    return;
  }

  // Snap every boundary to a conversation break and enforce the length window,
  // so no clip starts or ends mid-word or comes out too short to post.
  const gaps = await media.silenceGaps(wav).catch(() => []);
  const candidates = moments.map(m => {
    const w = clampWindow([m.start_s, m.end_s], { start_s: m.start_s, end_s: m.end_s }, cfg.clipLenS, duration);
    const snappedStart = media.snapToSilence(w.start, gaps, { edge: 'start' });
    const snappedEnd = media.snapToSilence(w.end, gaps, { edge: 'end' });
    // Re-clamp after snapping — a snap can shorten the window below the minimum.
    const f = clampWindow([snappedStart, snappedEnd], { start_s: w.start, end_s: w.end }, cfg.clipLenS, duration);
    return {
      start_s: f.start, end_s: f.end,
      trigger: 'combined',
      audio_score: (peaks.find(p => p.start_s <= f.end && p.end_s >= f.start) || {}).audio_score ?? null,
      transcript: (t.segments || []).filter(s => s.end >= f.start && s.start <= f.end).map(s => s.text).join(' ') || null,
      title: m.title, why: m.why,
    };
  });
  await hub('POST', `/api/clipscan/recordings/${rec.id}/candidates`, { candidates }).catch(() => {});
  await note(agentId, 'status', `[${label}] chose ${candidates.length} moment(s), ${candidates.map(c => Math.round(c.end_s - c.start_s) + 's').join(', ')}.`, { recording_id: rec.id });

  // 5. Score + cut
  await setStatus(agentId, rec.id, 'cutting', { progress: `${candidates.length} moments` });
  const gameDir = path.join(cfg.outDir, sanitizeName(rec.game_name || rec.app_id), (rec.recorded_at || '').slice(0, 10) || 'undated');
  let made = 0;
  let unjudged = 0;
  let blindWarned = false;   // say "judging blind" once per recording, not per cut
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    await beat(agentId, `Scoring ${label} (${i + 1}/${candidates.length})`);
    // Let the judge SEE the moment. Best-effort on purpose: if ffmpeg can't
    // produce stills we still score from audio and transcript, exactly as
    // before, rather than losing scoring altogether.
    let frames = [];
    const frameDir = path.join(require('os').tmpdir(), `clipscan-frames-${rec.id}-${i}`);
    try {
      frames = await media.extractFrames(mp4, c.start_s, c.end_s, frameDir);
      if (!frames.length && !blindWarned) {
        blindWarned = true;
        await note(agentId, 'warning',
          `[${label}] could not grab frames — moments are being judged on audio and transcript only, so the scores will be conservative.`,
          { recording_id: rec.id });
      }
    } catch (e) {
      if (!blindWarned) {
        blindWarned = true;
        await note(agentId, 'warning', `[${label}] frame grab failed (${e.message}) — judging on audio only.`, { recording_id: rec.id });
      }
    }
    const judged = await scoreCandidate(c, rubric, rec.game_name, frames);
    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
    if (judged._error) unjudged++;

    // The window is already chosen, length-clamped and snapped to conversation
    // breaks. The judge scores it — it does NOT get to re-cut it, which is what
    // produced 3-second fragments before.
    const s = c.start_s, e = c.end_s;

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
    // ffmpeg emitting less than we asked for means the source's timestamps are
    // unreliable — say so per clip rather than leaving short clips unexplained.
    if (cut.short) {
      await note(agentId, 'warning', `[${label}] clip at ${Math.round(s)}s is short — ${cut.short}. The rebuilt recording's timestamps are unreliable.`, { recording_id: rec.id });
    }
    const thumbPath = path.join(gameDir, `${base}_thumb.jpg`);
    await media.thumbnail(outPath, thumbPath).catch(() => false);

    // Browser-playable copy for the review grid. The full-res cut above is what
    // gets edited; a 3840-wide H.264 frame is more than phone browsers will
    // decode, and it fails by playing a fraction of a second and stopping.
    const previewPath = path.join(gameDir, `${base}_preview.mp4`);
    const preview = await media.makePreview(outPath, previewPath).catch(e => ({ ok: false, error: e.message }));
    if (!preview.ok) {
      await note(agentId, 'warning', `[${label}] preview encode failed (${preview.error}) — the grid will fall back to the full-size file, which may not play in a browser.`, { recording_id: rec.id });
    } else if (preview.mb > 8) {
      // Previews are streamed from a home uplink to a phone; anything big enough
      // to stall is worth flagging rather than leaving as a mystery buffer.
      await note(agentId, 'warning', `[${label}] preview is ${preview.mb}MB — large enough to stall on a slow link. Lower CLIPSCAN_PREVIEW_KBPS if this keeps happening.`, { recording_id: rec.id });
    }

    const registered = await hub('POST', '/api/clipscan/cuts', {
      recording_id: rec.id, candidate_id: null, agent_id: agentId,
      output_path: outPath, thumbnail_path: fs.existsSync(thumbPath) ? thumbPath : null,
      preview_path: preview.ok ? previewPath : null,
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
        title: c.title || null, picked_because: c.why || null,
        transcript: c.transcript || null, audio_score: c.audio_score,
        agent: `Agent ${agentId}`, cut_mode: cut.mode, created_at: new Date().toISOString(),
      }, null, 2));
    } catch (_) {}

    if (registered) made++;
  }

  await setStatus(agentId, rec.id, 'done', { progress: `${made} cut(s)` });
  await note(agentId, 'finding', `[${label}] done — ${made} cut(s) from ${candidates.length} candidate(s).`, { recording_id: rec.id });

  // If the provider failed, SAY SO. Otherwise every cut just reads "unjudged —
  // review manually" and a usage limit is indistinguishable from a broken CLI.
  if (unjudged) {
    await note(agentId, 'warning',
      `[${label}] ${unjudged} of ${candidates.length} moment(s) could not be scored. Reason: ${lastAskProblem || 'unknown'}. ` +
      `The clips were still cut — only the score and rationale are missing. If this is a usage limit, they can be re-scored later; ` +
      `set CLIPSCAN_PROVIDER to another agent (codex/gemini) to score with a different one.`,
      { recording_id: rec.id });
  }
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
  // Non-blocking gaps (e.g. no transcriber) go on the board so a degraded run is
  // obvious from the start rather than inferred from every rationale.
  for (const w of (pre.warnings || [])) await note(null, 'warning', w);
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

// Called on agent boot. `running` lives in this process, so every agent update
// left the workers stopped while the dashboard still showed them started — the
// batch just quietly stalled. The hub remembers the intent, so ask it.
//
// Retries for a while: the agent usually comes up before the hub is reachable,
// and giving up on the first connection error would reintroduce the exact
// problem this exists to fix.
async function resume({ attempts = 10, delayMs = 15000 } = {}) {
  if (!HUB_URL || !AGENT_SECRET) return { running: false, reason: 'agent is not configured for the hub' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await hub('GET', '/api/clipscan/workers/desired', null, { timeoutMs: 15000 });
      if (!r || !r.running) return { running: false, reason: 'the hub says the workers should be stopped' };
      const started = await start();
      if (started.running) await note(null, 'coordination', 'Clip-scan workers resumed automatically after an agent restart.');
      return started;
    } catch (_) {
      await sleep(delayMs);   // hub not up yet — keep trying
    }
  }
  return { running: false, reason: 'could not reach the hub to ask whether to resume' };
}

function status() {
  return {
    running, workers: loops.length,
    agents: Object.entries(state).map(([id, s]) => ({ id: Number(id), ...s })),
  };
}

module.exports = {
  start, stop, status, resume,
  // exported for tests
  attachTranscripts, extractJson, transcribe, processRecording, sanitizeName,
  clampWindow, FALLBACK_RUBRIC, buildTimeline, selectMoments, fmtTs, serialise, ask, scoreCandidate,
};
