// bouchhub-agent/test/clipMedia.test.js
// The pure parts of the clip pipeline: how a Steam folder's layout is detected,
// how segments get ordered, and how audio peaks become candidate moments.
// None of this needs ffmpeg installed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const media = require('../clipMedia');
const worker = require('../clipWorker');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

function mk(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfolder-'));
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  return dir;
}

console.log('Clip media tests');

// ── Layout detection ─────────────────────────────────────────────────────────
// Steam's clip format varies by client version, so the reconstructor inspects
// the folder rather than assuming. Each shape must be recognized.
test('detects a DASH manifest layout', () => {
  const dir = mk(['session.mpd', 'video/init.m4s', 'video/seg1.m4s']);
  const info = media.inspectFolder(dir);
  assert.strictEqual(info.layout, 'dash-manifest');
  assert.ok(info.manifest.endsWith('session.mpd'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detects a bare fragmented-segment layout', () => {
  const dir = mk(['video/init.m4s', 'video/seg1.m4s', 'video/seg2.m4s', 'audio/init.m4s', 'audio/seg1.m4s']);
  const info = media.inspectFolder(dir);
  assert.strictEqual(info.layout, 'segments');
  assert.strictEqual(info.segments.length, 5);
  assert.strictEqual(info.inits.length, 2, 'init segments are identified');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detects an already-complete single mp4', () => {
  const dir = mk(['clip.mp4']);
  assert.strictEqual(media.inspectFolder(dir).layout, 'single-file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder with BOTH a manifest and many segments still exposes the segments', () => {
  // Steam writes a live/rolling manifest alongside the real segments: the .mpd
  // advertises only the currently-available window, so remuxing it yields ~3s
  // while hundreds of segments sit on disk. reconstruct() must therefore be able
  // to see and prefer the segments — the manifest is a fallback, not the plan.
  const files = ['session.mpd', 'init-stream0.m4s'];
  for (let i = 2035; i < 2060; i++) files.push(`chunk-stream0-0${i}.m4s`);
  const dir = mk(files);
  const info = media.inspectFolder(dir);
  assert.ok(info.manifest, 'the manifest is found');
  assert.ok(info.segments.length > 20, 'and so are all the segments');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrecognizable folder reports "unknown" rather than guessing', () => {
  const dir = mk(['notes.txt', 'thumbnail.png']);
  assert.strictEqual(media.inspectFolder(dir).layout, 'unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Segment ordering ─────────────────────────────────────────────────────────
test('orders segments numerically, not lexically, with init first', () => {
  const files = ['/x/seg2.m4s', '/x/seg10.m4s', '/x/seg1.m4s', '/x/init.m4s'];
  const ordered = media.orderSegments(files).map(f => path.basename(f));
  assert.deepStrictEqual(ordered, ['init.m4s', 'seg1.m4s', 'seg2.m4s', 'seg10.m4s'],
    'seg10 must come after seg2 — lexical sort would corrupt the video');
});

// Steam Game Recording's REAL layout, taken off the live box:
//   video/bg_<appid>_<date>_<time>/init-stream<N>.m4s + chunk-stream<N>-#####.m4s
// (clips/clip_* folders are empty bookmarks — no footage at all, which is why
// pointing the pipeline at them produced 3-second scraps.)
test('groups real Steam DASH chunks by stream index', () => {
  const g = media.groupStreams([
    '/bg/init-stream0.m4s', '/bg/chunk-stream0-02035.m4s', '/bg/chunk-stream0-02036.m4s',
    '/bg/init-stream1.m4s', '/bg/chunk-stream1-02035.m4s',
  ]);
  assert.deepStrictEqual(Object.keys(g).sort(), ['stream0', 'stream1'],
    'video and audio chunks land in separate streams, not one bucket');
  assert.strictEqual(g.stream0.length, 3);
  assert.strictEqual(g.stream1.length, 2);
});

test('each stream leads with its own init segment', () => {
  const g = media.groupStreams(['/bg/chunk-stream0-02036.m4s', '/bg/init-stream0.m4s', '/bg/chunk-stream0-02035.m4s']);
  assert.match(path.basename(g.stream0[0]), /^init/, 'the moov comes first or nothing decodes');
});

test('five-digit chunk numbers order correctly across a long session', () => {
  // A real session is ~277 chunks numbered from 02035 upward.
  const files = ['/bg/chunk-stream0-02310.m4s', '/bg/chunk-stream0-02035.m4s', '/bg/chunk-stream0-02100.m4s', '/bg/init-stream0.m4s'];
  assert.deepStrictEqual(media.orderSegments(files).map(f => path.basename(f)),
    ['init-stream0.m4s', 'chunk-stream0-02035.m4s', 'chunk-stream0-02100.m4s', 'chunk-stream0-02310.m4s']);
});

test('separates audio and video streams for muxing', () => {
  const groups = media.groupStreams([
    '/c/video/init.m4s', '/c/video/seg1.m4s', '/c/audio/init.m4s', '/c/audio/seg1.m4s',
  ]);
  assert.ok(groups.video && groups.audio, 'both streams recognized');
  assert.strictEqual(groups.video.length, 2);
  assert.ok(/init/.test(path.basename(groups.audio[0])), 'init leads each stream');
});

// ── Audio-first candidate detection ──────────────────────────────────────────
// Build a synthetic loudness track: quiet room tone with two bursts.
function track({ seconds = 200, step = 0.5, base = -40, bursts = [] } = {}) {
  const out = [];
  for (let t = 0; t < seconds; t += step) {
    let db = base;
    for (const b of bursts) if (t >= b.at && t < b.at + b.len) db = b.db;
    out.push({ t: Math.round(t * 100) / 100, db });
  }
  return out;
}

test('finds a loud burst against the room tone', () => {
  const peaks = media.findPeaks(track({ bursts: [{ at: 100, len: 3, db: -18 }] }), { durationS: 200 });
  assert.strictEqual(peaks.length, 1, 'one moment found');
  const p = peaks[0];
  assert.ok(p.start_s < 100 && p.end_s > 103, 'the burst is inside the window with padding');
  assert.ok(p.audio_score > 0, 'carries a peak strength');
});

test('ignores a track with no burst — silence yields nothing', () => {
  assert.deepStrictEqual(media.findPeaks(track({}), { durationS: 200 }), [], 'flat audio produces no candidates');
});

test('adapts to a loud clip — it is the RISE that matters, not absolute volume', () => {
  // Same relative burst, but the whole clip is 20dB louder. A global threshold
  // would flag everything here; a rolling baseline flags only the burst.
  const loud = media.findPeaks(track({ base: -20, bursts: [{ at: 100, len: 3, db: 2 }] }), { durationS: 200 });
  assert.strictEqual(loud.length, 1, 'still exactly one moment on a loud clip');
});

test('grows a blink-length burst up to the minimum clip length', () => {
  const peaks = media.findPeaks(track({ bursts: [{ at: 50, len: 1, db: -15 }] }), { minLenS: 7, maxLenS: 30, durationS: 200 });
  const len = peaks[0].end_s - peaks[0].start_s;
  assert.ok(len >= 7, `a 1s burst is padded out to a postable length (got ${len}s)`);
});

test('caps a long burst at the maximum clip length', () => {
  // Baseline window widened past the burst so it IS detected — see the next
  // test for what happens when a burst outlasts the baseline window.
  const peaks = media.findPeaks(track({ seconds: 300, bursts: [{ at: 50, len: 40, db: -15 }] }),
    { minLenS: 7, maxLenS: 30, baselineWindowS: 120, durationS: 300 });
  assert.strictEqual(peaks.length, 1);
  assert.ok(peaks[0].end_s - peaks[0].start_s <= 30, 'never emits an unpostable 40s clip');
});

test('sustained loudness becomes its own baseline and is not flagged', () => {
  // BY DESIGN: the detector looks for a RISE above the surrounding level. A
  // stretch louder than everything for longer than the baseline window (here 60s
  // vs a 20s window) is just how that part of the clip sounds — flagging the
  // whole thing as one "moment" would produce something unpostable. Peaks WITHIN
  // such a stretch still register, because they rise above it.
  const flat = media.findPeaks(track({ seconds: 300, bursts: [{ at: 50, len: 60, db: -15 }] }), { durationS: 300 });
  assert.deepStrictEqual(flat, [], 'a long uniform loud stretch is not a moment');
  const withSpike = media.findPeaks(track({
    seconds: 300, bursts: [{ at: 50, len: 60, db: -15 }, { at: 80, len: 2, db: 0 }],
  }), { durationS: 300 });
  assert.ok(withSpike.length >= 1, 'but a genuine spike inside it is still caught');
});

test('never runs past the end of the recording', () => {
  const peaks = media.findPeaks(track({ seconds: 60, bursts: [{ at: 58, len: 2, db: -15 }] }), { durationS: 60 });
  assert.ok(peaks.every(p => p.end_s <= 60), 'padding is clamped to the clip length');
  assert.ok(peaks.every(p => p.start_s >= 0), 'and never negative');
});

test('merges overlapping windows but will not fuse past the max length', () => {
  const merged = media.mergeOverlaps([
    { start_s: 10, end_s: 22, audio_score: 0.5 },
    { start_s: 20, end_s: 30, audio_score: 0.9 },
  ], 30);
  assert.strictEqual(merged.length, 1, 'overlapping moments are one moment');
  assert.strictEqual(merged[0].audio_score, 0.9, 'keeps the strongest peak');

  const kept = media.mergeOverlaps([
    { start_s: 0, end_s: 28, audio_score: 0.5 },
    { start_s: 27, end_s: 60, audio_score: 0.5 },
  ], 30);
  assert.strictEqual(kept.length, 2, 'merging past the max length is refused — two clips, not one blob');
});

// ── Worker helpers ───────────────────────────────────────────────────────────
test('transcript lines are attached to the candidate window they fall in', () => {
  const out = worker.attachTranscripts(
    [{ start_s: 10, end_s: 20, trigger: 'audio_peak' }, { start_s: 100, end_s: 110, trigger: 'audio_peak' }],
    [{ start: 11, end: 13, text: 'where did he go' }, { start: 101, end: 103, text: 'no way' }, { start: 500, end: 501, text: 'unrelated' }],
  );
  assert.strictEqual(out[0].transcript, 'where did he go');
  assert.strictEqual(out[1].transcript, 'no way');
  assert.strictEqual(out[0].trigger, 'combined', 'a window with speech is flagged combined');
});

test('a window with no speech keeps its audio trigger and a null transcript', () => {
  const out = worker.attachTranscripts([{ start_s: 0, end_s: 5, trigger: 'audio_peak' }], []);
  assert.strictEqual(out[0].transcript, null);
  assert.strictEqual(out[0].trigger, 'audio_peak');
});

test('JSON is recovered from a model reply even when it is fenced or chatty', () => {
  assert.strictEqual(worker.extractJson('```json\n{"score":88}\n```').score, 88, 'fenced');
  assert.strictEqual(worker.extractJson('Sure! {"score":42} hope that helps').score, 42, 'wrapped in prose');
  assert.strictEqual(worker.extractJson('{"a":{"b":2},"score":7}').score, 7, 'nested braces');
  assert.strictEqual(worker.extractJson('no json here'), null, 'gives up cleanly');
});

// ── The judge's suggested window is clamped back to something postable ───────
// Regression: a real run emitted a 3s clip because the judge's
// recommended_length_s was trusted verbatim, below the 7s configured minimum.
test('a too-short suggested window is grown to the minimum around its midpoint', () => {
  const c = { start_s: 100, end_s: 118 };
  const w = worker.clampWindow([110, 113], c, [7, 30], 600);
  assert.ok(w.end - w.start >= 7, `grown to the minimum (got ${w.end - w.start}s)`);
  assert.ok(w.start < 111.5 && w.end > 111.5, 'grown around the middle of what the judge picked');
});

test('a too-long suggested window is capped at the maximum', () => {
  const w = worker.clampWindow([10, 90], { start_s: 10, end_s: 40 }, [7, 30], 600);
  assert.strictEqual(w.end - w.start, 30, 'capped at the configured maximum');
});

test('a sensible suggested window is left alone', () => {
  const w = worker.clampWindow([120.5, 134], { start_s: 118, end_s: 140 }, [7, 30], 600);
  assert.strictEqual(w.start, 120.5);
  assert.strictEqual(w.end, 134);
});

test('a garbage suggestion falls back to the detected candidate', () => {
  const c = { start_s: 50, end_s: 62 };
  for (const bad of [null, undefined, [], ['x', 'y'], [30, 10], [5]]) {
    const w = worker.clampWindow(bad, c, [7, 30], 600);
    assert.strictEqual(w.start, 50, `fell back for ${JSON.stringify(bad)}`);
    assert.strictEqual(w.end, 62);
  }
});

test('the window is kept inside the recording without collapsing', () => {
  // Near the end: growing to the minimum must shift the start back, not run past.
  const w = worker.clampWindow([297, 299], { start_s: 295, end_s: 300 }, [7, 30], 300);
  assert.ok(w.end <= 300, 'never past the end of the recording');
  assert.ok(w.start >= 0, 'never negative');
  assert.ok(w.end - w.start >= 7, 'still grown to a postable length by shifting the start back');
  // Near the start: the same in the other direction.
  const w2 = worker.clampWindow([1, 3], { start_s: 0, end_s: 5 }, [7, 30], 300);
  assert.strictEqual(w2.start, 0, 'clamped to the beginning');
  assert.ok(w2.end - w2.start >= 7, 'and grown forwards instead');
});

test('a recording shorter than the minimum yields what exists, not a negative window', () => {
  const w = worker.clampWindow([1, 3], { start_s: 0, end_s: 4 }, [7, 30], 4);
  assert.ok(w.start >= 0 && w.end <= 4, 'stays inside a 4s recording');
  assert.ok(w.end > w.start, 'still a real window');
});

// ── Conversation-break snapping ──────────────────────────────────────────────
test('cut boundaries snap to natural conversation breaks', () => {
  const gaps = [{ start: 9.5, end: 10.2 }, { start: 38.0, end: 39.1 }];
  // A start near a gap begins where speech RESUMES, not mid-silence.
  assert.strictEqual(media.snapToSilence(10.0, gaps, { edge: 'start' }), 10.2);
  // An end near a gap stops where speech FINISHES.
  assert.strictEqual(media.snapToSilence(38.4, gaps, { edge: 'end' }), 38.0);
});

test('a boundary far from any break is left where it is', () => {
  const gaps = [{ start: 9.5, end: 10.2 }];
  assert.strictEqual(media.snapToSilence(200, gaps, { edge: 'start' }), 200, 'no gap within the window → unchanged');
  assert.strictEqual(media.snapToSilence(50, [], { edge: 'start' }), 50, 'no gaps at all → unchanged');
});

// ── The transcript timeline the picker reads ─────────────────────────────────
test('the timeline gives the model every line with a timestamp', () => {
  const tl = worker.buildTimeline(
    [{ start: 5, end: 8, text: 'where did he go' }, { start: 65, end: 67, text: 'no way' }],
    [{ start_s: 64, end_s: 68, audio_score: 0.9 }],
    120,
  );
  assert.ok(tl.includes('where did he go'), 'includes what was said');
  assert.ok(tl.includes('[0:05'), 'timestamps each line');
  assert.ok(tl.includes('[1:05'), 'formats past a minute correctly');
  assert.ok(tl.includes('🔊'), 'marks where the reaction energy is');
});

test('a loud reaction with no words still reaches the model', () => {
  // Pure laughter/screaming has no transcript line, but it is exactly the kind
  // of moment worth clipping — it must not vanish from the timeline.
  const tl = worker.buildTimeline([{ start: 5, end: 8, text: 'hello' }], [{ start_s: 90, end_s: 95, audio_score: 0.95 }], 120);
  assert.ok(/loud reaction, no words/.test(tl), 'wordless reactions are surfaced');
  assert.ok(tl.indexOf('hello') < tl.indexOf('loud reaction'), 'the timeline stays in chronological order');
});

test('an empty recording produces an empty timeline rather than throwing', () => {
  assert.strictEqual(worker.buildTimeline([], [], 100), '');
  assert.strictEqual(worker.buildTimeline(null, null, 100), '');
});

test('timestamps are formatted for a human/model to read', () => {
  assert.strictEqual(worker.fmtTs(0), '0:00');
  assert.strictEqual(worker.fmtTs(9), '0:09');
  assert.strictEqual(worker.fmtTs(75), '1:15');
  assert.strictEqual(worker.fmtTs(605), '10:05');
});

test('the clip length window is the postable range, not fragments', () => {
  // Regression on the whole complaint: 7s produced unpostable 3s-feeling clips.
  assert.deepStrictEqual(worker.FALLBACK_RUBRIC.ideal_length_s, [20, 60],
    'the fallback rubric targets the short-form range');
});

test('there is always a rubric to judge against', () => {
  assert.ok(worker.FALLBACK_RUBRIC.winning_patterns.length, 'the fallback has real content');
  assert.strictEqual(worker.FALLBACK_RUBRIC._fallback, true, 'and is flagged so a degraded run is visible');
});

test('game names are made safe for a Windows folder path', () => {
  assert.strictEqual(worker.sanitizeName('MECCHA CHAMELEON'), 'MECCHA CHAMELEON', 'ordinary names survive');
  assert.strictEqual(worker.sanitizeName('Half-Life: Alyx?'), 'Half-Life Alyx', 'illegal characters removed');
  assert.strictEqual(worker.sanitizeName(''), 'unknown', 'empty falls back');
});

// The sync harness above can't await, and the queue below is the whole point of
// the fix, so it gets its own async runner rather than a fake synchronous check.
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

(async () => {
  await atest('model calls are taken one at a time, never concurrently', async () => {
    // Four workers hitting one shared ~/.claude raced each other: the CLI exited
    // 0 with empty output and every moment came back "unjudged".
    let inFlight = 0, maxInFlight = 0;
    const done = [];
    // Descending delays: if these ran concurrently they would finish 3,2,1.
    const job = (n) => worker.serialise(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30 - n * 8));
      inFlight--; done.push(n);
      return n;
    });
    const results = await Promise.all([job(1), job(2), job(3)]);
    assert.strictEqual(maxInFlight, 1, 'only one provider call is ever in flight');
    assert.deepStrictEqual(done, [1, 2, 3], 'they run in the order they were queued');
    assert.deepStrictEqual(results, [1, 2, 3], 'each caller gets its own result back');
  });

  await atest('one failed call does not wedge the queue behind it', async () => {
    await worker.serialise(async () => { throw new Error('provider died'); }).catch(() => {});
    assert.strictEqual(await worker.serialise(async () => 'ok'), 'ok');
  });

  await atest('an empty provider reply is retried once before giving up', async () => {
    process.env.CLIPSCAN_RETRY_MS = '1';
    const claude = require('../claude');
    const real = claude.complete;
    try {
      let calls = 0;
      claude.complete = async () => (++calls === 1 ? { text: '' } : { text: '{"score":42}' });
      const r = await worker.ask('score this');
      assert.strictEqual(calls, 2, 'the transient empty reply was retried');
      assert.strictEqual(r.text, '{"score":42}', 'and the retry\'s answer is used');

      calls = 0;
      claude.complete = async () => { calls++; return { text: '' }; };
      const dead = await worker.ask('score this');
      assert.strictEqual(calls, 2, 'it gives up after one retry rather than looping');
      assert.ok(/retried once/.test(dead.error), 'and says so, instead of a bare "unjudged"');
    } finally {
      claude.complete = real;
      delete process.env.CLIPSCAN_RETRY_MS;
    }
  });

  await atest('a dead login is named, not mistaken for a model answer', async () => {
    const claude = require('../claude');
    // The exact reply the CLI gave on the live box, on STDOUT, with exit 1.
    assert.ok(claude.authFailure('Failed to authenticate: OAuth session expired and could not be refreshed'),
      'the expired-OAuth message is recognised');
    assert.ok(claude.authFailure('Invalid API key · Please run /login'), 'so is a login prompt');
    assert.strictEqual(claude.authFailure('{"score":42,"why":"the session expired in-game"}'), null,
      'ordinary model output is not mistaken for an auth failure');
    assert.strictEqual(claude.authFailure(''), null);
  });

  await atest('the reason is quoted from the message, not the front of the JSON blob', async () => {
    const claude = require('../claude');
    // What --output-format json really looks like: one line, the sentence you
    // need buried behind session ids and token counts.
    const line = JSON.stringify({
      is_error: true, duration_api_ms: 0, num_turns: 1, stop_reason: 'stop_sequence',
      session_id: '3e1fca55-a475-4979-8673-78cb75162e8e', total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0 },
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
    const found = claude.authFailure(line);
    assert.ok(found, 'the failure is still detected inside the JSON');
    assert.ok(/OAuth session expired/.test(found), `the message is quoted, got: ${found}`);
    assert.ok(!/session_id|total_cost_usd/.test(found), 'and the bookkeeping is left out');
  });

  await atest('a non-zero exit is reported instead of being scored', async () => {
    process.env.CLIPSCAN_RETRY_MS = '1';
    const claude = require('../claude');
    const real = claude.complete;
    try {
      let calls = 0;
      claude.complete = async () => {
        calls++;
        return { text: 'Failed to authenticate: OAuth session expired and could not be refreshed', code: 1 };
      };
      const r = await worker.ask('score this');
      assert.strictEqual(r.text, '', 'the error text is never handed back as a score');
      assert.ok(/exited 1/.test(r.error) && /OAuth/.test(r.error), 'the reason survives to the board');
      assert.strictEqual(calls, 1, 'and a dead login is not retried — it will not fix itself');
    } finally {
      claude.complete = real;
      delete process.env.CLIPSCAN_RETRY_MS;
    }
  });

  await atest('frame sampling opens on the hook and never runs past the end', () => {
    // Every rationale the judge produced complained it could not confirm what
    // was on screen in the first ~1.5s, so the first sample is deliberately early.
    const t = media.frameTimes(100, 140, 6);
    assert.strictEqual(t.length, 6, 'six samples across the window');
    assert.ok(t[0] >= 100 && t[0] <= 101.5, `first frame is in the opening hook, got ${t[0]}`);
    assert.ok(t.every(x => x >= 100 && x <= 140), 'every sample lies inside the window');
    assert.ok(t[t.length - 1] < 140, 'the last sample stops short of the end, which is often black');
    assert.deepStrictEqual([...t].sort((a, b) => a - b), t, 'samples are in order');
  });

  await atest('frame sampling copes with degenerate windows', () => {
    assert.deepStrictEqual(media.frameTimes(10, 10, 6), [], 'a zero-length window yields nothing');
    assert.deepStrictEqual(media.frameTimes(5, 3, 6), [], 'a backwards window yields nothing');
    assert.strictEqual(media.frameTimes(0, 20, 1).length, 1, 'a single sample is the midpoint');
    const short = media.frameTimes(0, 1, 6);
    assert.ok(short.length && short.every(x => x >= 0 && x <= 1), 'a one-second window still produces valid times');
  });

  await atest('damaged audio is recovered rather than abandoned', async () => {
    // Steam's joined AAC makes ffmpeg abort with "Conversion failed!" AFTER it
    // has already written minutes of good audio. Losing the whole recording over
    // that is the bug; the partial track is the recording.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipaudio-'));
    const wav = path.join(dir, 'audio.wav');
    const calls = [];
    try {
      // Attempt 1 (clean) writes 249s of audio then dies, exactly like the log.
      const exec = async (_bin, args) => {
        calls.push(args.join(' '));
        fs.writeFileSync(wav, 'x');
        return { code: 1, stderr: 'Conversion failed!' };
      };
      const r = await media.extractAudio('in.mp4', wav, { ffmpeg: 'ffmpeg', exec, probe: async () => 249.6 });
      assert.strictEqual(r.ok, true, 'the partial track is accepted');
      assert.strictEqual(r.partial, true, 'and it is flagged as partial, not passed off as complete');
      assert.ok(/clean/.test(r.how), `it reports which route worked, got ${r.how}`);
      assert.strictEqual(Math.round(r.durationS), 250, 'and says how much was recovered');
      assert.strictEqual(calls.length, 1, 'no pointless retry once there is usable audio');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await atest('audio with nothing usable escalates through every route, then explains', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipaudio-'));
    const wav = path.join(dir, 'audio.wav');
    const seen = [];
    try {
      const exec = async (_bin, args) => { seen.push(args.join(' ')); return { code: 1, stderr: 'invalid band type' }; };
      const r = await media.extractAudio('in.mp4', wav, { ffmpeg: 'ffmpeg', exec, probe: async () => 0 });
      assert.strictEqual(r.ok, false);
      assert.ok(seen.some(a => /discardcorrupt/.test(a)), 'it tried the tolerant decode');
      assert.ok(seen.some(a => /-c:a copy/.test(a)), 'and the raw-AAC route that sidesteps the container');
      assert.ok(/clean.*error-tolerant/s.test(r.stderr), `the report names what was tried, got: ${r.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await atest('a failed look at the frames falls back to scoring, not to "unjudged"', async () => {
    const claude = require('../claude');
    const real = claude.complete;
    try {
      const seen = [];
      claude.complete = async ({ prompt, allowTools }) => {
        seen.push({ withFrames: /frame grabs/i.test(prompt), allowTools: allowTools || [] });
        // The tool-using call fails; the plain text one works.
        if (allowTools && allowTools.length) return { text: 'I cannot open those files.' };
        return { text: '{"score":71,"rationale":"good","goods":["a"],"bads":["b"]}' };
      };
      const cand = { start_s: 10, end_s: 40, transcript: 'hi', audio_score: 0.5 };
      const out = await worker.scoreCandidate(cand, worker.FALLBACK_RUBRIC, 'A Game',
        [{ path: 'C:/tmp/frame01.jpg', atS: 10.8 }]);
      assert.strictEqual(out.score, 71, 'the fallback score is used');
      assert.ok(!out._error, 'it is NOT flagged unjudged');
      assert.ok(out.bads.some(b => /without frames/i.test(b)), 'and it admits the visual is unverified');
      assert.ok(seen[0].allowTools.includes('Read'), 'the first attempt asked to read the frames');
      assert.ok(seen[0].withFrames, 'the first prompt actually listed the frames');
      assert.strictEqual(seen[1].allowTools.length, 0, 'the retry dropped the tool');
    } finally { claude.complete = real; }
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
