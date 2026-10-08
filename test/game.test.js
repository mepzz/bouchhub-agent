// bouchhub-agent/test/game.test.js
//
// What counts as "Alex is playing a game" for the hub's game mode — and, as
// importantly, what does not: a full-screen video or the Unity editor must not
// switch everything off.

const assert = require('assert');
const game = require('../game');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const win = (o) => ({ pid: 100, name: 'notepad', path: 'C:\\Windows\\notepad.exe', title: '', ...o });
const sample = (fg, more = {}) => ({ fg: { fullscreen: false, ...fg }, quns: 5, windows: [fg], ...more });

console.log('Game detection tests');

test('a known game in the foreground is a game, for sure', () => {
  const { game: g } = game.classify(sample(win({ pid: 7, name: 'cs2', path: null, title: 'Counter-Strike 2' })));
  assert.deepStrictEqual([g.pid, g.name, g.reason, g.sure], [7, 'cs2', 'known game', true]);
});

test('anything run from a game library folder counts, even one not on the list', () => {
  const fg = win({ pid: 8, name: 'SomeIndieGame', path: 'D:\\SteamLibrary\\steamapps\\common\\Indie\\SomeIndieGame.exe' });
  assert.strictEqual(game.classify(sample(fg)).game.reason, 'game library folder');
  const epic = win({ pid: 9, name: 'Thing', path: 'C:\\Program Files\\Epic Games\\Thing\\Thing.exe' });
  assert.ok(game.classify(sample(epic)).game);
});

test('launchers and tools in a game folder do not count (Wallpaper Engine runs all day)', () => {
  const wp = win({ pid: 10, name: 'wallpaper64', path: 'C:\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe', fullscreen: true });
  assert.strictEqual(game.classify(sample(wp), { gpuUsage: 90 }).game, null);
  assert.strictEqual(game.classify(sample(win({ name: 'steamwebhelper', path: 'C:\\Steam\\steamwebhelper.exe' }))).game, null);
});

test('full-screen exclusive Direct3D counts for anything that is not on the never list', () => {
  const g = game.classify({ ...sample(win({ pid: 11, name: 'mystery' })), quns: 3 }).game;
  assert.deepStrictEqual([g.reason, g.sure], ['full-screen Direct3D', true]);
});

test('borderless full screen counts only with the GPU busy, and only as "likely"', () => {
  const fg = win({ pid: 12, name: 'mystery', fullscreen: true });
  assert.strictEqual(game.classify(sample(fg), { gpuUsage: 20 }).game, null, 'GPU idle: not a game');
  const g = game.classify(sample(fg), { gpuUsage: 85 }).game;
  assert.strictEqual(g.sure, false);
  assert.match(g.reason, /85%/);
});

test('a full-screen browser, video player or the Unity editor never counts', () => {
  for (const name of ['chrome', 'msedge', 'vlc', 'Unity', 'explorer', 'Discord']) {
    const s = { ...sample(win({ name, fullscreen: true })), quns: 3 };
    assert.strictEqual(game.classify(s, { gpuUsage: 99 }).game, null, name);
  }
});

test('Minecraft Java is javaw with a Minecraft title; other Java apps are not games', () => {
  assert.ok(game.classify(sample(win({ name: 'javaw', title: 'Minecraft 1.21.1' }))).game);
  assert.strictEqual(game.classify(sample(win({ name: 'javaw', title: 'IntelliJ' }))).game, null);
});

test('every windowed process pid comes back, so the hub can tell a game is still open after alt-tab', () => {
  const s = { fg: win({ pid: 1, name: 'chrome' }), quns: 5, windows: [win({ pid: 1, name: 'chrome' }), win({ pid: 2, name: 'cs2' })] };
  const r = game.classify(s);
  assert.strictEqual(r.game, null, 'the game is not in front');
  assert.deepStrictEqual(r.pids.sort(), [1, 2]);
});

test('a single window (PowerShell drops the array) and an empty sample are handled', () => {
  assert.deepStrictEqual(game.classify({ fg: win({ pid: 3 }), windows: win({ pid: 3 }) }).pids, [3]);
  assert.deepStrictEqual(game.classify(null), { game: null, pids: [] });
});

console.log(`\n${passed} passed`);
