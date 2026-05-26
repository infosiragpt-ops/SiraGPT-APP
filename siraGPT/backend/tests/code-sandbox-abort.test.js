const test = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../src/services/agents/code-sandbox');

test('code sandbox: abort signal kills a running child process', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 50);

  const result = await sandbox.run({
    language: 'python',
    source: 'import time\ntime.sleep(5)\nprint("done")',
    timeoutMs: 10000,
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 2500, 'process should be killed by abort, not timeout');
});
