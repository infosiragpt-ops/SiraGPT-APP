'use strict';

// transcription-governor: process-wide per-provider admission for cloud STT.
// In-flight permits are FIFO and abortable; a 429 pauses the provider for
// every caller and halves its effective cap once per burst; clean traffic
// gives the slots back one per minute; RPM and audio-seconds-per-hour are
// rolling windows; a fake sleep that does not move the clock never spins.

const test = require('node:test');
const assert = require('node:assert/strict');
const gov = require('../src/services/transcription-governor');

function fakeClock() {
  const c = { t: 0, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('limits: published defaults per provider, TRANSCRIBE_<PROVIDER>_* overrides, bounds', () => {
  assert.equal(gov.limitsFor({}, 'elevenlabs').inFlight, 8);
  assert.equal(gov.limitsFor({}, 'assemblyai').inFlight, 32);
  assert.equal(gov.limitsFor({}, 'deepgram').inFlight, 24);
  assert.equal(gov.limitsFor({}, 'some-new-provider').inFlight, 6, 'an unknown provider gets the fallback cap');
  assert.deepEqual(gov.limitsFor({ TRANSCRIBE_GROQ_IN_FLIGHT: '3', TRANSCRIBE_GROQ_RPM: '20', TRANSCRIBE_GROQ_AUDIO_SECONDS_PER_HOUR: '7200' }, 'groq'),
    { inFlight: 3, rpm: 20, audioSecondsPerHour: 7200 });
  assert.deepEqual(gov.limitsFor({}, 'groq'), { inFlight: 8, rpm: null, audioSecondsPerHour: null }, 'quotas are unset: the 429 feedback decides');
  assert.equal(gov.limitsFor({ TRANSCRIBE_GROQ_IN_FLIGHT: '9999' }, 'groq').inFlight, 200);
  assert.equal(gov.limitsFor({ TRANSCRIBE_GROQ_IN_FLIGHT: 'abc' }, 'groq').inFlight, 8);
  assert.equal(gov.limitsFor({ TRANSCRIBE_GROQ_IN_FLIGHT: '0' }, 'groq').inFlight, 1);
});

test('in-flight cap: FIFO permits, a release admits the next waiter, an aborted waiter leaves the line', async () => {
  const c = fakeClock();
  const g = gov.createTranscriptionGovernor({ env: { TRANSCRIBE_GROQ_IN_FLIGHT: '2' }, now: c.now, sleep: c.sleep });
  const a = await g.acquire('groq', { audioSeconds: 600 });
  const b = await g.acquire('groq', { audioSeconds: 600 });
  assert.deepEqual(g.capacity('groq'), { free: 0, blocked: 'in_flight', paused: false, pausedMs: 0, inFlight: 2, waiting: 0, cap: 2 });
  const order = [];
  const p3 = g.acquire('groq').then((permit) => { order.push(3); return permit; });
  const p4 = g.acquire('groq').then((permit) => { order.push(4); return permit; });
  const ctrl = new AbortController();
  const p5 = g.acquire('groq', { signal: ctrl.signal });
  await flush();
  assert.deepEqual(order, []);
  assert.equal(g.capacity('groq').waiting, 3);
  ctrl.abort();
  await assert.rejects(p5, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(g.capacity('groq').waiting, 2);
  a.release('ok');
  const c3 = await p3;
  await flush();
  assert.deepEqual(order, [3], 'one release admits exactly one waiter, the oldest');
  b.release('error');
  await p4;
  assert.deepEqual(order, [3, 4]);
  c3.release('ok');
  c3.release('ok'); // idempotent
  const snap = g.snapshot().groq;
  assert.equal(snap.inFlight, 1);
  assert.equal(snap.completed, 2);
  assert.equal(snap.errors, 1);
  assert.equal(snap.audioSecondsPerHour.used, 1200);
  assert.equal(JSON.stringify(g.snapshot()).includes('gsk_'), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => g.acquire('groq', { signal: aborted.signal }), { name: 'AbortError' });
});

test('a rate limit pauses the provider for EVERY caller, halves the cap once per burst, and clean traffic earns slots back', async () => {
  const c = fakeClock();
  const g = gov.createTranscriptionGovernor({ env: { TRANSCRIBE_OPENAI_IN_FLIGHT: '8' }, now: c.now, sleep: c.sleep });
  const first = g.noteRateLimited('openai', 20_000);
  g.noteRateLimited('openai', null); // the same burst (within 5 s): no second halving, the pause is the longer one
  assert.equal(first.effectiveCap, 4);
  const paused = g.capacity('openai');
  assert.deepEqual({ free: paused.free, blocked: paused.blocked, pausedMs: paused.pausedMs, cap: paused.cap }, { free: 0, blocked: 'paused', pausedMs: 20_000, cap: 4 });
  // A caller sleeps the pause out on the governor's clock and is then admitted.
  const permit = await g.acquire('openai', { audioSeconds: 600 });
  assert.deepEqual(c.sleeps, [20_000]);
  assert.equal(c.t, 20_000);
  permit.release('ok');
  assert.equal(g.capacity('openai').cap, 4, 'no slot back within the minute after the shrink');
  c.t = 80_001;
  (await g.acquire('openai')).release('ok');
  assert.equal(g.capacity('openai').cap, 5, 'one slot back after a minute of clean traffic');
  (await g.acquire('openai')).release('ok');
  assert.equal(g.capacity('openai').cap, 5, 'not a second one in the same minute');
  c.t = 140_002;
  (await g.acquire('openai')).release('ok');
  assert.equal(g.capacity('openai').cap, 6);
  // A new burst after the cooldown halves again; the pause is bounded.
  const again = g.noteRateLimited('openai', 10 * 3_600_000);
  assert.equal(again.effectiveCap, 3);
  assert.equal(again.pausedMs, 30 * 60_000, 'a 10-hour hint is capped at 30 min');
  assert.equal(g.snapshot().openai.rateLimits, 3);
  // The cap never grows past the configured one.
  c.t = 10 * 3_600_000;
  for (let i = 0; i < 20; i++) { c.t += 61_000; (await g.acquire('openai')).release('ok'); }
  assert.equal(g.capacity('openai').cap, 8);
});

test('a fake sleep that does not move the clock still ends the pause: no spin, no hang', async () => {
  const c = { t: 0, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); }; // never advances the clock
  const g = gov.createTranscriptionGovernor({ env: {}, now: c.now, sleep: c.sleep });
  g.noteRateLimited('xai', 5_000);
  const permit = await g.acquire('xai');
  assert.deepEqual(c.sleeps, [5_000]);
  assert.equal(g.capacity('xai').paused, false);
  permit.release('ok');
});

test('requests per minute and audio seconds per hour are rolling windows the waiter sleeps out', async () => {
  const c = fakeClock();
  const g = gov.createTranscriptionGovernor({ env: { TRANSCRIBE_GROQ_RPM: '2', TRANSCRIBE_GROQ_AUDIO_SECONDS_PER_HOUR: '1200', TRANSCRIBE_GROQ_IN_FLIGHT: '50' }, now: c.now, sleep: c.sleep });
  (await g.acquire('groq', { audioSeconds: 600 })).release('ok');
  (await g.acquire('groq', { audioSeconds: 600 })).release('ok');
  assert.equal(g.capacity('groq').blocked, 'rpm');
  const permit = await g.acquire('groq', { audioSeconds: 10 });
  // The minute window first (both requests leave it together), then the hour.
  assert.deepEqual(c.sleeps, [60_000, 3_540_000]);
  permit.release('ok');
  const snap = g.snapshot().groq;
  assert.deepEqual(snap.rpm, { limit: 2, used: 1 });
  assert.deepEqual(snap.audioSecondsPerHour, { limit: 1200, used: 10 });
});

test('one process-wide governor; reset drops it (and rejects what still waits)', async () => {
  const a = gov.getTranscriptionGovernor();
  assert.equal(gov.getTranscriptionGovernor(), a);
  gov.resetTranscriptionGovernor();
  const b = gov.getTranscriptionGovernor();
  assert.notEqual(b, a);
  const c = fakeClock();
  const g = gov.createTranscriptionGovernor({ env: { TRANSCRIBE_META_IN_FLIGHT: '1' }, now: c.now, sleep: c.sleep });
  const held = await g.acquire('meta');
  const waiting = g.acquire('meta');
  g.reset();
  await assert.rejects(waiting, { name: 'AbortError' });
  held.release('ok');
  gov.resetTranscriptionGovernor();
});
