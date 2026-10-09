// bouchhub-agent/power.js
//
// The "Warm up" button's hands: Windows power-scheme changes through powercfg.
//
// Why it exists: this PC has had sudden total power cuts (Kernel-Power 41,
// bugcheck 0), most often in the seconds after it wakes from a long deep idle —
// the jump from ~0 to full load. Warming up raises the idle floor in small
// steps before Alex sits down, so waking is "20 → 100" instead of "0 → 100".
// It is a mitigation, not a cure.
//
// What it does, and what it never does:
//   • works on a CLONE of the active scheme ("BouchHub Warm"); the user's own
//     scheme is never written to — only read, for its current values;
//   • only RAISES floors: CPU minimum state up, PCIe link-state power management
//     and USB selective suspend down/off — never below what the original already
//     had (an original at 100% CPU minimum stays at 100%);
//   • never generates load, never touches the display, sleep or idle-disable
//     settings — the clone keeps the original's display and sleep timeouts.
//
// The hub owns the schedule (services/warmup.js): it calls prepare → stage 1,
// 2, 3 five minutes apart → restore. Every powercfg call goes through an
// injectable runner, so test/power.test.js runs under plain node.

'use strict';

const { execFile } = require('child_process');

const WARM_NAME = 'BouchHub Warm';
const WARM_DESC = 'Temporary warm-up clone made by BouchHub. Safe to delete; BouchHub deletes it when the warm-up ends.';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';

const SETTINGS = {
  cpuMin: { sub: '54533251-82be-4824-96c1-47b60b740d00', key: '893dee8e-2bef-41e0-89c6-b55d0929964c' },     // processor minimum state, %
  aspm: { sub: '501a4d13-42af-4429-9fd1-a8218c268e20', key: 'ee12f906-d277-404b-b6da-e5fa1a576df5' },       // PCIe ASPM: 0 off, 1 moderate, 2 max savings
  usbSuspend: { sub: '2a737441-1930-4402-8d77-b2bebba308a3', key: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226' }, // USB selective suspend: 0 disabled, 1 enabled
};

// The ramp. A setting a stage leaves out keeps the original's value.
const STAGES = {
  1: { cpuMin: 10, aspm: 1 },
  2: { cpuMin: 20, aspm: 0, usbSuspend: 0 },
  3: { cpuMin: 30, aspm: 0, usbSuspend: 0 },
};

const GUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function defaultRun(args) {
  return new Promise((resolve) => {
    execFile('powercfg', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && typeof err.code !== 'number' ? err.message : null });
    });
  });
}
let _run = defaultRun;
function _setRun(fn) { _run = fn || defaultRun; }

// One powercfg call. Throws with powercfg's own words; an access problem says
// plainly that it needs elevation instead of failing quietly.
async function powercfg(...args) {
  const r = await _run(args);
  if (r.code === 0 && !r.error) return r.stdout;
  const said = `${r.stderr} ${r.stdout} ${r.error || ''}`.replace(/\s+/g, ' ').trim();
  const e = new Error(/access is denied|administrator|elevat|privilege/i.test(said)
    ? `powercfg ${args[0]} needs administrator rights on this PC: ${said}`
    : `powercfg ${args.join(' ')} failed (exit ${r.code}): ${said || 'no output'}`);
  e.elevation = /access is denied|administrator|elevat|privilege/i.test(said);
  throw e;
}

// "Power Scheme GUID: 381b…  (Balanced)" → { guid, name }
function parseScheme(line) {
  const m = GUID_RE.exec(String(line || ''));
  if (!m) return null;
  const name = /\(([^)]*)\)/.exec(String(line).slice(m.index));
  return { guid: m[1].toLowerCase(), name: name ? name[1].trim() : '', active: /\*\s*$/.test(String(line).trim()) };
}
function parseList(text) { return String(text || '').split(/\r?\n/).map(parseScheme).filter(Boolean); }
// "Current AC Power Setting Index: 0x0000000a" → 10 (null when not there, e.g. a non-English Windows).
function parseAcIndex(text) {
  const m = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(String(text || ''));
  return m ? parseInt(m[1], 16) : null;
}

