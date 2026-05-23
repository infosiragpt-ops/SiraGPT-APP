/**
 * Additional code-sandbox guarantees:
 *   - Spawn errors (missing interpreter) surface clearly in stderr
 *     instead of returning a silent {ok:false, stderr:''}.
 *   - The per-run memoryMb option flows into NODE_OPTIONS so callers
 *     can tune the heap cap without mutating env globally.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sandbox: missing interpreter surfaces ENOENT in stderr', async () => {
  const prior = process.env.SANDBOX_NODE;
  process.env.SANDBOX_NODE = '/no/such/binary-12345';
  // Re-require with a fresh module cache so the new env is picked up.
  delete require.cache[require.resolve('../src/services/agents/code-sandbox')];
  const { run } = require('../src/services/agents/code-sandbox');
  try {
    const r = await run({ language: 'javascript', source: 'console.log(1)' });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /interpreter not found|spawn error/);
    assert.match(r.stderr, /no\/such\/binary-12345/);
  } finally {
    if (prior === undefined) delete process.env.SANDBOX_NODE;
    else process.env.SANDBOX_NODE = prior;
    delete require.cache[require.resolve('../src/services/agents/code-sandbox')];
  }
});

test('sandbox: memoryMb option propagates to NODE_OPTIONS', async () => {
  const { run } = require('../src/services/agents/code-sandbox');
  const r = await run({
    language: 'javascript',
    source: 'console.log(process.env.NODE_OPTIONS || "")',
    memoryMb: 256,
  });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /max-old-space-size=256/);
});
