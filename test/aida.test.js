// bouchhub-agent/test/aida.test.js
// Parsing AIDA64's published sensor values. No registry, no AIDA64, no Windows
// needed — the parts that decide what a number MEANS are pure.

const assert = require('assert');
const aida = require('../aida');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

console.log('AIDA64 sensor tests');

// Exactly what `reg query HKCU\Software\FinalWire\AIDA64\SensorValues` prints.
const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\FinalWire\\AIDA64\\SensorValues',
  '    Label.TCPU    REG_SZ    CPU',
  '    Value.TCPU    REG_SZ    57 °C',
  '    Label.TGPU1    REG_SZ    GPU Diode',
  '    Value.TGPU1    REG_SZ    51 °C',
  '    Label.FCHA1    REG_SZ    Chassis #1',
  '    Value.FCHA1    REG_SZ    2188 RPM',
  '    Label.FGPU1    REG_SZ    GPU1',
  '    Value.FGPU1    REG_SZ    30 %',
  '    Label.FWP    REG_SZ    Water Pump',
  '    Value.FWP    REG_SZ    0 RPM',
  '    Label.TMEMORY    REG_SZ    Memory Module',
  '    Value.TMEMORY    REG_SZ    55 °C',
  '    Label.SCPUUTI    REG_SZ    CPU Utilization',
  '    Value.SCPUUTI    REG_SZ    18 %',
  '',
].join('\r\n');

test('reads every published value out of reg query output', () => {
  const v = aida.parseRegQuery(REG_OUTPUT);
  assert.strictEqual(v['Value.TCPU'], '57 °C');
  assert.strictEqual(v['Label.FCHA1'], 'Chassis #1', 'a label with a space survives intact');
  assert.strictEqual(Object.keys(v).length, 14);
});

test('pairs each label with its value', () => {
  const s = aida.pair(aida.parseRegQuery(REG_OUTPUT));
  const cpu = s.find(x => x.id === 'TCPU');
  assert.strictEqual(cpu.label, 'CPU');
  assert.strictEqual(cpu.value, 57);
  assert.strictEqual(cpu.unit, 'C');
  assert.strictEqual(cpu.text, '57 °C', 'the display string is kept so a panel can mirror AIDA64 exactly');
});

test('a value with no label is still reported', () => {
  // Better a nameless reading than a dropped one.
  const s = aida.pair({ 'Value.TXYZ': '42 °C' });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].label, null);
  assert.strictEqual(s[0].value, 42);
});

test('a label with no value is dropped', () => {
  assert.deepStrictEqual(aida.pair({ 'Label.TXYZ': 'Ghost' }), []);
});

test('units are read off the display string', () => {
  assert.deepStrictEqual(aida.interpret('2188 RPM'), { value: 2188, unit: 'RPM', text: '2188 RPM' });
  assert.deepStrictEqual(aida.interpret('30 %'), { value: 30, unit: '%', text: '30 %' });
  assert.strictEqual(aida.interpret('1.234 V').unit, 'V');
  assert.strictEqual(aida.interpret('4.85 GHz').unit, 'GHz');
  assert.strictEqual(aida.interpret('-3 °C').value, -3, 'a negative reading is not mangled');
  assert.strictEqual(aida.interpret('N/A').value, null, 'an unreadable sensor has no number');
});

test('summarise finds the temperatures Windows cannot see', () => {
  const s = aida.pair(aida.parseRegQuery(REG_OUTPUT));
  const out = aida.summarise(s);
  assert.strictEqual(out.cpuTemp, 57);
  assert.strictEqual(out.gpuTemp, 51);
  assert.strictEqual(out.memTemp, 55, 'memory temperature is the whole reason for reading AIDA64');
});

test('summarise collects fans by RPM and by percent', () => {
  const out = aida.summarise(aida.pair(aida.parseRegQuery(REG_OUTPUT)));
  const byName = Object.fromEntries(out.fans.map(f => [f.name, f]));
  assert.strictEqual(byName['Chassis #1'].rpm, 2188);
  assert.strictEqual(byName['GPU1'].pct, 30, 'a fan reported as a percentage is kept as a percentage');
  assert.strictEqual(byName['Water Pump'].rpm, 0, 'a stopped pump reads 0, it is not dropped');
});

test('a CPU FAN is not mistaken for the CPU temperature', () => {
  const s = aida.pair({
    'Label.FCPU': 'CPU Fan', 'Value.FCPU': '1200 RPM',
    'Label.TCPU': 'CPU Package', 'Value.TCPU': '61 °C',
  });
  assert.strictEqual(aida.summarise(s).cpuTemp, 61);
});

test('nothing published yields nulls rather than invented numbers', () => {
  const out = aida.summarise([]);
  assert.strictEqual(out.cpuTemp, null);
  assert.strictEqual(out.gpuTemp, null);
  assert.strictEqual(out.memTemp, null);
  assert.deepStrictEqual(out.fans, []);
  assert.strictEqual(aida.summarise(null).cpuTemp, null, 'and a missing list does not throw');
});

console.log(`\n${passed} passed`);
