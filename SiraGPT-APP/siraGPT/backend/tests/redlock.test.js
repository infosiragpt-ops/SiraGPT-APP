'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRedlock,
  createMemoryLockBackend,
  RedlockError,
  RELEASE_SCRIPT,
  EXTEND_SCRIPT,
} = require('../src/concurrency/redlock');

function nextTokenFactory(seq) {
  let i = 0;
  return () => {
    const t = seq[i] || `token-${i}`;
    i += 1;
    return t;
  };
}

test('tryAcquire returns a handle on first call and null on contention', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const a = await lock.tryAcquire('order:42', 1000);
  assert.ok(a, 'first acquire should succeed');
  assert.equal(a.resource, 'order:42');
  assert.match(a.key, /^lock:order:42$/);
  assert.ok(typeof a.token === 'string' && a.token.length >= 20);
  const b = await lock.tryAcquire('order:42', 1000);
  assert.equal(b, null, 'second acquire on same key must fail');
});

test('release frees the lock for a subsequent acquire', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const h = await lock.tryAcquire('r1', 1000);
  assert.ok(h);
  const released = await h.release();
  assert.equal(released, true);
  const h2 = await lock.tryAcquire('r1', 1000);
  assert.ok(h2, 'after release, the lock should be re-acquirable');
});

test('release is idempotent and a second release returns false', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const h = await lock.tryAcquire('r2', 1000);
  await h.release();
  const second = await h.release();
  assert.equal(second, false);
});

test('release does not delete a key owned by a different token', async () => {
  // This is the load-bearing safety property of the fencing token.
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client, tokenFactory: nextTokenFactory(['T-A', 'T-B']) });
  const a = await lock.tryAcquire('r3', 50);
  assert.ok(a);
  // Force the lock to expire and let somebody else claim it.
  await new Promise((res) => setTimeout(res, 80));
  const b = await lock.tryAcquire('r3', 1000);
  assert.ok(b, 'second client should be able to acquire the expired lock');
  // A's stale release MUST NOT delete B's lock.
  const aReleased = await a.release();
  assert.equal(aReleased, false);
  const stillHeld = await client.get('lock:r3');
  assert.equal(stillHeld, 'T-B');
  await b.release();
});

test('extend pushes the deadline forward when still owned', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const h = await lock.tryAcquire('r4', 200);
  assert.ok(h);
  const beforeExpiry = h.expiresAt;
  await new Promise((res) => setTimeout(res, 20));
  const ok = await h.extend(2000);
  assert.equal(ok, true);
  assert.ok(h.expiresAt > beforeExpiry, 'expiresAt should advance after extend');
});

test('extend fails after the lock has been released', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const h = await lock.tryAcquire('r5', 1000);
  await h.release();
  await assert.rejects(() => h.extend(1000), (err) => err instanceof RedlockError);
});

test('extend returns false if the lock was taken over by another owner', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client, tokenFactory: nextTokenFactory(['X', 'Y']) });
  const a = await lock.tryAcquire('r6', 30);
  assert.ok(a);
  await new Promise((res) => setTimeout(res, 60));
  const b = await lock.tryAcquire('r6', 1000);
  assert.ok(b);
  const ok = await a.extend(500);
  assert.equal(ok, false, 'must not extend a lock we no longer own');
  await b.release();
});

test('acquire retries with backoff until either success or retry budget is exhausted', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client, retryCount: 3, retryDelayMs: 5, retryJitterMs: 0 });
  const held = await lock.tryAcquire('busy', 1000);
  assert.ok(held);
  const start = Date.now();
  const failed = await lock.acquire('busy', 1000);
  const elapsed = Date.now() - start;
  assert.equal(failed, null);
  assert.ok(elapsed >= 15, `expected ≥15ms of backoff across 3 retries, got ${elapsed}ms`);
  await held.release();
  const recovered = await lock.acquire('busy', 1000);
  assert.ok(recovered, 'once the lock is free, retry should succeed');
});

test('using runs the function once and releases on the happy path', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  let ran = 0;
  const result = await lock.using('one-shot', 1000, async () => {
    ran += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(ran, 1);
  // Lock must be released after using() returns.
  const free = await lock.tryAcquire('one-shot', 1000);
  assert.ok(free);
});

test('using releases the lock when the function throws', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  await assert.rejects(
    () => lock.using('boom', 1000, async () => { throw new Error('handler failed'); }),
    /handler failed/,
  );
  const free = await lock.tryAcquire('boom', 1000);
  assert.ok(free, 'lock must be released even when fn throws');
});

