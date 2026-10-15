'use strict';

/**
 * A rate limit is not «no credits». Groq's free-tier 429 («Rate limit reached
 * … Please try again in 2m3s … Upgrade … /settings/billing») used to match the
 * billing classifier: Groq got a 30-min process-wide cooldown for every user
 * and a 5-hour job finished on whisper base. Now the job waits (Retry-After /
 * «try again in», abortable, ≤ 5 min) and retries the SAME provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audio = require('../src/services/audio-transcriber');

const GROQ_RATE_LIMIT = 'Rate limit reached for model `whisper-large-v3-turbo` in organization `org_01abc` service tier `on_demand` on seconds of audio per hour (ASH): Limit 7200, Used 7120, Requested 600. Please try again in 2m3s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
const OPENAI_RATE_LIMIT = 'Rate limit reached for whisper-1 in organization org-x on requests per min (RPM): Limit 50, Used 50, Requested 1. Please try again in 1.2s.';
const OPENAI_NO_CREDITS = '429 You exceeded your current quota, please check your plan and billing details.';

function tempFile(t, name = 'clase.mp4') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'fake-media');
  return file;
}

function segmenter(t, count) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-rate-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
      dir,
      segments: Array.from({ length: count }, (_, i) => {
        const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
        fs.writeFileSync(p, `segment-${i}`);
        return { path: p, index: i, offsetSeconds: i * 600 };
      }),
    };
  };
}

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const createFile = (_buffer, name) => ({ name });
const indexOf = (name) => { const m = /segment-(\d+)/.exec(String(name)); return m ? Number(m[1]) - 1 : -1; };

function sdk(handler) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request) {
      const index = indexOf(request.file.name);
      requests.push(index);
      return handler(index, requests.length);
    } } },
  };
}

/** Fake clock: sleeping advances it; nothing really waits. */
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

test.beforeEach(() => audio.clearTranscriptionCooldowns());

test('classification: rate limits are not billing; billing stays billing', () => {
  assert.equal(audio.isBillingError(err(429, GROQ_RATE_LIMIT)), false, 'a link to /settings/billing does not make a throttle «no credits»');
  assert.equal(audio.isRateLimitError(err(429, GROQ_RATE_LIMIT)), true);
  assert.equal(audio.isBillingError(err(429, OPENAI_RATE_LIMIT)), false);
  assert.equal(audio.isRateLimitError(err(429, OPENAI_RATE_LIMIT)), true);
  assert.equal(audio.isBillingError(err(429, OPENAI_NO_CREDITS, { code: 'insufficient_quota' })), true);
  assert.equal(audio.isBillingError(err(429, OPENAI_NO_CREDITS)), true);
  assert.equal(audio.isRateLimitError(err(429, OPENAI_NO_CREDITS)), false);
  assert.equal(audio.isBillingError(err(402, 'Payment Required')), true);
  assert.equal(audio.isRateLimitError(err(500, 'rate limit backend crashed')), false, 'a 5xx is transient, not a throttle');
  assert.equal(audio.isRateLimitError({ message: 'Too Many Requests' }), true);
});

test('parseRetryAfterMs reads headers and the «try again in» text', () => {
  assert.equal(audio.parseRetryAfterMs(err(429, GROQ_RATE_LIMIT)), 123_000);
  assert.equal(audio.parseRetryAfterMs(err(429, OPENAI_RATE_LIMIT)), 1200);
  assert.equal(audio.parseRetryAfterMs(err(429, 'Please try again in 450ms.')), 450);
  assert.equal(audio.parseRetryAfterMs(err(429, 'Please try again in 1h2m3.5s.')), 3_723_500);
  assert.equal(audio.parseRetryAfterMs(err(429, 'slow down', { headers: { 'Retry-After': '7' } })), 7000);
  assert.equal(audio.parseRetryAfterMs(err(429, 'slow down', { headers: new Headers({ 'retry-after-ms': '250' }) })), 250);
  assert.equal(audio.parseRetryAfterMs({ response: { status: 429, headers: { 'retry-after': new Date(61_000).toUTCString() } } }, 1_000), 60_000);
  assert.equal(audio.parseRetryAfterMs(err(429, 'slow down')), null);
});