async function activeScheme() { return parseScheme(await powercfg('/getactivescheme')); }
async function listSchemes() { return parseList(await powercfg('/list')); }
async function readValue(guid, setting) {
  const s = SETTINGS[setting];
  try { return parseAcIndex(await powercfg('/query', guid, s.sub, s.key)); } catch (_) { return null; }
}
async function readValues(guid) {
  return { cpuMin: await readValue(guid, 'cpuMin'), aspm: await readValue(guid, 'aspm'), usbSuspend: await readValue(guid, 'usbSuspend') };
}

// What a stage sets, given the original's values: floors only ever go up.
function stageValues(stage, baseline = {}) {
  const st = STAGES[stage];
  if (!st) throw new Error(`no warm-up stage ${stage}`);
  const out = {};
  out.cpuMin = Math.max(st.cpuMin, Number.isFinite(baseline.cpuMin) ? baseline.cpuMin : 0);
  if (st.aspm != null) out.aspm = Number.isFinite(baseline.aspm) ? Math.min(st.aspm, baseline.aspm) : st.aspm;
  if (st.usbSuspend != null) out.usbSuspend = Number.isFinite(baseline.usbSuspend) ? Math.min(st.usbSuspend, baseline.usbSuspend) : st.usbSuspend;
  return out;
}

// Make a fresh warm clone of the user's scheme. `originalHint` is the hub's
// memory of the original, used when the PC is already on a leftover warm scheme
// (a crash or power cut mid-warm-up); without it, Balanced.
async function prepare({ originalHint = null } = {}) {
  let active = await activeScheme();
  if (!active) throw new Error('could not read the active power scheme');
  let original = active;
  if (active.name === WARM_NAME) {
    const schemes = await listSchemes();
    const hinted = originalHint && schemes.find((s) => s.guid === String(originalHint).toLowerCase() && s.name !== WARM_NAME);
    original = hinted || schemes.find((s) => s.guid === BALANCED) || { guid: BALANCED, name: 'Balanced' };
    await powercfg('/setactive', original.guid);   // step off the leftover so it can be deleted
  }
  for (const s of await listSchemes()) {
    if (s.name === WARM_NAME && s.guid !== original.guid) { try { await powercfg('/delete', s.guid); } catch (_) { /* leftover; harmless */ } }
  }
  const dup = GUID_RE.exec(await powercfg('/duplicatescheme', original.guid));
  if (!dup) throw new Error('powercfg /duplicatescheme did not return a GUID');
  const warmGuid = dup[1].toLowerCase();
  await powercfg('/changename', warmGuid, WARM_NAME, WARM_DESC);
  const baseline = await readValues(original.guid);
  return { originalGuid: original.guid, originalName: original.name, warmGuid, baseline };
}

// Apply one stage to the warm clone and make it active, then read it back.
async function applyStage({ warmGuid, stage, baseline = {} }) {
  if (!GUID_RE.test(String(warmGuid || ''))) throw new Error('missing warm scheme GUID');
  const values = stageValues(Number(stage), baseline);
  for (const [k, v] of Object.entries(values)) await powercfg('/setacvalueindex', warmGuid, SETTINGS[k].sub, SETTINGS[k].key, String(v));
  await powercfg('/setactive', warmGuid);   // re-apply so the new values take effect
  const active = await activeScheme();
  const verified = await readValues(warmGuid);
  const mismatch = Object.entries(values).filter(([k, v]) => verified[k] != null && verified[k] !== v).map(([k]) => k);
  return { stage: Number(stage), applied: values, verified, active, ok: !!active && active.guid === warmGuid && !mismatch.length, mismatch };
}

// Back to the user's own scheme, then delete the clone.
async function restore({ originalGuid, warmGuid = null }) {
  if (!GUID_RE.test(String(originalGuid || ''))) throw new Error('missing original scheme GUID');
  await powercfg('/setactive', originalGuid);
  const active = await activeScheme();
  if (!active || active.guid !== String(originalGuid).toLowerCase()) throw new Error(`the original scheme did not become active (active: ${active ? active.name || active.guid : 'unknown'})`);
  let deleted = false;
  if (warmGuid && String(warmGuid).toLowerCase() !== active.guid) { try { await powercfg('/delete', warmGuid); deleted = true; } catch (_) {} }
  return { active, deleted };
}

async function status() {
  const active = await activeScheme();
  return { active, values: active ? await readValues(active.guid) : null, warm: !!active && active.name === WARM_NAME };
}

module.exports = { prepare, applyStage, restore, status, stageValues, parseScheme, parseList, parseAcIndex, STAGES, SETTINGS, WARM_NAME, BALANCED, _setRun };
