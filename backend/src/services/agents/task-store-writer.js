'use strict';

// A single owner serializes each snapshot and the shared index. Buffered writes
// are NOT durable acknowledgements: callers must await flush before ACK/terminal.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const pending = new Map();
const indexCache = new Map();
let tail = Promise.resolve();
let failure = null;

async function atomicWrite(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(payload));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(tmp, file);
    // Persist rename as well as content on filesystems supporting directory sync.
    let dir;
    try { dir = await fs.open(path.dirname(file), 'r'); await dir.sync(); } catch (err) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(err.code)) throw err;
    } finally { await dir?.close(); }
  } finally {
    await handle?.close();
    await fs.unlink(tmp).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}
async function persist(file, snapshot) {
  await atomicWrite(file, snapshot);
  const indexFile = path.join(path.dirname(file), '_index.json');
  let index = indexCache.get(indexFile);
  if (!index) {
    try { index = JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      index = {};
    }
    indexCache.set(indexFile, index);
  }
  index[snapshot.taskId] = { userId: snapshot.userId, status: snapshot.status || 'running',
    chatId: snapshot.chatId || null, jobId: snapshot.jobId || null,
    createdAt: snapshot.createdAt || snapshot.updatedAt, updatedAt: snapshot.updatedAt || snapshot.createdAt };
  await atomicWrite(indexFile, index);
}
const scheduled = new Set();
const inFlight = new Set();
function schedule(file) {
  if (scheduled.has(file)) return;
  scheduled.add(file);
  tail = tail.catch(() => {}).then(async () => {
    const value = pending.get(file);
    pending.delete(file);
    let failed = false;
    inFlight.add(file);
    try { if (value) await persist(file, value); } catch (err) {
      if (!pending.has(file)) pending.set(file, value);
      failure = err; failed = true;
      throw err;
    } finally {
      inFlight.delete(file); scheduled.delete(file);
      if (!failed && pending.has(file)) schedule(file);
    }
  });
  tail.catch(() => {});
}
function enqueue(file, snapshot) {
  // Coalesce only full cumulative states, never individual events. A producer
  // racing the in-flight write leaves its newer snapshot queued behind it.
  pending.set(file, structuredClone(snapshot));
  schedule(file);
}
async function flush() {
  let retried = false;
  for (;;) {
    const observedTail = tail;
    await observedTail.catch(() => {});
    if (scheduled.size || tail !== observedTail) continue;
    if (pending.size) {
      if (retried) throw failure || new Error('task-store writer did not drain');
      retried = true;
      for (const file of pending.keys()) schedule(file);
      continue;
    }
    failure = null;
    return;
  }
}
function invalidateIndex(dir) { indexCache.delete(path.join(dir, '_index.json')); }
function hasPending(file) { return pending.has(file) || inFlight.has(file) || scheduled.has(file); }
function hasPendingDirectory(dir) {
  return [...pending.keys(), ...inFlight, ...scheduled].some(file => path.dirname(file) === dir);
}
module.exports = { enqueue, flush, invalidateIndex, hasPending, hasPendingDirectory, atomicWrite };
