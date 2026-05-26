'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ToolCallReplayLog,
  createReplayLog,
  getReplayLog,
  buildKey,
  stableStringify,
  DEFAULT_TTL_MS,
  _resetForTests,
} = require('../src/services/agents/tool-call-replay-log');

function makeClock(start = 1_000_000) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => { now += ms; };
  fn.set = (ms) => { now = ms; };
  return fn;
}

test('buildKey is deterministic and stable across argument key order', () => {
  const a = buildKey({ toolName: 'create_chart', args: { type: 'bar', data: [1, 2] } });
  const b = buildKey({ toolName: 'create_chart', args: { data: [1, 2], type: 'bar' } });
  assert.equal(a, b);
  assert.match(a, /^v1:create_chart:[a-f0-9]{32}$/);
});

test('buildKey changes when toolName, args or scope differ', () => {
  const base = buildKey({ toolName: 'tool', args: { x: 1 } });
  assert.notEqual(base, buildKey({ toolName: 'tool', args: { x: 2 } }));
  assert.notEqual(base, buildKey({ toolName: 'tool2', args: { x: 1 } }));
  assert.notEqual(base, buildKey({ toolName: 'tool', args: { x: 1 }, scope: 'task-7' }));
});

test('buildKey rejects empty / non-string toolName', () => {
  assert.throws(() => buildKey({ toolName: '' }), TypeError);
  assert.throws(() => buildKey({ toolName: null }), TypeError);
  assert.throws(() => buildKey({}), TypeError);
});

test('stableStringify handles undefined, NaN, BigInt, Buffer, Date, RegExp', () => {
  assert.equal(stableStringify(undefined), 'undef');
  assert.equal(stableStringify(NaN), '"NaN"');
  assert.equal(stableStringify(10n), '"bigint:10"');
  assert.equal(stableStringify(new Date('2026-01-01T00:00:00Z')), '"date:2026-01-01T00:00:00.000Z"');
  assert.equal(stableStringify(/abc/i), '"regex:/abc/i"');
  assert.equal(stableStringify(Buffer.from('hi')), `"buf:${Buffer.from('hi').toString('base64')}"`);
});

test('record + replay returns deep-cloned output (mutating cached entry does not leak)', () => {
  const log = new ToolCallReplayLog();
  const output = { rows: [{ id: 1 }], meta: { count: 1 } };
  log.record({ toolName: 'sql_query', args: { q: 'SELECT 1' }, output });
  output.rows[0].id = 999; // mutate after record

  const r1 = log.replay({ toolName: 'sql_query', args: { q: 'SELECT 1' } });
  assert.equal(r1.hit, true);
  assert.deepEqual(r1.entry.output, { rows: [{ id: 1 }], meta: { count: 1 } });

  r1.entry.output.rows[0].id = 42; // mutate replayed copy
  const r2 = log.replay({ toolName: 'sql_query', args: { q: 'SELECT 1' } });
  assert.equal(r2.entry.output.rows[0].id, 1, 'cached entry must remain immutable');
});

test('replay miss returns hit=false and bumps misses', () => {
  const log = new ToolCallReplayLog();
  const r = log.replay({ toolName: 'nope', args: {} });
  assert.equal(r.hit, false);
  assert.equal(r.entry, null);
  assert.equal(log.stats().misses, 1);
});

test('TTL expiry: entries past expiresAt are not replayable and increment expired', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 1000 });
  log.record({ toolName: 't', args: { a: 1 }, output: 'ok' });
  assert.equal(log.replay({ toolName: 't', args: { a: 1 } }).hit, true);

  clock.advance(1500);
  const r = log.replay({ toolName: 't', args: { a: 1 } });
  assert.equal(r.hit, false);
  assert.ok(log.stats().expired >= 1);
  assert.equal(log.size(), 0);
});

test('default TTL is 1 hour', () => {
  assert.equal(DEFAULT_TTL_MS, 60 * 60 * 1000);
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock });
  log.record({ toolName: 't', args: {}, output: 'x' });
  clock.advance(60 * 60 * 1000 - 1);
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, true);
  clock.advance(2);
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, false);
});

test('per-record ttlMs override beats default', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 60_000 });
  log.record({ toolName: 't', args: {}, output: 'x', ttlMs: 100 });
  clock.advance(150);
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, false);
});

test('LRU capacity eviction: oldest entries dropped when over maxEntries', () => {
  const log = new ToolCallReplayLog({ maxEntries: 3 });
  log.record({ toolName: 't', args: { i: 1 }, output: 1 });
  log.record({ toolName: 't', args: { i: 2 }, output: 2 });
  log.record({ toolName: 't', args: { i: 3 }, output: 3 });
  // Touch entry 1 to mark recently used
  log.replay({ toolName: 't', args: { i: 1 } });
  log.record({ toolName: 't', args: { i: 4 }, output: 4 });

  assert.equal(log.size(), 3);
  assert.equal(log.has({ toolName: 't', args: { i: 2 } }), false, 'oldest evicted');
  assert.equal(log.has({ toolName: 't', args: { i: 1 } }), true);
  assert.equal(log.has({ toolName: 't', args: { i: 4 } }), true);
  assert.ok(log.stats().evicted >= 1);
});

test('replay does not extend TTL (reuse-only semantics)', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 1000 });
  log.record({ toolName: 't', args: {}, output: 'x' });
  clock.advance(800);
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, true);
  clock.advance(300); // total 1100 > ttl 1000
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, false);
});

