'use strict';

const { raceWithSignal } = require('../../utils/retry-with-backoff');

function stopStream(stream) {
  try { stream?.controller?.abort(); } catch { /* best-effort SDK cleanup */ }
}

// Pass the signal upstream AND bound our waiter. An adapter ignoring abort
// must not leave generate pending or start a second paid call.
async function openGuardedStream(create, signal) {
  if (signal.aborted) throw signal.reason;
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw signal.reason;
    return create();
  });
  pending.then((stream) => {
    if (signal.aborted) stopStream(stream);
  }, () => {});
  return raceWithSignal(pending, signal);
}

async function* readGuardedStream(stream, signal) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const step = await raceWithSignal(iterator.next(), signal);
      if (step.done) return;
      yield step.value;
    }
  } finally {
    if (signal.aborted) stopStream(stream);
    // A return() queued behind a hung SDK next() must not block cancellation.
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* terminal */ }
  }
}

function firstByteTimeoutError() {
  return Object.assign(new Error('Provider first-byte deadline exceeded'), {
    name: 'TimeoutError', code: 'ETIMEDOUT', status: 408,
  });
}

module.exports = { openGuardedStream, readGuardedStream, firstByteTimeoutError };
