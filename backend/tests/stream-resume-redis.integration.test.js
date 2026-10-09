'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const resume = require('../src/services/ai/stream-resume');
const url = process.env.REDIS_URL;
const skip = !url && 'Requires the isolated CI Redis service';

test('real Redis Lua appends bounded frames, migrates V1 once and reads replay atomically', { skip }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Only isolated loopback test Redis');
  const Redis = require('ioredis'); const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  const id = `ci-resume-${crypto.randomUUID()}`; const freshId = `${id}-fresh`;
  try {
    resume._resetForTests(); resume._setInjectedRedis(redis);
    await resume.open({ streamId: freshId });
    assert.equal(await redis.exists(resume.redisKeys(freshId)[0]), 1, 'empty records persist before any content frame');
    await redis.set(`sira:sse-resume:${id}`, JSON.stringify({ chunks: ['legacy-first'], complete: false }), 'EX', 60);
    assert.deepEqual((await resume.openExisting({ streamId: id })).record.chunks, ['legacy-first']);
    await resume.append(id, 'second');
    const keys = resume.redisKeys(id);
    assert.deepEqual(await redis.lrange(keys[1], 0, -1), ['legacy-first', 'second']);
    const frame = 'é'.repeat(128 * 1024);
    for (let i = 0; i < 18; i++) await resume.append(id, frame);
    assert.equal(await redis.llen(keys[1]), 16);
    assert.equal(Number(await redis.hget(keys[0], 'bytes')), resume.DEFAULT_MAX_BYTES);
    await resume.touch(id, { ttlSeconds: 37 });
    assert.ok((await redis.ttl(keys[0])) > 30);
    assert.ok((await redis.ttl(keys[1])) > 30);
    await resume.complete(id);
    resume._resetForTests(); resume._setInjectedRedis(redis); //Replica replacement: no local memory.
    const record = (await resume.openExisting({ streamId: id })).record;
    assert.equal(record.complete, true); assert.equal(record.nextPosition, 20); assert.equal(record.basePosition, 4);
    assert.equal(resume.replayAfter(record, 3).resyncRequired, true);
    assert.deepEqual(resume.replayAfter(record, 19).chunks, [frame]);
    assert.equal(await resume.append(id, 'late'), 20);
  } finally {
    await redis.del(`sira:sse-resume:${id}`, ...resume.redisKeys(id), ...resume.redisKeys(freshId));
    resume._resetForTests(); await redis.quit();
  }
});
