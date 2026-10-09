'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const resume = require('../src/services/ai/stream-resume');
const noop = { async get() { return null; }, async set() {}, async del() {} };
beforeEach(() => { resume._resetForTests(); resume._setInjectedRedis(noop); });

test('byte trimming preserves absolute cursors and rejects a gap instead of replaying the wrong tail', async () => {
  const { streamId } = await resume.open();
  const frame = 'é'.repeat(128 * 1024); // 256KiB in UTF-8, not128KiB.
  for (let i = 0; i < 18; i++) await resume.append(streamId, frame);
  const record = await resume.load(streamId);
  assert.equal(record.totalBytes, resume.DEFAULT_MAX_BYTES);
  assert.equal(record.nextPosition, 18);
  assert.equal(record.basePosition, 2);
  assert.equal(resume.replayAfter(record, 1).resyncRequired, true);
  const tail = resume.replayAfter(record, 17);
  assert.equal(tail.startPosition, 17);
  assert.deepEqual(tail.chunks, [frame]);
  assert.equal(resume.replayAfter(record, 19).resyncRequired, true);
});

test('count trimming keeps positions beyond the old4000frame cap and terminal mutation retains the tail', async () => {
  const { streamId } = await resume.open();
  await Promise.all(Array.from({ length: 4003 }, (_, i) => resume.append(streamId, String(i))));
  await resume.complete(streamId);
  const record = await resume.load(streamId);
  assert.equal(record.nextPosition, 4003);
  assert.equal(record.basePosition, 3);
  assert.equal(record.complete, true);
  assert.deepEqual(resume.replayAfter(record, 4001).chunks, ['4001', '4002']);
  assert.equal(await resume.append(streamId, 'late'), 4003);
});

test('an oversized frame cannot produce a truncated or renumbered replay', async () => {
  const { streamId } = await resume.open();
  await resume.append(streamId, 'first');
  await resume.append(streamId, 'x'.repeat(resume.DEFAULT_MAX_FRAME_BYTES + 1));
  await resume.append(streamId, 'third');
  const record = await resume.load(streamId);
  assert.equal(record.basePosition, 2);
  assert.equal(record.nextPosition, 3);
  assert.deepEqual(resume.replayAfter(record, 2).chunks, ['third']);
  assert.equal(resume.replayAfter(record, 1).resyncRequired, true);
});

test('V2 Redis appends send only the new frame; touch never serializes the replay history', async () => {
  const calls = [];
  resume._setInjectedRedis({ ...noop, hgetall() {}, lrange() {}, async eval(script, n, ...args) { calls.push({ script, n, args }); return 1; } });
  const { streamId } = await resume.open();
  await resume.append(streamId, 'private-first');
  await resume.append(streamId, 'new-tail');
  await resume.touch(streamId);
  const append = calls.filter(c => c.args[2] === 'append');
  assert.equal(append.length, 2);
  assert.equal(append[1].args[5], 'new-tail');
  assert.ok(!append[1].args.some(value => typeof value === 'string' && value.includes('private-first')));
  const touch = calls.find(c => c.args[2] === 'touch');
  assert.equal(touch.args.length, 4); //2keys, operation, TTL.
  assert.equal(append[1].args[0].split(':')[3], append[1].args[1].split(':')[3]);
});

test('Redis offsets and frames are read atomically, and legacy JSON remains readable', async () => {
  let evals = 0;
  resume._setInjectedRedis({ ...noop, hgetall() { throw new Error('non-atomic read'); }, lrange() { throw new Error('non-atomic read'); },
    async eval() { evals++; return [['base', '7', 'next', '9', 'complete', '1'], ['eight', 'nine']]; } });
  const record = (await resume.openExisting({ streamId: 'remote-v2' })).record;
  assert.equal(evals, 1);
  assert.deepEqual(resume.replayAfter(record, 8).chunks, ['nine']);
  resume._setInjectedRedis({ ...noop, async get() { return JSON.stringify({ chunks: ['old', 'tail'], complete: true }); } });
  assert.deepEqual(resume.replayAfter((await resume.openExisting({ streamId: 'old-v1' })).record, 1).chunks, ['tail']);
});

test('malformed fractional/exponent/unsafe event offsets fail closed', () => {
  for (const cursor of ['id:1.5', 'id:1e3', 'id:+7', 'id:9007199254740992']) assert.equal(resume.parseLastEventId(cursor), null);
});
