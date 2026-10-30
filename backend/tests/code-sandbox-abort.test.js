const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

for (const stage of ['directory', 'source', 'fixture']) {
  test(`code sandbox: cancellation during ${stage} preparation never executes source`, async (t) => {
    const controller = new AbortController();
    const originalMkdtemp = fs.promises.mkdtemp;
    const originalWriteFile = fs.promises.writeFile;
    let runDirectory;
    t.mock.method(fs.promises, 'mkdtemp', async (...args) => {
      runDirectory = await originalMkdtemp(...args);
      if (stage === 'directory') controller.abort();
      return runDirectory;
    });
    t.mock.method(fs.promises, 'writeFile', async (...args) => {
      const result = await originalWriteFile(...args);
      const filename = path.basename(String(args[0]));
      if ((stage === 'source' && filename === 'main.js')
          || (stage === 'fixture' && filename === 'fixture.txt')) controller.abort();
      return result;
    });

    const result = await sandbox.run({
      language: 'javascript',
      source: 'console.log("EXECUTED_AFTER_STOP")',
      files: { 'nested/fixture.txt': 'fixture' },
      signal: controller.signal,
    });

    assert.equal(controller.signal.aborted, true, 'cancelled during real filesystem preparation');
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, 'SIGABRT');
    assert.equal(result.exitCode, null, 'cancelled before a process was created');
    assert.equal(result.stdout, '', 'cancelled source must not run');
    assert.ok(runDirectory);
    assert.equal(fs.existsSync(runDirectory), false, 'prepared files must be removed');
  });
}
