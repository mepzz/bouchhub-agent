// bouchhub-agent/test/updateDecision.test.js
//
// The one decision that let the agent sit on stale code for weeks. It reported
// "up to date" on every check because it measured "behind" against a branch
// that had no upstream. These pin the fix: the decision is about origin/main,
// not the current branch's tracking.

const assert = require('assert');
const { updateDecision } = require('../updateDecision');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

console.log('Update decision tests');

test('behind origin/main means pull, whatever branch we are on', () => {
  assert.deepStrictEqual(updateDecision(3, false), { update: true });
  assert.deepStrictEqual(updateDecision(1, true), { update: true });
});

test('up to date and not forced: do nothing', () => {
  assert.deepStrictEqual(updateDecision(0, false), { update: false });
});

test('up to date but forced: realign onto main rather than no-op', () => {
  // This is what was missing. A forced update on a stray branch used to return
  // "up to date" and leave the checkout stranded, so it could never update
  // again. Now a force at least gets us back onto main.
  assert.deepStrictEqual(updateDecision(0, true), { update: false, realign: true });
});

test('a non-number ahead-count does not crash the decision', () => {
  // rev-list output is a string; a fetch hiccup could hand back junk. It must
  // fail closed (no spurious update), not throw.
  assert.deepStrictEqual(updateDecision(NaN, false), { update: false });
  assert.deepStrictEqual(updateDecision(undefined, false), { update: false });
  assert.deepStrictEqual(updateDecision('2', false), { update: true });
});

console.log(`\n${passed} passed`);
