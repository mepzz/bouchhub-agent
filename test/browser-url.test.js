// bouchhub-agent/test/browser-url.test.js
//
// The eBay search address: the Canada-only option adds eBay's item-location
// filter, and nothing else changes without it.

const assert = require('assert');
const Module = require('module');
// browser.js needs playwright-core only to drive a browser; building a URL does not.
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'playwright-core' ? { chromium: {} } : realLoad.call(this, request, ...rest); };
const { buildSearchUrl } = require('../browser');
Module._load = realLoad;

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  \u2713 ${name}`); passed++; } catch (e) { console.log(`  \u2717 ${name}`); throw e; } }

console.log('eBay search URL tests');

test('canadaOnly adds the Canada-only item location filter', () => {
  const u = buildSearchUrl('ebay', 'future watch inscribed', { canadaOnly: true });
  assert.ok(u.startsWith('https://www.ebay.ca/sch/i.html?_nkw=future%20watch%20inscribed'), u);
  assert.ok(u.includes('&LH_PrefLoc=1'), u);
});

test('without it the address is unchanged', () => {
  assert.ok(!buildSearchUrl('ebay', 'x', {}).includes('LH_PrefLoc'));
  assert.ok(!buildSearchUrl('ebay', 'x', { sold: true }).includes('LH_PrefLoc'));
});

test('it combines with the other options', () => {
  const u = buildSearchUrl('ebay', 'x', { canadaOnly: true, auction: true, sort: 'ending', maxPrice: 200 });
  assert.ok(u.includes('LH_PrefLoc=1') && u.includes('LH_Auction=1') && u.includes('_sop=1') && u.includes('_udhi=200'), u);
});

console.log(`\n${passed} passed`);
