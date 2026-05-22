'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { WorkerPool, defaultSize, normalizeSize } = require('../src/utils/worker-pool');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'workers', 'heavy-analysis.worker.js');

test('defaultSize is between 1 and 4', () => {
  const n = defaultSize();
  assert.ok(n >= 1 && n <= 4, `expected 1..4, got ${n}`);
});

test('normalizeSize clamps invalid or fractional pool sizes to usable integers', () => {
  assert.equal(normalizeSize(0), 1);
  assert.equal(normalizeSize(-3), 1);
  assert.equal(normalizeSize(2.9), 2);
  assert.equal(normalizeSize(Number.NaN), defaultSize());
});

test('WorkerPool: size=0 is normalized instead of creating an unusable pool', async () => {
  const pool = new WorkerPool({ size: 0, workerPath: WORKER_PATH });
  try {
    assert.equal(pool.stats().size, 1);
    const out = await pool.run('echo', { normalized: true });
    assert.deepEqual(out, { normalized: true });
  } finally {
    await pool.close();
  }
});

test('WorkerPool: echo round-trip', async () => {
  const pool = new WorkerPool({ size: 2, workerPath: WORKER_PATH });
  try {
    const out = await pool.run('echo', { hello: 'world' });
    assert.deepEqual(out, { hello: 'world' });
  } finally {
    await pool.close();
  }
});

test('WorkerPool: word-count', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  try {
    const out = await pool.run('word-count', { text: 'hello world foo' });
    assert.equal(out.words, 3);
    assert.equal(out.chars, 15);
  } finally {
    await pool.close();
  }
});

test('WorkerPool: regex-scan finds matches', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  try {
    const out = await pool.run('regex-scan', {
      text: 'foo bar foo baz foo',
      pattern: 'foo',
      flags: 'g',
    });
    assert.equal(out.count, 3);
    assert.equal(out.truncated, false);
  } finally {
    await pool.close();
  }
});

test('WorkerPool: regex-scan can cap returned matches', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  try {
    const out = await pool.run('regex-scan', {
      text: 'foo foo foo foo',
      pattern: 'foo',
      flags: 'g',
      maxMatches: 2,
    });
    assert.equal(out.count, 2);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.matches.map(m => m.index), [0, 4]);
  } finally {
    await pool.close();
  }
});

test('WorkerPool: unknown message type rejects', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  try {
    await assert.rejects(pool.run('nonsense', {}), /unknown message type/);
  } finally {
    await pool.close();
  }
});

test('WorkerPool: closed pool rejects new jobs', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  await pool.close();
  await assert.rejects(pool.run('echo', {}), /closed/);
});

test('WorkerPool: distributes work across workers (round-robin)', async () => {
  const pool = new WorkerPool({ size: 2, workerPath: WORKER_PATH });
  try {
    const results = await Promise.all([
      pool.run('echo', { i: 1 }),
      pool.run('echo', { i: 2 }),
      pool.run('echo', { i: 3 }),
      pool.run('echo', { i: 4 }),
    ]);
    assert.deepEqual(results.map(r => r.i), [1, 2, 3, 4]);
  } finally {
    await pool.close();
  }
});

test('WorkerPool: timeout rejects', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH });
  try {
    // Submit with an absurdly short timeout against a slow regex pattern
    // (catastrophic backtracking on a long string).
    const longText = 'a'.repeat(2000);
    await assert.rejects(
      pool.run('regex-scan', {
        text: longText + '!',
        pattern: '^(a+)+$',
        flags: '',
      }, { timeoutMs: 1 }),
      /timed out/
    );
  } finally {
    await pool.close();
  }
});

test('WorkerPool: timed-out jobs recycle the stuck worker before accepting more work', async () => {
  const pool = new WorkerPool({ size: 1, workerPath: WORKER_PATH, timeoutMs: 200 });
  try {
    const longText = 'a'.repeat(2000);
    await assert.rejects(
      pool.run('regex-scan', {
        text: longText + '!',
        pattern: '^(a+)+$',
        flags: '',
      }, { timeoutMs: 1 }),
      /timed out/,
    );

    const out = await pool.run('echo', { recovered: true }, { timeoutMs: 500 });
    assert.deepEqual(out, { recovered: true });
  } finally {
    await pool.close();
  }
});
