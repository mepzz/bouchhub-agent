// bouchhub-agent/test/claude-model.test.js
//
// The per-launch model flag and the Studio's `lead` provider. The flag lands on
// a PowerShell command line, so the interesting cases are the ones where the
// value is not a clean alias.

const assert = require('assert');
const claude = require('../claude');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

console.log('Model flag + lead provider tests');

test('the lead provider exists, is the Claude CLI, and has its own folder and bypass', () => {
  const p = claude.PROVIDERS.lead;
  assert.ok(p, 'lead provider');
  assert.strictEqual(p.cli, 'claude');
  assert.strictEqual(p.defaultFolder, 'PartyGame-Lead');
  assert.notStrictEqual(p.defaultFolder, claude.PROVIDERS.claude.defaultFolder, 'never two providers in one tree');
  assert.match(claude.workFolderFor('lead'), /PartyGame-Lead$/);
});

test('every provider gets the model, spelled the way its own CLI spells it', () => {
  assert.strictEqual(claude._modelFlag('claude', 'fable'), '--model fable');
  assert.strictEqual(claude._modelFlag('lead', 'claude-x-9'), '--model claude-x-9');
  assert.strictEqual(claude._modelFlag('claude2', 'fable'), '--model fable');
  // Codex used to drop this on the floor: the hub logged the model it asked
  // for and codex ran its own default, which is invisible until the bill.
  assert.strictEqual(claude._modelFlag('codex', 'gpt-6-astra'), '--model gpt-6-astra');
  assert.strictEqual(claude._modelFlag('gemini', 'gemini-3-pro'), '-m gemini-3-pro');
  assert.strictEqual(claude._modelFlag('claude', undefined), '');
  assert.strictEqual(claude._modelFlag('claude', ''), '');
  assert.strictEqual(claude._modelFlag('codex', ''), '');
});

test('anything that is not an alias character is dropped, never quoted', () => {
  assert.strictEqual(claude._modelFlag('claude', 'fable; Remove-Item x'), '--model fableRemove-Itemx');
  assert.strictEqual(claude._modelFlag('claude', '$(evil)'), '--model evil');
  assert.strictEqual(claude._modelFlag('claude', ';;;'), '');
  assert.strictEqual(claude._modelFlag('codex', 'gpt-6; rm -rf /'), '--model gpt-6rm-rf');
});

test('providerFlags appends the model after the provider flags', () => {
  delete process.env.LEAD_FLAGS;
  assert.strictEqual(claude._providerFlags('lead', true, 'fable'), '--verbose --dangerously-skip-permissions --model fable');
  assert.strictEqual(claude._providerFlags('lead', true), '--verbose --dangerously-skip-permissions');
  delete process.env.CODEX_FLAGS;
  assert.strictEqual(claude._providerFlags('codex', true, 'gpt-6-astra'),
    '--dangerously-bypass-approvals-and-sandbox --model gpt-6-astra');
  assert.strictEqual(claude._providerFlags('codex', true), '--dangerously-bypass-approvals-and-sandbox');
});

console.log(`\n${passed} passed`);
