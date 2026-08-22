// bouchhub-agent/test/local.test.js
//
// What comes back from the local text model, and how an empty answer is
// explained. The default model reasons before it replies, and "empty reply"
// was covering three different problems with three different fixes: the model
// was not running, the model produced only its own scratchpad, or the model ran
// out of room mid-thought.

const assert = require('assert');
const local = require('../local');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

console.log('Local model tests');

test('reasoning is kept out of the answer', () => {
  assert.strictEqual(local.stripThinking('<think>weighing it up</think>The answer is 4.'), 'The answer is 4.');
  assert.strictEqual(local.thinkingOf('<think>weighing it up</think>The answer is 4.'), 'weighing it up');
});

test('a thought it never finished does not become the answer', () => {
  // Out of tokens mid-sentence. What follows the last opener is all there is.
  const out = local.stripThinking('<think>still going, still go');
  assert.ok(!out.includes('<think>'), out);
});

test('an answer that is entirely scratchpad strips to nothing', () => {
  // This is the case that produced "the local model returned an empty reply".
  // The stripping is right — there genuinely is no answer outside the tag.
  assert.strictEqual(local.stripThinking('<think>I should reply with JSON</think>'), '');
  assert.strictEqual(local.thinkingOf('<think>I should reply with JSON</think>'), 'I should reply with JSON');
});

test('several thoughts are all kept out, and all kept', () => {
  const raw = '<think>one</think>Yes.<think>two</think> Definitely.';
  assert.strictEqual(local.stripThinking(raw), 'Yes. Definitely.');
  assert.strictEqual(local.thinkingOf(raw), 'one\ntwo');
});

test('nothing at all is handled without throwing', () => {
  assert.strictEqual(local.stripThinking(''), '');
  assert.strictEqual(local.stripThinking(null), '');
  assert.strictEqual(local.thinkingOf(''), null);
});

test('what an exhausted machine looks like is recognised in every dialect', () => {
  for (const line of [
    'ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 5909372928',
    'cudaMalloc failed: out of memory',
    'llama-server process has terminated: exit status 1',
    'alloc_tensor_range: failed to allocate CUDA_Host buffer',
  ]) assert.ok(local.OUT_OF_MEMORY.test(line), line);
  assert.ok(!local.OUT_OF_MEMORY.test('the model finished normally'), 'and an ordinary line is not mistaken for one');
});

console.log(`\n${passed} passed`);
