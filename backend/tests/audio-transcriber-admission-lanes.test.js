'use strict';

// The engine admits work through one gate: two shared slots, one slot for the
// media queue's short lane and one for interactive callers (dictation, inline
// link clips, the runner's transcribe_audio). Long queue jobs can hold the
// shared slots for hours; neither a voice note nor a dictation may wait on them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _enqueueTranscription: enqueue, TRANSCRIPTION_CONCURRENCY } = require('../src/services/audio-transcriber');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('interactive and short work start while long work holds every shared slot; more long work waits', async () => {
  const controller = new AbortController();
  const holds = [];
  for (let i = 0; i < TRANSCRIPTION_CONCURRENCY; i += 1) {
    const hold = deferred();
    holds.push(hold);
    enqueue(() => hold.promise, controller.signal, null);
  }

  let waitingLongStarted = false;
  const longWaiter = enqueue(async () => { waitingLongStarted = true; return 'long'; }, controller.signal, null);

  const interactive = await enqueue(async () => 'dictation', controller.signal, 'interactive');
  assert.equal(interactive, 'dictation', 'the interactive slot is free while long jobs hold the shared ones');
  const short = await enqueue(async () => 'voice-note', controller.signal, 'short');
  assert.equal(short, 'voice-note', 'the short lane keeps its own slot');
  assert.equal(waitingLongStarted, false, 'long work never takes the interactive or short slot');

  for (const hold of holds) hold.resolve('done');
  assert.equal(await longWaiter, 'long');
});

test('an unknown lane name is treated as shared work', async () => {
  const controller = new AbortController();
  const holds = [];
  for (let i = 0; i < TRANSCRIPTION_CONCURRENCY; i += 1) {
    const hold = deferred();
    holds.push(hold);
    enqueue(() => hold.promise, controller.signal, null);
  }
  let started = false;
  const odd = enqueue(async () => { started = true; return 'odd'; }, controller.signal, 'vip');
  await new Promise((r) => setImmediate(r));
  assert.equal(started, false);
  for (const hold of holds) hold.resolve('done');
  assert.equal(await odd, 'odd');
});