test('a Groq rate limit mid-file waits the asked time and retries Groq; no cooldown, no local fallback', async (t) => {
  const clock = fakeClock();
  let limited = false;
  const groq = sdk((i) => {
    if (i === 1 && !limited) { limited = true; throw err(429, GROQ_RATE_LIMIT); }
    return { text: `parte ${i}`, segments: [] };
  });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_rate' }, language: 'es', durationSeconds: 2400, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 4), sleep: clock.sleep, now: clock.now,
    async localTranscribe() { throw new Error('local must not run for a throttle'); },
  });
  assert.deepEqual(groq.requests, [0, 1, 1, 2, 3]);
  assert.deepEqual(clock.sleeps, [123_000]);
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_rate' }), false);
  assert.deepEqual(result.providers, { groq: 4 });
  assert.equal(result.partial, false);
});

test('the pause is shared: other workers do not hammer a throttled provider', async (t) => {
  const clock = fakeClock();
  const startedAt = [];
  let limited = false;
  const groq = {
    audio: { transcriptions: { async create(request) {
      const i = indexOf(request.file.name);
      startedAt.push({ i, t: clock.t });
      await new Promise((r) => setImmediate(r));
      if (i === 0 && !limited) { limited = true; throw err(429, 'Too Many Requests', { headers: { 'retry-after': '60' } }); }
      return { text: `parte ${i}` };
    } } },
  };
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_shared' }, language: 'es', durationSeconds: 4800,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 8), sleep: clock.sleep, now: clock.now,
  });
  assert.equal(result.ok, true);
  const afterLimit = startedAt.slice(3); // the first 3 started together before the 429 arrived
  assert.ok(afterLimit.length >= 5 && afterLimit.every((r) => r.t >= 60_000), JSON.stringify(startedAt));
});

test('a 402 / no-credits 429 still starts the cooldown and moves the job to the next rung', async (t) => {
  const groq = sdk(() => { throw err(402, 'Payment Required: no credits'); });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_broke' }, language: 'es', durationSeconds: 1800, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 3), sleep: async () => { throw new Error('no waiting for billing'); },
    async localTranscribe() { return { text: 'local' }; },
  });
  assert.equal(groq.requests.length, 1);
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_broke' }), true);
  assert.deepEqual(result.providers, { local: 3 });
});

test('a throttle measured in hours (daily quota) is not waited out: this job moves on, no cooldown', async (t) => {
  const groq = sdk(() => { throw err(429, 'Rate limit reached on seconds of audio per day (ASD): Limit 28800. Please try again in 5h12m.'); });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_daily' }, language: 'es', durationSeconds: 1800, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 3), sleep: async () => { throw new Error('must not wait 5 h'); },
    async localTranscribe() { return { text: 'local' }; },
  });
  assert.equal(groq.requests.length, 1);
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_daily' }), false);
  assert.deepEqual(result.providers, { local: 3 });
});

test('without a hint the waits grow; after TRANSCRIBE_RATE_LIMIT_RETRIES the segment is demoted', async (t) => {
  const clock = fakeClock();
  const groq = sdk((i) => { if (i === 0) throw err(429, 'Too Many Requests'); return { text: `groq ${i}` }; });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_backoff', TRANSCRIBE_RATE_LIMIT_RETRIES: '2' }, language: 'es', durationSeconds: 1200, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 2), sleep: clock.sleep, now: clock.now,
    async localTranscribe() { return { text: 'local 0' }; },
  });
  assert.deepEqual(clock.sleeps, [15_000, 30_000]);
  assert.equal(result.transcript, 'local 0\n\ngroq 1');
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_backoff' }), false);
});

test('a voice note hitting a rate limit moves on at once and leaves the provider usable', async (t) => {
  const groq = sdk(() => { throw err(429, GROQ_RATE_LIMIT); });
  const result = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env: { GROQ_API_KEY: 'gsk_note' }, durationSeconds: 20, groqClient: groq, createFile,
    async localTranscribe() { return { text: 'nota local' }; },
  });
  assert.equal(result.transcript, 'nota local');
  assert.equal(groq.requests.length, 1);
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_note' }), false, 'the next audio still tries Groq');
});