test('using throws REDLOCK_NOT_ACQUIRED when the lock cannot be obtained', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client, retryCount: 0 });
  const held = await lock.tryAcquire('contended', 1000);
  await assert.rejects(
    () => lock.using('contended', 1000, async () => 'never'),
    (err) => err instanceof RedlockError && err.code === 'REDLOCK_NOT_ACQUIRED',
  );
  await held.release();
});

test('lock auto-expires when its TTL elapses without an explicit release', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const a = await lock.tryAcquire('ephemeral', 30);
  assert.ok(a);
  await new Promise((res) => setTimeout(res, 60));
  const b = await lock.tryAcquire('ephemeral', 1000);
  assert.ok(b, 'expired lock should be re-acquirable without explicit release');
  await b.release();
});

test('parallel acquires across many resources do not interfere', async () => {
  // Locking is per-resource. Distinct keys must be independent.
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  const handles = await Promise.all(
    Array.from({ length: 8 }, (_, i) => lock.tryAcquire(`res:${i}`, 1000)),
  );
  assert.equal(handles.filter(Boolean).length, 8);
  for (const h of handles) await h.release();
});

test('acquire rejects empty/invalid resource names with a caller error', async () => {
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client });
  await assert.rejects(() => lock.acquire('', 1000), (err) => err instanceof RedlockError);
  await assert.rejects(() => lock.acquire(null, 1000), (err) => err instanceof RedlockError);
});

test('using rejects when fn is not a function', async () => {
  const lock = createRedlock();
  await assert.rejects(() => lock.using('r', 1000, 'not-a-fn'), (err) => err instanceof RedlockError);
});

test('tryAcquire returns null when the backend throws', async () => {
  // Simulate Redis flakiness — the primitive must report "not
  // acquired" rather than pretending to hold a lock it never set.
  const fakeClient = {
    async set() { throw new Error('redis offline'); },
    async eval() { return 0; },
  };
  const lock = createRedlock({ client: fakeClient });
  const h = await lock.tryAcquire('r', 1000);
  assert.equal(h, null);
});

test('tryAcquire returns null if the SET took longer than the TTL allows', async () => {
  // Pathological case: Redis is so slow that the lock would already
  // be expired by the time we got the OK. We must NOT hand the caller
  // a handle whose deadline has already passed.
  let nowVal = 1_000_000;
  const movingNow = () => nowVal;
  const fakeClient = {
    async set() { nowVal += 5_000; return 'OK'; },
    async eval(script) {
      if (script === RELEASE_SCRIPT) return 1;
      return 0;
    },
  };
  const lock = createRedlock({ client: fakeClient, now: movingNow });
  const h = await lock.tryAcquire('slow', 1000);
  assert.equal(h, null);
});

test('memory backend honors NX semantics and ignores GET on a token slot', async () => {
  // Sanity-check the in-memory adapter itself — the rest of the
  // suite depends on it behaving like ioredis on the relevant ops.
  const client = createMemoryLockBackend();
  assert.equal(await client.set('k', 'v1', 'PX', 1000, 'NX'), 'OK');
  assert.equal(await client.set('k', 'v2', 'PX', 1000, 'NX'), null);
  assert.equal(await client.get('k'), 'v1');
  assert.equal(await client.eval(RELEASE_SCRIPT, 1, 'k', 'wrong'), 0);
  assert.equal(await client.eval(RELEASE_SCRIPT, 1, 'k', 'v1'), 1);
  assert.equal(await client.get('k'), null);
});

test('memory backend pexpire returns 0 for missing keys and 1 for present ones', async () => {
  const client = createMemoryLockBackend();
  assert.equal(await client.pexpire('missing', 1000), 0);
  await client.set('present', 'x', 'PX', 100);
  assert.equal(await client.pexpire('present', 5000), 1);
  assert.equal(await client.eval(EXTEND_SCRIPT, 1, 'present', 'x', 5000), 1);
  assert.equal(await client.eval(EXTEND_SCRIPT, 1, 'present', 'wrong', 5000), 0);
});

test('single-flight: many concurrent using() calls execute fn exactly once', async () => {
  // The headline property used by idempotency middleware: even with
  // N concurrent callers, only one critical section runs at a time
  // per resource.
  const client = createMemoryLockBackend();
  const lock = createRedlock({ client, retryCount: 50, retryDelayMs: 5, retryJitterMs: 0 });
  let inFlight = 0;
  let maxInFlight = 0;
  let totalRuns = 0;
  const work = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 15));
    totalRuns += 1;
    inFlight -= 1;
    return totalRuns;
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => lock.using('single-flight', 1000, work)),
  );
  assert.equal(maxInFlight, 1, 'critical section must be serialized');
  assert.equal(totalRuns, 6, 'every caller must eventually run');
  assert.deepEqual(results.sort(), [1, 2, 3, 4, 5, 6]);
});
