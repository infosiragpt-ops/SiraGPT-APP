'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createMediaDeliveryStore, normalizeNewRecord, isValidDeliveryId, assertDeliveryId, deliveryRoot, staleMsFrom,
  RETRY_BACKOFF_MS, MAX_ATTEMPTS, DEFAULT_STALE_MS,
} = require('../src/services/media-delivery-store');

const T0 = Date.parse('2026-10-15T10:00:00Z');
const MIN = 60 * 1000;

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-delivery-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: ms => { state.t += ms; }, set: ms => { state.t = ms; } };
}

function input(extra = {}) {
  return { userId: 'u1', chatId: 'chat1', taskId: 'task1', fileIds: ['f1'], fileNames: ['clase.mp4'],
    goal: 'transcribe este video', mode: 'transcript', formats: ['srt'], ...extra };
}

test('create normalizes the record and writes it atomically', async (t) => {
  const root = await tempRoot(t);
  const c = clock();
  const store = createMediaDeliveryStore({ root, now: c.now });
  const record = await store.create(input({
    mode: 'bogus', formats: ['SRT', 'exe', 'srt'], language: 'es', range: { start: 90, end: 600 },
    model: { id: 'deepseek-v4-pro', provider: 'DeepSeek' }, id: 'md_attacker', status: 'delivered',
  }));
  assert.ok(isValidDeliveryId(record.id));
  assert.notEqual(record.id, 'md_attacker');
  assert.equal(record.status, 'pending');
  assert.equal(record.mode, 'transcript');
  assert.deepEqual(record.formats, ['txt', 'srt']);
  assert.deepEqual(record.range, { start: 90, end: 600 });
  assert.deepEqual(record.model, { id: 'deepseek-v4-pro', provider: 'DeepSeek' });
  assert.equal(record.language, 'es');
  assert.equal(record.attempts, 0);
  assert.equal(record.createdAt, new Date(T0).toISOString());
  const files = await fs.readdir(root);
  assert.deepEqual(files, [`${record.id}.json`], 'no tmp file left behind');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, files[0]), 'utf8')), record);
  assert.deepEqual(await store.get(record.id), record);
});

test('invalid records are rejected', () => {
  assert.throws(() => normalizeNewRecord({ fileIds: ['f1'] }), { code: 'invalid_record' });
  assert.throws(() => normalizeNewRecord({ userId: 'u1', fileIds: [] }), { code: 'invalid_record' });
  assert.throws(() => normalizeNewRecord({ userId: 'u1', fileIds: Array.from({ length: 51 }, (_, i) => `f${i}`) }), { code: 'invalid_record' });
  const record = normalizeNewRecord({ userId: 'u1', fileIds: ['f1', 'f1', '', 42, 'f2'], range: { start: 10, end: 5 }, language: '../x' });
  assert.deepEqual(record.fileIds, ['f1', 'f2']);
  assert.equal(record.range, null);
  assert.equal(record.language, null);
  assert.deepEqual(record.formats, ['txt']);
});

test('path traversal: every entry point rejects ids that are not md_<uuid>', async (t) => {
  const root = await tempRoot(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
  t.after(() => fs.rm(outside, { force: true }));
  const store = createMediaDeliveryStore({ root });
  const bad = ['../../etc/passwd', `../${path.basename(outside, '.json')}`, 'md_../../x', 'md_ABCDEF00-0000-0000-0000-000000000000',
    'md_00000000-0000-0000-0000-000000000000/../x', '', null, undefined, 42, { id: 'md_x' }];
  for (const id of bad) {
    assert.equal(isValidDeliveryId(id), false, String(id));
    assert.throws(() => assertDeliveryId(id), { code: 'invalid_delivery_id' });
    await assert.rejects(store.get(id), { code: 'invalid_delivery_id' });
    await assert.rejects(store.claim(id), { code: 'invalid_delivery_id' });
    await assert.rejects(store.release(id, 'tok'), { code: 'invalid_delivery_id' });
    await assert.rejects(store.markDelivered(id, 'tok'), { code: 'invalid_delivery_id' });
    await assert.rejects(store.markFailed(id, 'tok', new Error('x')), { code: 'invalid_delivery_id' });
  }
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' });
  // A record whose body claims another id is not trusted, and non-record
  // files in the directory are never listed.
  const legit = await store.create(input());
  const forgedId = 'md_11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(root, `${forgedId}.json`), JSON.stringify({ ...legit, id: legit.id }));
  await fs.writeFile(path.join(root, 'notes.json'), JSON.stringify({ ...legit, id: 'notes' }));
  assert.equal(await store.get(forgedId), null);
  assert.deepEqual((await store.listActive()).map(record => record.id), [legit.id]);
});

test('concurrent claims: exactly one wins, across store instances', async (t) => {
  const root = await tempRoot(t);
  const a = createMediaDeliveryStore({ root });
  const b = createMediaDeliveryStore({ root });
  const record = await a.create(input());
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).claim(record.id)));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].record.status, 'delivering');
  assert.equal((await a.get(record.id)).status, 'delivering');
  assert.equal(await b.claim(record.id), null, 'a live lock is respected');
  const lock = JSON.parse(await fs.readFile(path.join(root, `${record.id}.lock`), 'utf8'));
  assert.equal(lock.token, winners[0].token);
  assert.equal(lock.pid, process.pid);
  assert.ok(lock.at);
});

