import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentBackgroundLoop, drainDocumentOperations } from '../src/modules/doc-sandbox/background-lifecycle';

// Native promises, timers and file handles test scheduling/resource ownership.
// No worker, database, storage protocol or document validator is substituted.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('construction and stop before start do not launch any operation', async () => {
  let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => { calls++; }, 2);
  assert.equal(loop.pending(), undefined);
  loop.stop(); loop.stop(); loop.start(); loop.start(2);
  await delay(10);
  assert.equal(calls, 0);
});

test('start is idempotent and ticks are paced after completion, never overlapping', { timeout: 2000 }, async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => {
    calls++;
    if (calls === 1) await first.promise;
    else { loop.stop(); second.resolve(); }
  }, 2);
  try {
    loop.start(); loop.start();
    assert.equal(calls, 1);
    const retained = loop.pending();
    await delay(15);
    assert.equal(calls, 1);
    assert.equal(loop.pending(), retained);
    first.resolve(); await second.promise; await loop.pending();
    assert.equal(calls, 2);
  } finally { loop.stop(); first.resolve(); await loop.pending(); }
});

test('stopping active work retains its promise and forbids a late rearm', async () => {
  const work = deferred(); let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => { calls++; await work.promise; }, 2);
  loop.start();
  const retained = loop.pending();
  loop.stop(); work.resolve(); await retained;
  loop.start(); await delay(10);
  assert.equal(loop.pending(), retained);
  assert.equal(calls, 1);
});

test('initial delay is cancellable without creating or retaining an operation', async () => {
  let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => { calls++; }, 2);
  loop.start(10); assert.equal(calls, 0); loop.stop();
  await delay(20);
  assert.equal(calls, 0);
  assert.equal(loop.pending(), undefined);
});

test('initial delayed operation executes and can stop itself without another timer', { timeout: 2000 }, async () => {
  const done = deferred(); let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => { calls++; loop.stop(); done.resolve(); }, 2);
  try {
    loop.start(2); await done.promise; await loop.pending();
    await delay(10); assert.equal(calls, 1);
  } finally { loop.stop(); }
});

test('pause permits startup retry but an old completion cannot schedule work for the new generation', async () => {
  const old = deferred(), current = deferred(); let calls = 0;
  const loop = new DocumentBackgroundLoop(async () => { calls++; await (calls === 1 ? old.promise : current.promise); }, 2);
  try {
    loop.start(); const previous = loop.pending();
    loop.pause(); loop.start(); const retained = loop.pending();
    assert.notEqual(previous, retained);
    old.resolve(); await previous; await delay(10);
    assert.equal(calls, 2);
    assert.equal(loop.pending(), retained);
  } finally { loop.stop(); old.resolve(); current.resolve(); await loop.pending(); }
});

test('operation rejection identity is retained for draining, without claiming successful work', async () => {
  const failure = new Error('operation failed');
  const loop = new DocumentBackgroundLoop(async () => { throw failure; }, 50);
  loop.start(); loop.stop();
  await assert.rejects(loop.pending()!, error => error === failure);
});

test('drain releases immediately when empty and waits for rejected as well as fulfilled work', async () => {
  const order: string[] = [];
  await drainDocumentOperations([], async () => { order.push('empty'); }, () => assert.fail('unexpected timeout'));
  const work = deferred(), other = deferred();
  const draining = drainDocumentOperations([work.promise, other.promise], async () => { order.push('released'); },
    () => assert.fail('unexpected timeout'), 1000);
  work.reject(new Error('failed task'));
  await delay(5);
  assert.deepEqual(order, ['empty']);
  other.resolve(); await draining;
  assert.deepEqual(order, ['empty', 'released']);
});

test('release failures propagate synchronously after a completed drain', async () => {
  const failure = new Error('close failed');
  await assert.rejects(drainDocumentOperations([], async () => { throw failure; },
    () => assert.fail('no timeout')), error => error === failure);
});

test('timeout keeps a real file handle usable until the pending write finishes, then closes it once', { timeout: 2000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'doc-background-'));
  const file = await open(path.join(directory, 'private.txt'), 'wx', 0o600);
  const allowWrite = deferred(), released = deferred();
  let notices = 0, closes = 0;
  const write = (async () => { await allowWrite.promise; await file.writeFile('original preserved'); })();
  try {
    await drainDocumentOperations([write], async () => {
      await file.close(); closes++; released.resolve();
    }, () => { notices++; }, 5);
    assert.equal(notices, 1); assert.equal(closes, 0);
    assert.equal((await file.stat()).size, 0);
    allowWrite.resolve(); await released.promise;
    assert.equal(await readFile(path.join(directory, 'private.txt'), 'utf8'), 'original preserved');
    assert.equal(closes, 1); assert.equal(notices, 1);
    await assert.rejects(file.stat(), { code: 'EBADF' });
  } finally {
    allowWrite.resolve(); await write; await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a deferred release failure emits a second pending notice rather than an unhandled rejection', { timeout: 2000 }, async () => {
  const work = deferred(), reported = deferred(); let notices = 0, releases = 0;
  await drainDocumentOperations([work.promise], async () => { releases++; throw new Error('late close failed'); },
    () => { if (++notices === 2) reported.resolve(); }, 5);
  assert.equal(notices, 1); assert.equal(releases, 0);
  work.reject(new Error('late task failure')); await reported.promise;
  assert.equal(notices, 2); assert.equal(releases, 1);
});
