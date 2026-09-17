import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeAndAcknowledge } from '../src/modules/doc-sandbox/queue/acknowledged-deletion';

// Native temporary-file deletion plus append-only acknowledgment files; no
// simulated DB/storage clients. This tests batch sequencing and compensation
// bookkeeping only, not durable PostgreSQL/S3 cleanup or provider deletion.
async function fixture(size: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'doc-acknowledged-deletion-'));
  const keys = Array.from({ length: size }, (_, index) => `original-${index}`);
  const journal = path.join(root, 'journal.ndjson');
  await Promise.all(keys.map(key => writeFile(path.join(root, key), key, { flag: 'wx' })));
  const remove = async (key: string): Promise<void> => { await unlink(path.join(root, key)); };
  const acknowledge = async (batch: string[]): Promise<void> => {
    // An acknowledgement cannot precede any deletion in the batch.
    for (const key of batch) await assert.rejects(lstat(path.join(root, key)), { code: 'ENOENT' });
    await appendFile(journal, JSON.stringify(batch) + '\n');
  };
  const recorded = async (): Promise<string[][]> => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, keys, journal, remove, acknowledge, recorded,
    close: async () => { await rm(root, { force: true, recursive: true }); } };
}

test('native deletes are acknowledged in exact ordered batches of 100 with a final remainder', async () => {
  const f = await fixture(205);
  try {
    await removeAndAcknowledge(f.keys, new AbortController().signal, f.remove, f.acknowledge);
    const batches = await f.recorded();
    assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
    assert.deepEqual(batches.flat(), f.keys);
  } finally { await f.close(); }
});

test('an exact full batch is acknowledged once, with no empty final journal entry', async () => {
  const f = await fixture(100);
  try {
    await removeAndAcknowledge(f.keys, new AbortController().signal, f.remove, f.acknowledge);
    assert.deepEqual(await f.recorded(), [f.keys]);
  } finally { await f.close(); }
});

test('empty work and an already cancelled attempt never write a spurious acknowledgment', async () => {
  const f = await fixture(1);
  try {
    await removeAndAcknowledge([], AbortSignal.abort(), f.remove, f.acknowledge);
    await assert.rejects(removeAndAcknowledge(f.keys, AbortSignal.abort(), f.remove, f.acknowledge), { name: 'AbortError' });
    await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.root, f.keys[0]!), 'utf8'), f.keys[0]);
  } finally { await f.close(); }
});

test('native deletion failure flushes only confirmed preceding keys and preserves later objects', async () => {
  const f = await fixture(3);
  try {
    const ordered = [f.keys[0]!, 'missing-file', ...f.keys.slice(1)];
    await assert.rejects(removeAndAcknowledge(ordered, new AbortController().signal, f.remove, f.acknowledge), { code: 'ENOENT' });
    assert.deepEqual(await f.recorded(), [[f.keys[0]]]);
    for (const key of f.keys.slice(1)) assert.equal(await readFile(path.join(f.root, key), 'utf8'), key);
  } finally { await f.close(); }
});

test('cancellation after native removal still flushes that confirmation before stopping the next deletion', async () => {
  const f = await fixture(3);
  const controller = new AbortController();
  try {
    await assert.rejects(removeAndAcknowledge(f.keys, controller.signal, async key => {
      await f.remove(key);
      controller.abort();
    }, f.acknowledge), { name: 'AbortError' });
    assert.deepEqual(await f.recorded(), [[f.keys[0]]]);
    for (const key of f.keys.slice(1)) assert.equal(await readFile(path.join(f.root, key), 'utf8'), key);
  } finally { await f.close(); }
});

test('failed full-batch acknowledgement remains buffered and is retried by finally, without touching the next key', async () => {
  const f = await fixture(101);
  const missingDirectory = path.join(f.root, 'not-created');
  const attempts = path.join(f.root, 'journal-attempts.ndjson');
  try {
    await assert.rejects(removeAndAcknowledge(f.keys, new AbortController().signal, f.remove, async batch => {
      await appendFile(attempts, JSON.stringify(batch) + '\n');
      await appendFile(path.join(missingDirectory, 'ack.ndjson'), JSON.stringify(batch) + '\n');
    }), { code: 'ENOENT' });
    const batches = (await readFile(attempts, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(batches, [f.keys.slice(0, 100), f.keys.slice(0, 100)]);
    assert.equal(await readFile(path.join(f.root, f.keys[100]!), 'utf8'), f.keys[100]);
    await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('finally acknowledgment failure keeps the original error precedence after a native deletion failure', async () => {
  const f = await fixture(1);
  const invalidJournal = path.join(f.root, 'directory-not-a-file');
  try {
    await mkdir(invalidJournal);
    await assert.rejects(removeAndAcknowledge([...f.keys, 'missing-file'], new AbortController().signal,
      f.remove, async batch => { await appendFile(invalidJournal, JSON.stringify(batch)); }), { code: 'EISDIR' });
    await assert.rejects(lstat(path.join(f.root, f.keys[0]!)), { code: 'ENOENT' });
    await assert.rejects(lstat(f.journal), { code: 'ENOENT' });
  } finally { await f.close(); }
});