test('stale lock older than the window is reclaimable; the old holder loses it', async (t) => {
  const root = await tempRoot(t);
  const c = clock(Date.now());
  const a = createMediaDeliveryStore({ root, now: c.now });
  const b = createMediaDeliveryStore({ root, now: c.now });
  assert.equal(a.staleMs, DEFAULT_STALE_MS);
  const record = await a.create(input());
  const first = await a.claim(record.id);
  assert.ok(first);
  c.advance(14 * MIN);
  assert.equal(await b.claim(record.id), null, 'not stale yet');
  c.advance(2 * MIN);
  const second = await b.claim(record.id);
  assert.ok(second, 'reclaimed after 15 min');
  assert.notEqual(second.token, first.token);
  assert.equal(await a.refresh(record.id, first.token), false);
  assert.equal(await a.markFailed(record.id, first.token, new Error('late')), null, 'lost lock cannot count a failure');
  assert.equal(await a.release(record.id, first.token), null);
  assert.equal((await b.get(record.id)).status, 'delivering');
  assert.equal(await b.holds(record.id, second.token), true);
  const leftovers = (await fs.readdir(root)).filter(name => name.includes('.reap-'));
  assert.deepEqual(leftovers, []);
});

test('refresh keeps a long delivery from being reclaimed', async (t) => {
  const root = await tempRoot(t);
  const c = clock(Date.now());
  const a = createMediaDeliveryStore({ root, now: c.now });
  const record = await a.create(input());
  const claim = await a.claim(record.id);
  c.advance(10 * MIN);
  assert.equal(await a.refresh(record.id, claim.token), true);
  c.advance(10 * MIN);
  assert.equal(await createMediaDeliveryStore({ root, now: c.now }).claim(record.id), null);
  c.advance(6 * MIN);
  assert.ok(await createMediaDeliveryStore({ root, now: c.now }).claim(record.id));
});

test('SIRAGPT_MEDIA_DELIVERY_STALE_MS tunes the stale window (min 30 s)', async (t) => {
  assert.equal(staleMsFrom({}), DEFAULT_STALE_MS);
  assert.equal(staleMsFrom({ SIRAGPT_MEDIA_DELIVERY_STALE_MS: '120000' }), 120000);
  assert.equal(staleMsFrom({ SIRAGPT_MEDIA_DELIVERY_STALE_MS: '5' }), 30000);
  assert.equal(staleMsFrom({ SIRAGPT_MEDIA_DELIVERY_STALE_MS: 'nope' }), DEFAULT_STALE_MS);
  assert.equal(deliveryRoot({ UPLOAD_DIR: '/data/uploads' }), path.join('/data/uploads', '.transcription-deliveries'));
  const root = await tempRoot(t);
  const c = clock(Date.now());
  const env = { SIRAGPT_MEDIA_DELIVERY_STALE_MS: '60000' };
  const a = createMediaDeliveryStore({ root, env, now: c.now });
  const record = await a.create(input());
  assert.ok(await a.claim(record.id));
  c.advance(61 * 1000);
  assert.ok(await createMediaDeliveryStore({ root, env, now: c.now }).claim(record.id));
});

test('release hands the record back as pending and removes the lock', async (t) => {
  const root = await tempRoot(t);
  const store = createMediaDeliveryStore({ root });
  const record = await store.create(input());
  const claim = await store.claim(record.id);
  const released = await store.release(record.id, claim.token);
  assert.equal(released.status, 'pending');
  assert.equal(released.attempts, 0);
  await assert.rejects(fs.stat(path.join(root, `${record.id}.lock`)), { code: 'ENOENT' });
  assert.equal(await store.release(record.id, 'not-the-token'), null);
  assert.ok(await store.claim(record.id));
});

