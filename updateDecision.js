// bouchhub-agent/updateDecision.js
//
// Whether to pull, given how far origin/main is ahead of our checkout.
//
// This one decision hid a bug for weeks. The old code asked git.status().behind,
// which is measured against whatever branch HEAD is TRACKING. A checkout left on
// a stray branch with no upstream reports behind = 0 always — so every
// auto-update, and even a forced one, fell straight into the "up to date"
// shortcut and pulled nothing. The agent sat on stale code, its update log
// saying "up to date" on every check, and nothing looked wrong.
//
// The fix is to count commits against origin/main directly (HEAD..origin/main),
// which does not care what branch we are on. This function is that decision,
// kept pure and separate so it can be tested without a git checkout — the whole
// bug lived in the decision, not the pull.
//
//   update  — origin/main is ahead: reset onto it and restart
//   realign — nothing to pull, but a force was asked: make sure we are actually
//             ON main and tracking it, so a stray checkout cannot disable
//             updates forever
function updateDecision(aheadOfOriginMain, force) {
  const ahead = Number(aheadOfOriginMain) || 0;
  if (ahead > 0) return { update: true };
  if (force) return { update: false, realign: true };
  return { update: false };
}

module.exports = { updateDecision };
