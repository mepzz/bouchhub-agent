// bouchhub-agent/test/claude-run.test.js
//
// The subprocess runner. Everything here is about what happens when a CLI does
// NOT behave — which is the common case, because the failure this code exists
// to survive is a CLI sitting forever at an interactive prompt.

const assert = require('assert');
const claude = require('../claude');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

(async () => {
  console.log('CLI runner tests');

  await test('an ordinary command returns its output', async () => {
    const r = await claude._run('echo', ['hello'], { timeoutMs: 5000 });
    assert.ok(/hello/.test(r.out), r.out);
    assert.strictEqual(r.timedOut, false);
  });

  await test('a command that hangs is killed and reported as a timeout', async () => {
    // Not just "it failed": a timeout has no exit code and no stderr, so
    // without this flag it surfaced as "completion failed (code null): " —
    // which says nothing about the only thing that actually happened.
    const started = Date.now();
    const r = await claude._run('sleep', ['30'], { timeoutMs: 400 });
    assert.strictEqual(r.timedOut, true);
    assert.ok(Date.now() - started < 5000, 'it did not wait out the full sleep');
  });

  await test('the thing the shell started dies too, not just the shell', async () => {
    // These run with shell:true, so the child is the shell and the CLI is its
    // grandchild. Killing only the shell left a live claude.exe behind on every
    // timed-out call, on a machine already short of memory.
    const { execSync } = require('child_process');
    const marker = `bouchhub-killtree-${process.pid}`;
    await claude._run('sh', ['-c', `sleep 30 # ${marker}`], { timeoutMs: 400 });
    await new Promise(r => setTimeout(r, 600));
    let survivors = '';
    try { survivors = execSync(`ps -ef | grep -F '${marker}' | grep -v grep || true`).toString().trim(); } catch (_) {}
    assert.strictEqual(survivors, '', `orphan left behind:\n${survivors}`);
  });

  await test('killing something already gone is not an error', async () => {
    const r = await claude._run('echo', ['done'], { timeoutMs: 5000 });
    assert.strictEqual(r.timedOut, false);
    claude._killTree(null);
    claude._killTree({ pid: 999999, exitCode: 0 });
  });

  console.log(`\n${passed} passed`);
})();
