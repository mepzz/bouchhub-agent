// bouchhub-agent/aida.js
//
// Reads live sensor values published by AIDA64.
//
// Windows itself has no idea what a chassis fan or a memory module's
// temperature is: Win32_Fan returns nothing on essentially every desktop, and
// MSAcpi_ThermalZoneTemperature is an ACPI zone that is often several degrees
// off the real CPU die. AIDA64 talks to the motherboard's sensor chip directly,
// and will publish everything it reads to the registry — so rather than install
// a second sensor tool, we read what AIDA64 already knows.
//
// Turn it on in AIDA64:
//   Preferences → Hardware Monitoring → External Applications
//   → "Enable writing sensor values to registry"
//
// Deliberately NO hardcoded sensor ids. AIDA64's ids vary by board, by which
// sensors the user enabled, and between versions; anything keyed on a fixed
// list would work on one machine and quietly return nothing on the next. The
// key holds Label.<id> / Value.<id> pairs, so we read whatever is there and
// pair them up.

const { execFile } = require('child_process');

const KEY = 'HKCU\\Software\\FinalWire\\AIDA64\\SensorValues';
const STALE_MS = 15000;

let _cache = { at: 0, data: null };

function reg(args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// `reg query` prints one value per line as:  <name><spaces>REG_SZ<spaces><data>
// The data may itself contain spaces, so split on the type and keep the rest.
function parseRegQuery(stdout) {
  const out = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^\s{4}(\S+)\s+REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Pair Label.<id> with Value.<id>. An id with a value but no label still comes
// through — a nameless reading is far more useful than a dropped one.
function pair(values) {
  const byId = new Map();
  for (const [name, data] of Object.entries(values)) {
    const m = name.match(/^(Label|Value)\.(.+)$/i);
    if (!m) continue;
    const id = m[2];
    const rec = byId.get(id) || { id, label: null, raw: null };
    if (/^label$/i.test(m[1])) rec.label = data;
    else rec.raw = data;
    byId.set(id, rec);
  }
  return [...byId.values()]
    .filter(r => r.raw != null && r.raw !== '')
    .map(r => ({ ...r, ...interpret(r.raw) }));
}

// AIDA64 writes display strings ("57 °C", "2188 RPM", "18 %"), so pull out the
// number and remember the unit. The string is kept as-is too: a panel that
// wants to mirror AIDA64 exactly should show exactly what AIDA64 shows.
const UNITS = [
  [/°?\s*C\b/i, 'C'], [/°?\s*F\b/i, 'F'], [/\bRPM\b/i, 'RPM'], [/%/, '%'],
  [/\bMHz\b/i, 'MHz'], [/\bGHz\b/i, 'GHz'], [/\bW\b/, 'W'], [/\bV\b/, 'V'],
  [/\bGB\b/i, 'GB'], [/\bMB\b/i, 'MB'],
];
function interpret(raw) {
  const s = String(raw);
  const num = parseFloat(s.replace(',', '.').replace(/[^\d.\-+eE]/g, ' ').trim().split(/\s+/)[0]);
  let unit = null;
  for (const [re, u] of UNITS) if (re.test(s)) { unit = u; break; }
  return { value: Number.isFinite(num) ? num : null, unit, text: s };
}

// Returns { ok, enabled, sensors: [{id, label, value, unit, text}], error }.
// `enabled: false` means AIDA64 is not publishing — a setup step, not a fault,
// and worth telling apart from "the read failed".
async function read({ maxAgeMs = 2000 } = {}) {
  if (_cache.data && Date.now() - _cache.at < maxAgeMs) return _cache.data;

  let result;
  if (process.platform !== 'win32') {
    result = { ok: false, enabled: false, sensors: [], error: 'AIDA64 is Windows-only' };
  } else {
    const r = await reg(['query', KEY]);
    if (r.code !== 0) {
      const missing = /cannot find|unable to find/i.test(r.stderr + r.stdout);
      result = {
        ok: false, enabled: false, sensors: [],
        error: missing
          ? 'AIDA64 is not publishing sensors. Turn on Preferences → Hardware Monitoring → External Applications → "Enable writing sensor values to registry".'
          : (r.stderr.trim() || `reg query failed (${r.code})`),
      };
    } else {
      const sensors = pair(parseRegQuery(r.stdout));
      result = { ok: sensors.length > 0, enabled: true, sensors, at: Date.now() };
      if (!sensors.length) result.error = 'AIDA64 published an empty sensor list — no sensors are selected for external applications.';
    }
  }

  _cache = { at: Date.now(), data: result };
  return result;
}

// Best-effort mapping onto the fields /stats already exposes, so the existing
// dashboard gets better numbers without knowing AIDA64 exists. Matching is by
// LABEL because the ids are board-specific; a label the user renamed simply
// won't match, which costs nothing since the raw list is still published.
function summarise(sensors) {
  const find = (re, unit) => {
    const hit = (sensors || []).find(s => s.label && re.test(s.label) && (!unit || s.unit === unit));
    return hit && hit.value != null ? hit.value : null;
  };
  // Anything in RPM is a fan. So is anything AIDA64 named like one. The third
  // case is the awkward one: a fan reported as a duty percentage ("GPU1 30%")
  // has neither — but AIDA64 namespaces fan sensors with an F-prefixed id, and
  // a percentage there is a fan speed. Restricted to '%' so an F-prefixed
  // temperature or voltage can't wander into the fan list.
  const isFan = (s) =>
    s.unit === 'RPM'
    || (s.label && /\bfan\b|\bpump\b/i.test(s.label))
    || (s.unit === '%' && /^F/.test(s.id || ''));
  const fans = (sensors || []).filter(isFan)
    .map(s => ({ name: s.label || s.id, rpm: s.unit === 'RPM' ? s.value : null, pct: s.unit === '%' ? s.value : null }));

  return {
    cpuTemp: find(/\bcpu\b(?!.*\bfan\b).*(temp|package|die)|^cpu$/i, 'C') ?? find(/\bcpu\b/i, 'C'),
    gpuTemp: find(/\bgpu\b.*(temp|diode)|^gpu$/i, 'C') ?? find(/\bgpu\b/i, 'C'),
    // "Memory" in AIDA64 can be a DIMM module temperature or the memory
    // controller; either is closer to the truth than showing nothing.
    memTemp: find(/\b(dimm|memory|ram)\b/i, 'C'),
    fans,
  };
}

module.exports = { read, summarise, parseRegQuery, pair, interpret, KEY };
