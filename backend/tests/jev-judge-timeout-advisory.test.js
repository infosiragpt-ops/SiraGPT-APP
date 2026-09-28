'use strict';

/**
 * «[rlcd/jev-judge] failed: typesafe_timeout» ×7 in a burst. The judge is
 * advisory (the heuristics decide when it has no verdict): a TypeSafe
 * timeout is logged at info and is never captured as a system issue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const judge = require('../src/services/rlcd/jev-turn-judge');
const fingerprint = require('../src/services/observability/system-errors/fingerprint');

function capture(t) {
  const out = { info: [], warn: [] };
  const original = { info: console.info, warn: console.warn };
  console.info = (...args) => out.info.push(args.join(' '));
  console.warn = (...args) => out.warn.push(args.join(' '));
  t.after(() => { console.info = original.info; console.warn = original.warn; });
  return out;
}

/** fetch that never answers and honours the abort signal (→ AbortError). */
function hangingFetch() {
  return (url, init) => new Promise((resolve, reject) => {
    const signal = init && init.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
}

test('a TypeSafe timeout fails open at info level, never as a warn/failure', async (t) => {
  const logs = capture(t);
  const verdict = await judge.judgeTurn({ text: 'hola, ¿qué tal?', env: { TYPESAFE_API_KEY: 'k' }, fetchImpl: hangingFetch(), timeoutMs: 20 });
  assert.equal(verdict, null);
  assert.equal(logs.warn.length, 0);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /^\[rlcd\/jev-judge\] sin veredicto \(advisory\): typesafe_timeout$/);
});

test('other judge failures still warn', async (t) => {
  const logs = capture(t);
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: '', headers: { get: () => null }, text: async () => '{"error":"x"}' });
  assert.equal(await judge.judgeTurn({ text: 'x', env: { TYPESAFE_API_KEY: 'k' }, fetchImpl }), null);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /^\[rlcd\/jev-judge\] failed: /);
});

test('the system-errors capture treats a judge timeout as noise', () => {
  assert.equal(fingerprint.isNoise({ text: '[rlcd/jev-judge] sin veredicto (advisory): typesafe_timeout' }), true);
  assert.equal(fingerprint.isNoise({ text: '[rlcd/jev-judge] failed: typesafe_timeout' }), true);
  assert.equal(fingerprint.isNoise({ text: '[rlcd/jev-judge] failed: typesafe_http_500' }), false);
});
