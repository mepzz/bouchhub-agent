// bouchhub-agent/test/claude-voice.test.js
//
// The voice endpoint's runner: the argv it builds for the Claude CLI (every
// flag the hub relies on, sanitised model alias, quoted tool patterns), the
// NDJSON streaming of the CLI's output as it arrives, temp-file cleanup, the
// timeout kill, and the small concurrency cap that keeps voice questions from
// queueing behind autopilot work. A shell script stands in for the CLI.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('../claude');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.sh');
fs.chmodSync(FAKE, 0o755);

// Minimal ServerResponse stand-in that records the NDJSON it was sent.
function fakeRes() {
  const out = { head: null, chunks: [], ended: false, handlers: {} };
  return {
    out,
    writeHead: (status, headers) => { out.head = { status, headers }; },
    write: (c) => { out.chunks.push(String(c)); return true; },
    end: () => { out.ended = true; if (out.handlers.close) out.handlers.close(); },
    on: (ev, fn) => { out.handlers[ev] = fn; },
    get lines() { return out.chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
  };
}

(async () => {
  console.log('Voice CLI runner tests');

  await test('buildVoiceArgs carries every flag the hub relies on, quoted and sanitised', () => {
    const args = claude.buildVoiceArgs({ provider: 'claude', model: 'haiku; rm -rf /', mcpPath: '/tmp/m.json', systemPromptPath: '/tmp/s.md', resumeSessionId: 'abc-123' });
    const line = args.join(' ');
    assert.ok(line.startsWith('-p --output-format stream-json --verbose --include-partial-messages'), line);
    assert.ok(line.includes('--model haikurm-rf'), 'model alias reduced to safe characters: ' + line);
    assert.ok(line.includes('--mcp-config "/tmp/m.json" --strict-mcp-config'), line);
    assert.ok(line.includes('--allowedTools "mcp__bouch__*" "WebSearch"'), line);
    assert.ok(line.includes('--append-system-prompt-file "/tmp/s.md"'), line);
    assert.ok(line.includes('--resume abc-123'), line);
    assert.ok(line.endsWith('--dangerously-skip-permissions'), line);
    const noResume = claude.buildVoiceArgs({ provider: 'claude', resumeSessionId: 'bad id; x' }).join(' ');
    assert.ok(!noResume.includes('--resume'), 'an unsafe session id is dropped, not quoted');
    assert.ok(!claude.buildVoiceArgs({ provider: 'claude', allowedTools: ['ok_tool', 'bad tool"'] }).join(' ').includes('bad'), 'unsafe tool patterns are dropped');
  });

  await test('voice() streams the CLI output as NDJSON, wraps non-JSON lines, and appends agent_done', async () => {
    const res = fakeRes();
    const r = await claude.voice({ provider: 'claude', prompt: 'what is playing', model: 'haiku', systemPrompt: 'speak short', mcpUrl: 'http://127.0.0.1:3000/mcp/voice/tok', mcpToken: 'tok', timeoutMs: 5000, bin: `sh ${FAKE}` }, res);
    assert.strictEqual(res.out.head.status, 200);
    assert.strictEqual(res.out.head.headers['Content-Type'], 'application/x-ndjson');
    const lines = res.lines;
    assert.strictEqual(lines[0].type, 'system');
    assert.strictEqual(lines[0].prompt, 'what is playing', 'the prompt reached stdin');
    // The shell has consumed our quotes by the time the CLI sees argv — which
    // is the point: the glob pattern arrives literally, unexpanded.
    assert.ok(/--mcp-config \S*bouchhub-voice-mcp-\S*\.json --strict-mcp-config/.test(lines[0].argv), lines[0].argv);
    assert.ok(/--append-system-prompt-file \S*bouchhub-voice-system-\S*\.md/.test(lines[0].argv), lines[0].argv);
    assert.ok(lines[0].argv.includes('--allowedTools mcp__bouch__* WebSearch'), lines[0].argv);
    assert.ok(lines[0].argv.includes('--model haiku'));
    assert.strictEqual(lines[1].type, 'assistant', 'a line split across two writes is reassembled');
    assert.strictEqual(lines[1].message.content[0].text, 'Hello there.');
    assert.deepStrictEqual(lines[2], { type: 'raw', line: 'this line is not json' });
    assert.strictEqual(lines[3].type, 'result');
    assert.deepStrictEqual(lines[4], { type: 'agent_done', code: 0, timedOut: false, stderr: '' });
    assert.strictEqual(res.out.ended, true);
    assert.deepStrictEqual(r, { code: 0, timedOut: false });
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => /^bouchhub-voice-(prompt|system|mcp)-/.test(f));
    assert.deepStrictEqual(leftovers, [], 'temp prompt/system/mcp files are removed');
  });

  await test('a hanging CLI is killed at the timeout and reported as timedOut', async () => {
    const res = fakeRes();
    const started = Date.now();
    process.env.FAKE_CLAUDE_HANG = '1';
    try {
      const r = await claude.voice({ provider: 'claude', prompt: 'x', timeoutMs: 500, bin: `sh ${FAKE}` }, res);
      assert.strictEqual(r.timedOut, true);
      assert.ok(Date.now() - started < 5000);
      const done = res.lines.find((l) => l.type === 'agent_done');
      assert.strictEqual(done.timedOut, true);
    } finally { delete process.env.FAKE_CLAUDE_HANG; }
  });

  await test('a non-zero exit surfaces in agent_done', async () => {
    const res = fakeRes();
    process.env.FAKE_CLAUDE_EXIT = '3';
    try {
      const r = await claude.voice({ provider: 'claude', prompt: 'x', timeoutMs: 5000, bin: `sh ${FAKE}` }, res);
      assert.strictEqual(r.code, 3);
      assert.strictEqual(res.lines.find((l) => l.type === 'agent_done').code, 3);
    } finally { delete process.env.FAKE_CLAUDE_EXIT; }
  });

  await test('at most two voice questions run per provider; a third is refused up front', async () => {
    process.env.FAKE_CLAUDE_HANG = '1';
    try {
      const a = claude.voice({ provider: 'claude', prompt: 'a', timeoutMs: 800, bin: `sh ${FAKE}` }, fakeRes());
      const b = claude.voice({ provider: 'claude', prompt: 'b', timeoutMs: 800, bin: `sh ${FAKE}` }, fakeRes());
      await new Promise((r) => setTimeout(r, 100));
      await assert.rejects(() => claude.voice({ provider: 'claude', prompt: 'c', timeoutMs: 800, bin: `sh ${FAKE}` }, fakeRes()), /already answering 2 voice questions/);
      await Promise.all([a, b]);
    } finally { delete process.env.FAKE_CLAUDE_HANG; }
    // and the slots are released afterwards
    const r = await claude.voice({ provider: 'claude', prompt: 'd', timeoutMs: 5000, bin: `sh ${FAKE}` }, fakeRes());
    assert.strictEqual(r.code, 0);
  });

  await test('voice() without a prompt is refused', async () => {
    await assert.rejects(() => claude.voice({ provider: 'claude' }, fakeRes()), /needs a prompt/);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
