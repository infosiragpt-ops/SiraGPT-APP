'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-redis');
const { extractRedis, buildRedisForFiles, renderRedisBlock, _internal } = engine;
const { classifyOp, isRedisLike } = _internal;

const REDIS_FIXTURE = `import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

async function cacheUser(id, data) {
  await redis.set(\`user:\${id}\`, JSON.stringify(data));
  await redis.expire(\`user:\${id}\`, 3600);
  const cached = await redis.get(\`user:\${id}\`);
  return JSON.parse(cached);
}

async function leaderboard(userId, score) {
  await redis.zadd('leaderboard:global', score, userId);
  const top = await redis.zrevrange('leaderboard:global', 0, 9, 'WITHSCORES');
  return top;
}

async function recordEvent(type, payload) {
  await redis.xadd('events:stream', '*', 'type', type, 'data', JSON.stringify(payload));
  await redis.publish('events:channel', JSON.stringify({ type, payload }));
}

async function counts() {
  const total = await redis.incr('stats:visits');
  await redis.hincrby('stats:by-page', '/home', 1);
  await redis.sadd('online:users', userId);
}

const pipeline = redis.pipeline();
pipeline.set('a', 1);
pipeline.set('b', 2);
await pipeline.exec();

// Pub/Sub
const sub = new Redis();
await sub.subscribe('events:channel');
await sub.psubscribe('events:*');
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractRedis('').total, 0);
  assert.equal(extractRedis(null).total, 0);
});

test('non-Redis text returns empty', () => {
  const r = extractRedis('Just regular code without Redis references');
  assert.equal(r.total, 0);
});

test('classifyOp: string / hash / list / set / zset', () => {
  assert.equal(classifyOp('set'), 'string');
  assert.equal(classifyOp('get'), 'string');
  assert.equal(classifyOp('hset'), 'hash');
  assert.equal(classifyOp('lpush'), 'list');
  assert.equal(classifyOp('sadd'), 'set');
  assert.equal(classifyOp('zadd'), 'zset');
});

test('classifyOp: expiry / pubsub / script / server / stream / pipeline', () => {
  assert.equal(classifyOp('expire'), 'expiry');
  assert.equal(classifyOp('publish'), 'pubsub');
  assert.equal(classifyOp('eval'), 'script');
  assert.equal(classifyOp('keys'), 'server');
  assert.equal(classifyOp('xadd'), 'stream');
  assert.equal(classifyOp('pipeline'), 'pipeline');
  assert.equal(classifyOp('notARealOp'), null);
});

test('isRedisLike heuristic', () => {
  assert.ok(isRedisLike('redis.set(k, v)'));
  assert.ok(isRedisLike('new Redis()'));
  assert.ok(!isRedisLike('plain text'));
});

test('detects string ops (SET / GET)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'string' && e.name === 'SET'));
  assert.ok(r.entries.some((e) => e.kind === 'string' && e.name === 'GET'));
});

test('detects expiry ops (EXPIRE)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'expiry' && e.name === 'EXPIRE'));
});

test('detects sorted set ops (ZADD / ZREVRANGE)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'zset' && e.name === 'ZADD'));
  assert.ok(r.entries.some((e) => e.kind === 'zset' && e.name === 'ZREVRANGE'));
});

test('detects stream ops (XADD)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'stream' && e.name === 'XADD'));
});

test('detects pub/sub (PUBLISH / SUBSCRIBE / PSUBSCRIBE)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'pubsub' && e.name === 'PUBLISH'));
  assert.ok(r.entries.some((e) => e.kind === 'pubsub' && e.name === 'SUBSCRIBE'));
  assert.ok(r.entries.some((e) => e.kind === 'pubsub' && e.name === 'PSUBSCRIBE'));
});

test('detects counter ops (INCR / HINCRBY)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'INCR'));
  assert.ok(r.entries.some((e) => e.name === 'HINCRBY'));
});

test('detects set ops (SADD)', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'set' && e.name === 'SADD'));
});

test('detects pipeline / exec', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'pipeline' && e.name === 'PIPELINE'));
  assert.ok(r.entries.some((e) => e.kind === 'pipeline' && e.name === 'EXEC'));
});

test('detects pub/sub channel names', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'channel' && /events:channel/.test(e.name)));
});

test('dedupes identical commands', () => {
  const r = extractRedis('redis.set(a, 1); redis.set(b, 2);');
  assert.equal(r.entries.filter((e) => e.kind === 'string' && e.name === 'SET').length, 1);
});

test('caps entries per file', () => {
  let text = 'new Redis(); ';
  for (let i = 0; i < 30; i++) text += `redis.publish("chan${i}", x); `;
  const r = extractRedis(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by category', () => {
  const r = extractRedis(REDIS_FIXTURE);
  assert.ok(r.totals.string >= 2);
  assert.ok(r.totals.pubsub >= 2);
});

test('buildRedisForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'new Redis(); redis.set(a, 1);' },
    { name: 'b.ts', extractedText: 'new Redis(); redis.hset("h", "f", "v");' },
  ];
  const r = buildRedisForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRedisBlock returns markdown when entries exist', () => {
  const files = [{ name: 'cache.ts', extractedText: REDIS_FIXTURE }];
  const r = buildRedisForFiles(files);
  const md = renderRedisBlock(r);
  assert.match(md, /^## REDIS/);
});

test('renderRedisBlock empty when nothing surfaces', () => {
  assert.equal(renderRedisBlock({ perFile: [] }), '');
  assert.equal(renderRedisBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRedisForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: REDIS_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
