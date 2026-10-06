// browser-block.js — does a page look like a bot challenge instead of results?
// Kept apart from browser.js so it can be tested without Playwright.

// What a bot-challenge / block page looks like. A real results page has far more
// text than this, so a near-empty body counts as blocked too.
const BLOCK_RE = /pardon our interruption|are you a (?:human|robot)|captcha|access denied|unusual traffic|security (?:check|measure)|verify (?:you|your)|robot check|request (?:blocked|denied)|checking your browser/i;
function looksBlockedText(title, body) {
  const b = String(body || '');
  return BLOCK_RE.test(`${title || ''}\n${b.slice(0, 800)}`) || b.trim().length < 300;
}

module.exports = { looksBlockedText, BLOCK_RE };
