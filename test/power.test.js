// bouchhub-agent/test/power.test.js
//
// The Warm up steps against a fake powercfg that keeps real state (schemes,
// values, the active one). The rules that matter: the user's scheme is never
// written to, floors only go up, and an elevation problem is reported, not hidden.

const assert = require('assert');
const power = require('../power');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const ORIG = '11111111-2222-3333-4444-555555555555';
const KEYS = Object.fromEntries(Object.entries(power.SETTINGS).map(([k, v]) => [v.key, k]));

function fakePowercfg({ values = { cpuMin: 5, aspm: 2, usbSuspend: 1 }, deny = null } = {}) {
  const pc = { schemes: { [ORIG]: { name: 'High performance', values: { ...values } } }, active: ORIG, calls: [], n: 0 };
  pc.run = async (args) => {
    pc.calls.push(args.join(' '));
    const [cmd, ...a] = args;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (deny && deny.test(cmd)) return { code: 1, stdout: 'Access is denied.', stderr: '' };
    const line = (g) => `Power Scheme GUID: ${g}  (${pc.schemes[g].name})${g === pc.active ? ' *' : ''}`;
    switch (cmd) {
      case '/getactivescheme': return ok(line(pc.active));
      case '/list': return ok(`Existing Power Schemes (* Active)\n-----------------------------------\n${Object.keys(pc.schemes).map(line).join('\n')}`);
      case '/duplicatescheme': {
        const g = `aaaaaaaa-0000-0000-0000-${String(++pc.n).padStart(12, '0')}`;
        pc.schemes[g] = { name: pc.schemes[a[0]].name, values: { ...pc.schemes[a[0]].values } };
        return ok(`Power Scheme GUID: ${g}  (${pc.schemes[g].name})`);
      }
      case '/changename': pc.schemes[a[0]].name = a[1]; return ok();
      case '/setactive': if (!pc.schemes[a[0]]) return { code: 1, stdout: 'Invalid Parameters', stderr: '' }; pc.active = a[0]; return ok();
      case '/delete': if (a[0] === pc.active) return { code: 1, stdout: 'cannot delete active', stderr: '' }; delete pc.schemes[a[0]]; return ok();
      case '/setacvalueindex': pc.schemes[a[0]].values[KEYS[a[2]]] = Number(a[3]); return ok();
      case '/query': return ok(`    Current AC Power Setting Index: 0x${pc.schemes[a[0]].values[KEYS[a[2]]].toString(16).padStart(8, '0')}\n    Current DC Power Setting Index: 0x00000000`);
      default: return { code: 1, stdout: `unknown ${cmd}`, stderr: '' };
    }
  };
  power._setRun(pc.run);
  return pc;
}

(async () => {
  console.log('Power (warm up) tests');

  await test('parses powercfg output', () => {
    assert.deepStrictEqual(power.parseScheme('Power Scheme GUID: 381B4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *'), { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', active: true });
    assert.strictEqual(power.parseAcIndex('Current AC Power Setting Index: 0x0000001e'), 30);
    assert.strictEqual(power.parseAcIndex('Index actuel du paramètre: 0x1e'), null, 'unknown language → unknown, not a guess');
  });

  await test('prepare clones the active scheme as "BouchHub Warm" and reads the original values', async () => {
    const pc = fakePowercfg();
    const r = await power.prepare();
    assert.strictEqual(r.originalGuid, ORIG);
    assert.strictEqual(pc.schemes[r.warmGuid].name, 'BouchHub Warm');
    assert.deepStrictEqual(r.baseline, { cpuMin: 5, aspm: 2, usbSuspend: 1 });
    assert.strictEqual(pc.active, ORIG, 'prepare alone switches nothing');
  });

  await test('the three stages ramp on the clone, verified — the original is never written to', async () => {
    const pc = fakePowercfg();
    const p = await power.prepare();
    let r = await power.applyStage({ warmGuid: p.warmGuid, stage: 1, baseline: p.baseline });
    assert.ok(r.ok);
    assert.strictEqual(pc.active, p.warmGuid);
    assert.deepStrictEqual(pc.schemes[p.warmGuid].values, { cpuMin: 10, aspm: 1, usbSuspend: 1 }, 'stage 1 leaves USB alone');
    r = await power.applyStage({ warmGuid: p.warmGuid, stage: 2, baseline: p.baseline });
    assert.deepStrictEqual(pc.schemes[p.warmGuid].values, { cpuMin: 20, aspm: 0, usbSuspend: 0 });
    r = await power.applyStage({ warmGuid: p.warmGuid, stage: 3, baseline: p.baseline });
    assert.deepStrictEqual(r.verified, { cpuMin: 30, aspm: 0, usbSuspend: 0 });
    assert.deepStrictEqual(pc.schemes[ORIG].values, { cpuMin: 5, aspm: 2, usbSuspend: 1 }, 'original untouched');
    assert.ok(!pc.calls.some((c) => c.startsWith('/setacvalueindex') && c.includes(ORIG)), 'no write ever names the original');
  });

  await test('floors only go up: an original already above a stage keeps its value', () => {
    assert.deepStrictEqual(power.stageValues(1, { cpuMin: 100, aspm: 0, usbSuspend: 0 }), { cpuMin: 100, aspm: 0 });
    assert.deepStrictEqual(power.stageValues(2, { cpuMin: 5, aspm: 2, usbSuspend: 1 }), { cpuMin: 20, aspm: 0, usbSuspend: 0 });
    assert.deepStrictEqual(power.stageValues(3, {}), { cpuMin: 30, aspm: 0, usbSuspend: 0 }, 'unknown original → the stage value');
  });

  await test('restore puts the original back and deletes the clone', async () => {
    const pc = fakePowercfg();
    const p = await power.prepare();
    await power.applyStage({ warmGuid: p.warmGuid, stage: 3, baseline: p.baseline });
    const r = await power.restore({ originalGuid: p.originalGuid, warmGuid: p.warmGuid });
    assert.strictEqual(pc.active, ORIG);
    assert.strictEqual(r.deleted, true);
    assert.ok(!pc.schemes[p.warmGuid]);
  });

  await test('after a crash mid-warm-up, prepare steps off the leftover clone back to the original', async () => {
    const pc = fakePowercfg();
    const p = await power.prepare();
    await power.applyStage({ warmGuid: p.warmGuid, stage: 2, baseline: p.baseline });
    const again = await power.prepare({ originalHint: ORIG });
    assert.strictEqual(again.originalGuid, ORIG, 'the clone is not mistaken for the original');
    assert.ok(!pc.schemes[p.warmGuid], 'the leftover is deleted');
    assert.strictEqual(Object.values(pc.schemes).filter((s) => s.name === 'BouchHub Warm').length, 1, 'exactly one fresh clone');
    assert.deepStrictEqual(again.baseline, { cpuMin: 5, aspm: 2, usbSuspend: 1 });
  });

  await test('a powercfg call that needs administrator rights says so', async () => {
    fakePowercfg({ deny: /setacvalueindex/ });
    const p = await power.prepare();
    await assert.rejects(() => power.applyStage({ warmGuid: p.warmGuid, stage: 1, baseline: p.baseline }), (e) => e.elevation === true && /needs administrator rights/.test(e.message));
  });

  power._setRun(null);
  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
