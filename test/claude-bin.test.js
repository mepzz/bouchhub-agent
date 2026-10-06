// bouchhub-agent/test/claude-bin.test.js
//
// The resolved-CLI cache must not outlive the CLI. After a native reinstall the
// old npm `claude.cmd` path is gone; the cached path used to be launched anyway
// ("'...\npm\claude.cmd' is not recognized"), killing every completion and —
// because voice() read the cache directly — every "Hey Claude".

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

(async () => {
  console.log('CLI binary cache tests');

  await test('a path that no longer exists is "gone"; one that does is not', () => {
    const real = path.join(os.tmpdir(), `bin-test-${process.pid}.cmd`);
    fs.writeFileSync(real, '');
    try {
      assert.strictEqual(claude.binGone(real), false);
      assert.strictEqual(claude.binGone(`"${real}"`), false, 'quotes are ignored');
    } finally { fs.unlinkSync(real); }
    assert.strictEqual(claude.binGone(real), true, 'deleted → gone');
    assert.strictEqual(claude.binGone('"C:\\Users\\nobody\\AppData\\Roaming\\npm\\claude.cmd"'), true);
  });

  await test('a bare command name is left to PATH, never "gone"', () => {
    assert.strictEqual(claude.binGone('claude'), false);
    assert.strictEqual(claude.binGone('"claude"'), false);
    assert.strictEqual(claude.binGone(''), false);
    assert.strictEqual(claude.binGone(null), false);
  });

  await test('resolveBin drops a stale cached path instead of returning it', async () => {
    const stale = path.join(os.tmpdir(), `definitely-not-here-${process.pid}`, 'claude.cmd');
    claude._bins.claude = `"${stale}"`;
    const got = await claude.resolveBin('claude');
    assert.notStrictEqual(got, `"${stale}"`, 'the vanished path is not handed back');
    delete claude._bins.claude;
  });

  await test('a launch failure is told apart from the CLI running and erroring', () => {
    assert.strictEqual(claude.looksLikeMissingBinary({ out: '', err: "'C:\\x\\claude.cmd' is not recognized as an internal or external command" }), true);
    assert.strictEqual(claude.looksLikeMissingBinary({ out: '', err: 'spawn claude ENOENT' }), true);
    assert.strictEqual(claude.looksLikeMissingBinary({ out: 'some reply', err: 'is not recognized' }), false, 'it produced output → it ran');
    assert.strictEqual(claude.looksLikeMissingBinary({ out: '', err: 'rate limited' }), false);
    assert.strictEqual(claude.looksLikeMissingBinary(null), false);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
