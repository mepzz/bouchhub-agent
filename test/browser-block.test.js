// bouchhub-agent/test/browser-block.test.js
//
// The headless browser must never leave the card hunter with empty results.
// When a site serves a bot-challenge page, browser.js falls back to a minimized
// window — and decides that with looksBlockedText.

const assert = require('assert');
const { looksBlockedText } = require('../browser-block');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const results = 'x'.repeat(2000);

console.log('Browser block-detection tests');

test('a challenge page is blocked, whatever the wording', () => {
  assert.strictEqual(looksBlockedText('Pardon Our Interruption', results), true);
  assert.strictEqual(looksBlockedText('eBay', `Please verify you are a human ${results}`), true);
  assert.strictEqual(looksBlockedText('Access Denied', results), true);
  assert.strictEqual(looksBlockedText('', `Checking your browser before accessing ${results}`), true);
  assert.strictEqual(looksBlockedText('Security Measure', results), true);
});

test('a near-empty page counts as blocked', () => {
  assert.strictEqual(looksBlockedText('eBay', ''), true);
  assert.strictEqual(looksBlockedText('eBay', 'Loading…'), true);
  assert.strictEqual(looksBlockedText('eBay', undefined), true);
});

test('a normal results page — even one with no listings — is not blocked', () => {
  assert.strictEqual(looksBlockedText('2024 Prizm Ovechkin | eBay', results), false);
  assert.strictEqual(looksBlockedText('eBay', `No exact matches found. Try different keywords. ${results}`), false);
});

console.log(`\n${passed} passed`);
