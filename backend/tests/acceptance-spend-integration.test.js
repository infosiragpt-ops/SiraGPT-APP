'use strict';

// Local integration only: the real SDK receives a stub transport, and child
// processes share synthetic temporary files. No provider/network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const OpenAI = require('openai');
const guardModulePath = require.resolve('../src/services/ai/acceptance-spend-guard');
const { isAcceptanceSpendError, ENDPOINT, MAX_TOTAL_MICROS, ONE_USD_MICROS } = require(guardModulePath);
const { fixture, IDENTITY, NOW, request, quota } = require('./helpers/acceptance-spend-fixture');

test('real OpenAI SDK wire format is admitted and every SDK retry reserves before transport', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  let sends = 0;
  let healthy = true;
  const client = new OpenAI({ apiKey: 'synthetic-offline', baseURL: 'https://api.meta.ai/v1', maxRetries: 2,
    fetch: guard.guardedFetch(async (input, init) => {
      sends++;
      assert.equal(input, ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(f.read().usedMicros, sends * ONE_USD_MICROS);
      if (healthy) return new Response(JSON.stringify({ id: 'synthetic', choices: [{ message: { role: 'assistant', content: 'OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      return new Response(JSON.stringify({ error: { message: 'synthetic temporary failure' } }), {
        status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      });
    }),
  });
  const payload = JSON.parse(request().body);
  const result = await guard.withAcceptanceScope(IDENTITY, () => client.chat.completions.create(payload));
  assert.equal(result.choices[0].message.content, 'OK');
  assert.equal(sends, 1);
  healthy = false;
  await guard.withAcceptanceScope(IDENTITY, async () => {
    await assert.rejects(client.chat.completions.create(payload), error => error.status === 503);
    assert.equal(sends, 4);
    await assert.rejects(client.chat.completions.create(payload), isAcceptanceSpendError);
  });
  assert.equal(sends, 5, 'sixth physical send cannot leave the process, even under SDK retries');
  assert.equal(f.read().usedMicros, MAX_TOTAL_MICROS);
});

function child(script, args = [], environment = {}) {
  const childProcess = spawn(process.execPath, ['-e', script, guardModulePath, ...args], {
    // Give each child only its synthetic campaign setting; never mutate or
    // inherit the parent application's provider credentials/configuration.
    stdio: ['ignore', 'pipe', 'pipe'], env: { SIRAGPT_ACCEPTANCE_CAMPAIGN_FILE: '', ...environment },
  });
  let stdout = '';
  let stderr = '';
  childProcess.stdout.on('data', (data) => { stdout += data; });
  childProcess.stderr.on('data', (data) => { stderr += data; });
  const done = once(childProcess, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { process: childProcess, done };
}

test('multiple processes share the same atomic ledger without overspending', async (t) => {
  const f = fixture(t);
  const script = `
    const { createAcceptanceSpendGuard, ENDPOINT, MODEL } = require(process.argv[1]);
    const guard = createAcceptanceSpendGuard({ policyFile: process.argv[2], clock: () => ${NOW} });
    guard.withAcceptanceScope(${JSON.stringify(IDENTITY)}, () => guard.guardedFetch(async () => true)(ENDPOINT,
      { method: 'POST', body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'Synthetic.' }] }) }
    )).then(() => console.log('reserved'), error => console.log(error.code === 'E_QUOTA' ? 'denied' : 'unexpected'));
  `;
  const results = await Promise.all(Array.from({ length: 12 }, () => child(script, [f.policyFile]).done));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.trim(), /^(reserved|denied)$/);
  }
  const successes = results.filter((result) => result.stdout.trim() === 'reserved').length;
  assert.ok(successes >= 1 && successes <= 5);
  assert.equal(f.read().usedMicros, successes * ONE_USD_MICROS);
  assert.equal(f.read().reservations.length, successes);
  assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), false);
});

test('optional private policy is loaded at process startup, and invalid configuration never falls back to off', async (t) => {
  const f = fixture(t);
  const script = `
    try {
      const guard = require(process.argv[1]);
      console.log(JSON.stringify(guard.status()));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, reason: error.reason, message: error.message }));
    }
  `;
  const loaded = await child(script, [], { SIRAGPT_ACCEPTANCE_CAMPAIGN_FILE: f.policyFile }).done;
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).configured, true);
  f.write(f.policyFile, { ...f.policy, maxTotalMicros: 6_000_000 });
  const invalid = await child(script, [], { SIRAGPT_ACCEPTANCE_CAMPAIGN_FILE: f.policyFile }).done;
  assert.equal(invalid.code, 0, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).code, 'E_QUOTA');
  assert.equal(JSON.parse(invalid.stdout).reason, 'policy_invalid');
  assert.doesNotMatch(invalid.stdout, /synthetic|policy\.json|ledger\.json/);
});

test('killed process leaves a crash lock that is never stolen or reset', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const running = child(`
    const fs = require('node:fs');
    const fd = fs.openSync(process.argv[2] + '.lock', 'wx', 0o600);
    fs.fsyncSync(fd);
    console.log('locked');
    setInterval(() => {}, 1000);
  `, [f.ledgerPath]);
  t.after(() => { if (running.process.exitCode === null) running.process.kill('SIGKILL'); });
  await once(running.process.stdout, 'data');
  running.process.kill('SIGKILL');
  const result = await running.done;
  assert.equal(result.signal, 'SIGKILL');
  const old = new Date(0);
  fs.utimesSync(`${f.ledgerPath}.lock`, old, old);
  for (const current of [guard, f.create()]) {
    await assert.rejects(current.withAcceptanceScope(IDENTITY, () => current.guardedFetch(() => assert.fail('crash lock send'))(ENDPOINT, request())), quota('ledger_busy'));
    assert.equal(current.status().available, false);
  }
  assert.equal(f.read().usedMicros, 0);
  assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), true);
});