test('markFailed backs off 1/5/15/60 min and turns terminal at the 5th attempt', async (t) => {
  const root = await tempRoot(t);
  const c = clock();
  const store = createMediaDeliveryStore({ root, now: c.now });
  const record = await store.create(input());
  assert.equal(MAX_ATTEMPTS, 5);
  const expected = [1, 5, 15, 60];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const claim = await store.claim(record.id);
    const next = await store.markFailed(record.id, claim.token, Object.assign(new Error('provider down\nstack'), { code: 'post_failed' }));
    assert.equal(next.status, 'pending');
    assert.equal(next.attempts, attempt);
    assert.equal(next.lastError, 'post_failed: provider down stack');
    assert.equal(Date.parse(next.nextAttemptAt) - c.now(), expected[attempt - 1] * MIN);
    assert.equal(RETRY_BACKOFF_MS[attempt - 1], expected[attempt - 1] * MIN);
    await assert.rejects(fs.stat(path.join(root, `${record.id}.lock`)), { code: 'ENOENT' });
    c.advance(expected[attempt - 1] * MIN);
  }
  const claim = await store.claim(record.id);
  const terminal = await store.markFailed(record.id, claim.token, 'still down');
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.attempts, 5);
  assert.equal(terminal.nextAttemptAt, null);
  assert.deepEqual(await store.listActive(), []);
  assert.equal((await store.get(record.id)).status, 'failed');
  assert.equal(await store.claim(record.id), null, 'terminal records are never claimed again');
  assert.deepEqual(await fs.readdir(path.join(root, 'done')), [`${record.id}.json`]);
});

test('markDelivered is terminal, idempotent and leaves the pending scan', async (t) => {
  const root = await tempRoot(t);
  const store = createMediaDeliveryStore({ root });
  const record = await store.create(input());
  const claim = await store.claim(record.id);
  const delivered = await store.markDelivered(record.id, claim.token, { deliveredMessageId: 'msg1', deliveredChatId: 'chat1' });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.deliveredMessageId, 'msg1');
  assert.equal(delivered.deliveryChatId, 'chat1');
  assert.deepEqual(await store.listActive(), []);
  assert.deepEqual(await store.findPendingByFile('f1'), []);
  const again = await store.markDelivered(record.id, 'other', { deliveredMessageId: 'msg2' });
  assert.equal(again.deliveredMessageId, 'msg1');
  assert.deepEqual((await fs.readdir(root)).filter(name => !name.startsWith('done')), []);
});

test('a crash between the done write and the active unlink resolves to the terminal copy', async (t) => {
  const root = await tempRoot(t);
  const store = createMediaDeliveryStore({ root });
  const record = await store.create(input());
  await fs.mkdir(path.join(root, 'done'), { recursive: true });
  await fs.writeFile(path.join(root, 'done', `${record.id}.json`), JSON.stringify({ ...record, status: 'delivered' }));
  assert.equal((await store.get(record.id)).status, 'delivered');
  assert.deepEqual(await store.listActive(), []);
  assert.equal(await store.claim(record.id), null);
  await assert.rejects(fs.stat(path.join(root, `${record.id}.json`)), { code: 'ENOENT' });
});

test('findPendingByFile filters by file and owner', async (t) => {
  const root = await tempRoot(t);
  const store = createMediaDeliveryStore({ root });
  const mine = await store.create(input({ fileIds: ['f1', 'f2'] }));
  const other = await store.create(input({ userId: 'u2', fileIds: ['f1'] }));
  await store.create(input({ fileIds: ['f3'] }));
  assert.deepEqual((await store.findPendingByFile('f2')).map(r => r.id), [mine.id]);
  assert.deepEqual((await store.findPendingByFile('f1', { userId: 'u1' })).map(r => r.id), [mine.id]);
  assert.deepEqual((await store.findPendingByFile('f1')).map(r => r.id).sort(), [mine.id, other.id].sort());
  assert.deepEqual(await store.findPendingByFile(''), []);
  assert.deepEqual(await store.findPendingByFile(null), []);
  const capped = createMediaDeliveryStore({ root, maxScan: 1 });
  assert.equal((await capped.listActive()).length, 1);
  // Missing directory: nothing pending, no throw.
  assert.deepEqual(await createMediaDeliveryStore({ root: path.join(root, 'nope') }).findPendingByFile('f1'), []);
});

test('sweepOld removes terminal records past 30 days and crash leftovers', async (t) => {
  const root = await tempRoot(t);
  const c = clock(Date.now());
  const store = createMediaDeliveryStore({ root, now: c.now });
  const old = await store.create(input());
  const recent = await store.create(input());
  const active = await store.create(input());
  let claim = await store.claim(old.id);
  await store.markDelivered(old.id, claim.token, { deliveredMessageId: 'm1' });
  c.advance(10 * 24 * 60 * MIN);
  claim = await store.claim(recent.id);
  await store.markFailed(recent.id, claim.token, 'x', { maxAttempts: 1 });
  const tmp = path.join(root, `${active.id}.json.123.abc.tmp`);
  await fs.writeFile(tmp, '{');
  const past = (Date.now() - 2 * 60 * MIN) / 1000;
  await fs.utimes(tmp, past, past);
  c.advance(21 * 24 * 60 * MIN);
  const result = await store.sweepOld();
  assert.equal(result.removed, 1);
  assert.equal(await store.get(old.id), null);
  assert.equal((await store.get(recent.id)).status, 'failed');
  assert.equal((await store.get(active.id)).status, 'pending');
  await assert.rejects(fs.stat(tmp), { code: 'ENOENT' });
});