test('record over existing key updates output and resets TTL', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 1000 });
  log.record({ toolName: 't', args: { a: 1 }, output: 'v1' });
  clock.advance(800);
  log.record({ toolName: 't', args: { a: 1 }, output: 'v2' });
  clock.advance(500); // 1300 from start, but second record was at 800 → 500 elapsed since
  const r = log.replay({ toolName: 't', args: { a: 1 } });
  assert.equal(r.hit, true);
  assert.equal(r.entry.output, 'v2');
});

test('invalidate, invalidateScope, invalidateTool', () => {
  const log = new ToolCallReplayLog();
  log.record({ toolName: 'a', args: { i: 1 }, output: 1, scope: 's1' });
  log.record({ toolName: 'a', args: { i: 2 }, output: 2, scope: 's2' });
  log.record({ toolName: 'b', args: { i: 1 }, output: 3, scope: 's1' });

  assert.equal(log.invalidate({ toolName: 'a', args: { i: 1 }, scope: 's1' }), true);
  assert.equal(log.size(), 2);

  assert.equal(log.invalidateScope('s2'), 1);
  assert.equal(log.size(), 1);

  assert.equal(log.invalidateTool('b'), 1);
  assert.equal(log.size(), 0);
});

test('failed tool calls (ok=false) are still replayable when stored', () => {
  const log = new ToolCallReplayLog();
  log.record({
    toolName: 'http_get',
    args: { url: 'https://x' },
    output: { error: 'TIMEOUT' },
    ok: false,
  });
  const r = log.replay({ toolName: 'http_get', args: { url: 'https://x' } });
  assert.equal(r.hit, true);
  assert.equal(r.entry.ok, false);
  assert.deepEqual(r.entry.output, { error: 'TIMEOUT' });
});

test('stats() reflects hits, misses, expired, recorded, evicted', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 100, maxEntries: 2 });
  log.record({ toolName: 't', args: { i: 1 }, output: 'x' });
  log.record({ toolName: 't', args: { i: 2 }, output: 'y' });
  log.record({ toolName: 't', args: { i: 3 }, output: 'z' }); // evicts i:1

  log.replay({ toolName: 't', args: { i: 2 } }); // hit
  log.replay({ toolName: 't', args: { i: 1 } }); // miss (evicted)

  clock.advance(200);
  log.replay({ toolName: 't', args: { i: 3 } }); // expired → miss

  const s = log.stats();
  assert.equal(s.recorded, 3);
  assert.equal(s.hits, 1);
  assert.ok(s.misses >= 2);
  assert.ok(s.evicted >= 1);
  assert.ok(s.expired >= 1);
});

test('sweepExpired removes only expired entries', () => {
  const clock = makeClock();
  const log = new ToolCallReplayLog({ clock, ttlMs: 1000 });
  log.record({ toolName: 't', args: { i: 1 }, output: 1 });
  clock.advance(500);
  log.record({ toolName: 't', args: { i: 2 }, output: 2 });
  clock.advance(700); // i:1 elapsed 1200 (expired), i:2 elapsed 700 (alive)
  const removed = log.sweepExpired();
  assert.equal(removed, 1);
  assert.equal(log.has({ toolName: 't', args: { i: 2 } }), true);
  assert.equal(log.has({ toolName: 't', args: { i: 1 } }), false);
});

test('clear empties the log', () => {
  const log = new ToolCallReplayLog();
  log.record({ toolName: 't', args: {}, output: 'x' });
  log.clear();
  assert.equal(log.size(), 0);
  assert.equal(log.replay({ toolName: 't', args: {} }).hit, false);
});

test('Buffer outputs are cloned independently', () => {
  const log = new ToolCallReplayLog();
  const buf = Buffer.from('hello');
  log.record({ toolName: 'render', args: { id: 1 }, output: buf });
  buf.write('zzzzz');
  const r = log.replay({ toolName: 'render', args: { id: 1 } });
  assert.equal(r.hit, true);
  assert.equal(r.entry.output.toString(), 'hello');
});

test('replayByKey works with keys produced by buildKey', () => {
  const log = new ToolCallReplayLog();
  const args = { q: 'foo' };
  log.record({ toolName: 'search', args, output: ['a'] });
  const key = buildKey({ toolName: 'search', args });
  const r = log.replayByKey(key);
  assert.equal(r.hit, true);
  assert.deepEqual(r.entry.output, ['a']);
});

test('createReplayLog factory yields independent instances; getReplayLog returns singleton', () => {
  _resetForTests();
  const a = createReplayLog();
  const b = createReplayLog();
  assert.notEqual(a, b);
  a.record({ toolName: 't', args: {}, output: 1 });
  assert.equal(b.size(), 0);

  const s1 = getReplayLog();
  const s2 = getReplayLog();
  assert.equal(s1, s2);
  _resetForTests();
});

test('scope isolates equivalent tool/args pairs', () => {
  const log = new ToolCallReplayLog();
  log.record({ toolName: 't', args: { x: 1 }, output: 'a', scope: 'task-1' });
  log.record({ toolName: 't', args: { x: 1 }, output: 'b', scope: 'task-2' });
  assert.equal(log.replay({ toolName: 't', args: { x: 1 }, scope: 'task-1' }).entry.output, 'a');
  assert.equal(log.replay({ toolName: 't', args: { x: 1 }, scope: 'task-2' }).entry.output, 'b');
  assert.equal(log.replay({ toolName: 't', args: { x: 1 } }).hit, false);
});

test('meta is shallow-cloned and isolated from caller', () => {
  const log = new ToolCallReplayLog();
  const meta = { traceId: 'abc' };
  log.record({ toolName: 't', args: {}, output: 1, meta });
  meta.traceId = 'mutated';
  const r = log.replay({ toolName: 't', args: {} });
  assert.equal(r.entry.meta.traceId, 'abc');
});
