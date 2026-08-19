'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSlowQueryLogger } = require('../src/db/slow-query-logger');

function makeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function silentLogger() { return { warn() {}, error() {}, info() {} }; }

test('records queries that exceed threshold and skips fast queries', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 200,
    sampleRate: 1,
    bufferSize: 10,
    logger: silentLogger(),
    now: clock.now,
  });

  const fastQuery = () => { clock.advance(50); return Promise.resolve('fast'); };
  const slowQuery = () => { clock.advance(350); return Promise.resolve('slow'); };

  await slow.tracedQuery({ model: 'User', operation: 'findMany', args: { where: { id: 1 } }, query: fastQuery });
  await slow.tracedQuery({ model: 'User', operation: 'findUnique', args: { where: { id: 2 } }, query: slowQuery });

  const recorded = slow.getSlowQueries();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].model, 'User');
  assert.equal(recorded[0].operation, 'findUnique');
  assert.equal(recorded[0].durationMs, 350);
  assert.equal(recorded[0].thresholdMs, 200);
  assert.equal(recorded[0].success, true);
  assert.match(recorded[0].args, /"id":2/);
  assert.ok(recorded[0].stack.length > 0);

  const stats = slow.getStats();
  assert.equal(stats.queries, 2);
  assert.equal(stats.sampled, 2);
  assert.equal(stats.slow, 1);
});

test('respects sampleRate by skipping unsampled fast path', async () => {
  const clock = makeClock();
  let calls = 0;
  const slow = createSlowQueryLogger({
    thresholdMs: 100,
    sampleRate: 0,
    bufferSize: 5,
    logger: silentLogger(),
    now: clock.now,
    random: () => 0.99, // never < sampleRate=0
  });
  await slow.tracedQuery({
    model: 'X', operation: 'op', args: {},
    query: () => { calls += 1; clock.advance(500); return Promise.resolve(1); },
  });
  assert.equal(calls, 1);
  const stats = slow.getStats();
  assert.equal(stats.queries, 1);
  assert.equal(stats.sampled, 0);
  assert.equal(stats.slow, 0);
});

test('records errored queries and surfaces error code', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 50, sampleRate: 1, bufferSize: 4, logger: silentLogger(), now: clock.now,
  });
  const boom = () => { clock.advance(300); const err = new Error('nope'); err.code = 'P2024'; return Promise.reject(err); };
  await assert.rejects(
    slow.tracedQuery({ model: 'M', operation: 'find', args: {}, query: boom }),
    /nope/,
  );
  const [entry] = slow.getSlowQueries();
  assert.equal(entry.success, false);
  assert.equal(entry.errorCode, 'P2024');
});

test('ring buffer evicts oldest entries past capacity', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 10, sampleRate: 1, bufferSize: 3, logger: silentLogger(), now: clock.now,
  });
  for (let i = 0; i < 5; i++) {
    await slow.tracedQuery({
      model: 'T', operation: `op${i}`, args: { i },
      query: () => { clock.advance(100); return Promise.resolve(); },
    });
  }
  const all = slow.getSlowQueries();
  assert.equal(all.length, 3);
  // newest first
  assert.equal(all[0].operation, 'op4');
  assert.equal(all[1].operation, 'op3');
  assert.equal(all[2].operation, 'op2');
  assert.equal(slow.getStats().bufferUsed, 3);
});

test('onSlow listener is invoked with entry, errors swallowed', async () => {
  const clock = makeClock();
  const seen = [];
  const slow = createSlowQueryLogger({
    thresholdMs: 50, sampleRate: 1, bufferSize: 4, logger: silentLogger(), now: clock.now,
    onSlow: (e) => { seen.push(e); throw new Error('listener should not break flow'); },
  });
  await slow.tracedQuery({
    model: 'A', operation: 'b', args: { x: 1 },
    query: () => { clock.advance(100); return Promise.resolve('ok'); },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].operation, 'b');
});

test('extension shape is compatible with prisma.$extends', () => {
  const slow = createSlowQueryLogger();
  assert.equal(typeof slow.extension, 'object');
  assert.equal(slow.extension.name, 'siraGPTSlowQueryLogger');
  assert.equal(typeof slow.extension.query.$allModels.$allOperations, 'function');
});

test('extension wires through tracedQuery when invoked like Prisma would', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 100, sampleRate: 1, bufferSize: 4, logger: silentLogger(), now: clock.now,
  });
  const result = await slow.extension.query.$allModels.$allOperations({
    model: 'Post', operation: 'findFirst', args: { where: { slug: 'x' } },
    query: () => { clock.advance(250); return Promise.resolve({ id: 1 }); },
  });
  assert.deepEqual(result, { id: 1 });
  const [entry] = slow.getSlowQueries();
  assert.equal(entry.model, 'Post');
});

test('args are sanitized: bigint, buffers, circular structures', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 1, sampleRate: 1, bufferSize: 4, logger: silentLogger(), now: clock.now,
  });
  const circular = { name: 'x' }; circular.self = circular;
  const args = { big: 10n, buf: Buffer.from('hello'), circular };
  await slow.tracedQuery({
    model: 'M', operation: 'op', args,
    query: () => { clock.advance(10); return Promise.resolve(); },
  });
  const [entry] = slow.getSlowQueries();
  assert.match(entry.args, /10n/);
  assert.match(entry.args, /<Buffer length=5>/);
  assert.match(entry.args, /\[Circular\]/);
});

test('reset clears buffer and counters', async () => {
  const clock = makeClock();
  const slow = createSlowQueryLogger({
    thresholdMs: 10, sampleRate: 1, bufferSize: 4, logger: silentLogger(), now: clock.now,
  });
  await slow.tracedQuery({
    model: 'M', operation: 'op', args: {},
    query: () => { clock.advance(50); return Promise.resolve(); },
  });
  assert.equal(slow.getSlowQueries().length, 1);
  slow.reset();
  assert.equal(slow.getSlowQueries().length, 0);
  assert.equal(slow.getStats().queries, 0);
});

test('default sampleRate is 0.01 in production and 1 elsewhere', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.SLOW_QUERY_SAMPLE_RATE;
    const prod = createSlowQueryLogger({ thresholdMs: 1, bufferSize: 1, logger: silentLogger() });
    assert.equal(prod.getStats().sampleRate, 0.01);

    process.env.NODE_ENV = 'development';
    const dev = createSlowQueryLogger({ thresholdMs: 1, bufferSize: 1, logger: silentLogger() });
    assert.equal(dev.getStats().sampleRate, 1);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
  }
});
