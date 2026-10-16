'use strict';

// Durable "post this transcript when it's done" requests. A long media
// transcription outlives the chat turn that asked for it (deploys reap that
// turn after ~2 min), so the turn leaves one of these records behind and the
// media worker delivers into the chat when every file is terminal.
//
// Layout under <UPLOAD_DIR>/.transcription-deliveries/ (persistent volume;
// dot-directories are never served by the /uploads static handler):
//   md_<uuid>.json        active record (pending | delivering)
//   md_<uuid>.lock        claim lock, opened with 'wx' (one holder at a time)
//   done/md_<uuid>.json   terminal record (delivered | failed), kept 30 days
// Every write is tmp + rename, so a crash never leaves half a record. The
// pending scan reads only the active directory, which holds the few
// deliveries still waiting, never the 30-day history.
//
// Two kinds of delivery (contract C6). 'transcript' (the default, and what
// every record written before kinds existed reads as) posts a file's
// transcript once the file is terminal. 'refine' («revisa el minuto 12, se
// escuchó mal») posts ONE file's corrected window: the file is already
// ready, so it waits for the refine job's outcome (`refine`, written by
// noteRefineOutcome when the media worker reports it), not for the file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DELIVERY_ID_RE = /^md_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_FILE_RE = /^(md_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const MODES = Object.freeze(['transcript', 'analysis', 'subtitles', 'document', 'translation']);
const KINDS = Object.freeze(['transcript', 'refine']);
const REFINE_STATUSES = Object.freeze(['ok', 'failed']);
// A refine window is at most a week of recording clock, like a clip offset.
const MAX_REFINE_END_SEC = 7 * 24 * 3600;
const FORMATS = Object.freeze(['txt', 'srt', 'vtt', 'docx', 'pdf']);
const STATUSES = Object.freeze(['pending', 'delivering', 'delivered', 'failed']);
const MAX_FILES = 50;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const MIN_STALE_MS = 30 * 1000;
// Delay before attempt n+1 after attempt n failed (index n-1). With the
// default 5 attempts the 120-min step is only reached if maxAttempts is raised.
const RETRY_BACKOFF_MS = Object.freeze([1, 5, 15, 60, 120].map(minutes => minutes * 60 * 1000));
const MAX_ATTEMPTS = 5;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_TMP_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SCAN = 1000;

class MediaDeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MediaDeliveryError';
    this.code = code;
  }
}

function isValidDeliveryId(id) {
  return typeof id === 'string' && DELIVERY_ID_RE.test(id);
}

/** Every path is built from a validated id: no traversal, no other files. */
function assertDeliveryId(id) {
  if (!isValidDeliveryId(id)) throw new MediaDeliveryError('invalid_delivery_id', 'Identificador de entrega no válido.');
  return id;
}

function newDeliveryId() {
  return `md_${crypto.randomUUID()}`;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function staleMsFrom(env = process.env) {
  return Math.max(MIN_STALE_MS, positiveInt(env.SIRAGPT_MEDIA_DELIVERY_STALE_MS, DEFAULT_STALE_MS));
}

function deliveryRoot(env = process.env) {
  return path.join(path.resolve(env.UPLOAD_DIR || 'uploads'), '.transcription-deliveries');
}

function clipString(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function safeError(error) {
  const raw = typeof error === 'string' ? error : (error?.code ? `${error.code}: ${error.message || ''}` : error?.message);
  return String(raw || 'error').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || 'error';
}

function normalizeRange(range) {
  if (!range || typeof range !== 'object') return null;
  const start = Number(range.start);
  const end = range.end == null ? null : Number(range.end);
  if (!Number.isFinite(start) || start < 0) return null;
  if (end != null && (!Number.isFinite(end) || end <= start)) return null;
  return { start, end };
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const id = clipString(model.id, 200);
  if (!id) return null;
  return { id, provider: clipString(model.provider, 80) };
}

/**
 * What the user asked the deliverables to look like (document, subtitles,
 * clip clock). In mode 'translation', `includeTranscript` keeps the
 * transcript files next to the translation («transcribe y tradúcelo») and
 * `alsoAnalysis` adds the requested summary («resume y tradúcelo»).
 */
function normalizeOutput(output) {
  const value = output && typeof output === 'object' ? output : {};
  const documentFormat = value.documentFormat === 'docx' || value.documentFormat === 'pdf' ? value.documentFormat : null;
  const offset = Number(value.timeOffsetSec);
  return {
    documentFormat,
    wantsSubtitles: value.wantsSubtitles === true,
    timeOffsetSec: Number.isFinite(offset) && offset > 0 ? Math.min(offset, 7 * 24 * 3600) : 0,
    includeTranscript: value.includeTranscript === true,
    alsoAnalysis: value.alsoAnalysis === true,
  };
}

/** Where a link clip came from (shown in the delivered message). */
function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  const url = clipString(source.url, 2000);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, host: clipString(source.host, 200), title: clipString(source.title, 300) };
}

function normalizeLanguage(value) {
  const text = clipString(value, 16);
  return text && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(text) ? text : null;
}

/**
 * What the user said about the recording («los nombres son Huamán,
 * Ayacucho», «son 3 hablantes», «literal») → { terms?, speakers?, verbatim? }
 * bounded by the formatter's normalizer, or null.
 */
function normalizeHints(hints) {
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return null;
  try {
    return require('./media-transcript-format').normalizeMediaHints(hints) || null;
  } catch (_) {
    return null;
  }
}

/** A refine window on the recording clock: a finite start and a finite end after it. */
function normalizeRefineRange(range) {
  const value = normalizeRange(range);
  if (!value || value.end == null || value.end > MAX_REFINE_END_SEC) return null;
  return value;
}

/**
 * The refine job's outcome as the media worker reported it:
 * { status: 'ok' | 'failed', unchanged, code, at } or null.
 */
function normalizeRefineOutcome(outcome, nowMs = Date.now()) {
  if (!outcome || typeof outcome !== 'object') return null;
  let status = REFINE_STATUSES.includes(outcome.status) ? outcome.status : null;
  if (!status && typeof outcome.ok === 'boolean') status = outcome.ok ? 'ok' : 'failed';
  if (!status) return null;
  const code = typeof outcome.code === 'string' ? outcome.code.replace(/[^\w.-]+/g, '_').slice(0, 40) || null : null;
  return { status, unchanged: status === 'ok' && outcome.unchanged === true, code: status === 'failed' ? code : null, at: isoAt(nowMs) };
}

/**
 * Validated, bounded record for a new delivery. Unknown modes/formats fall
 * back to the plain transcript; TXT is always delivered.
 */
function normalizeNewRecord(input = {}, nowMs = Date.now()) {
  const userId = clipString(input.userId, 200);
  if (!userId) throw new MediaDeliveryError('invalid_record', 'La entrega necesita un usuario.');
  const fileIds = [...new Set((Array.isArray(input.fileIds) ? input.fileIds : [])
    .filter(id => typeof id === 'string' && id.trim() && id.length <= 200).map(id => id.trim()))];
  if (!fileIds.length) throw new MediaDeliveryError('invalid_record', 'La entrega necesita al menos un archivo.');
  if (fileIds.length > MAX_FILES) throw new MediaDeliveryError('invalid_record', `Una entrega admite hasta ${MAX_FILES} archivos.`);
  const names = Array.isArray(input.fileNames) ? input.fileNames : [];
  const formats = [...new Set(['txt', ...(Array.isArray(input.formats) ? input.formats : [])
    .map(format => String(format || '').trim().toLowerCase()).filter(format => FORMATS.includes(format))])];
  const at = isoAt(nowMs);
  const kind = KINDS.includes(input.kind) ? input.kind : 'transcript';
  // A refine corrects one window of one file: both are required.
  const refineRange = kind === 'refine' ? normalizeRefineRange(input.range) : null;
  if (kind === 'refine' && fileIds.length !== 1) throw new MediaDeliveryError('invalid_record', 'Una corrección es de un solo archivo.');
  if (kind === 'refine' && !refineRange) throw new MediaDeliveryError('invalid_record', 'Una corrección necesita un tramo con inicio y fin.');
  return {
    id: newDeliveryId(),
    userId,
    chatId: clipString(input.chatId, 200),
    taskId: clipString(input.taskId, 200),
    assistantMessageId: clipString(input.assistantMessageId, 200),
    fileIds,
    fileNames: fileIds.map((_, index) => clipString(names[index], 255)),
    goal: typeof input.goal === 'string' ? input.goal.slice(0, 4000) : '',
    kind,
    // A refine posts the corrected window, never an analysis or a translation.
    mode: kind === 'refine' ? 'transcript' : (MODES.includes(input.mode) ? input.mode : 'transcript'),
    formats,
    range: kind === 'refine' ? refineRange : normalizeRange(input.range),
    language: normalizeLanguage(input.language),
    hints: normalizeHints(input.hints),
    refine: null,
    model: normalizeModel(input.model),
    output: normalizeOutput(input.output),
    source: normalizeSource(input.source),
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: at,
    updatedAt: at,
    deliveryChatId: null,
    deliveredMessageId: null,
  };
}

function createMediaDeliveryStore({
  root = null,
  env = process.env,
  now = () => Date.now(),
  staleMs = null,
  maxScan = DEFAULT_MAX_SCAN,
  fsp = fs.promises,
  pid = process.pid,
  host = os.hostname(),
} = {}) {
  const baseDir = path.resolve(root || deliveryRoot(env));
  const doneDir = path.join(baseDir, 'done');
  const lockStaleMs = Math.max(1, Number(staleMs) || staleMsFrom(env));
  const scanCap = Math.max(1, Number(maxScan) || DEFAULT_MAX_SCAN);

  const activePath = id => path.join(baseDir, `${assertDeliveryId(id)}.json`);
  const donePath = id => path.join(doneDir, `${assertDeliveryId(id)}.json`);
  const lockPath = id => path.join(baseDir, `${assertDeliveryId(id)}.lock`);

  async function writeAtomic(target, value) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value));
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async function readJson(file) {
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function readRecord(file, id) {
    const record = await readJson(file);
    // A record whose body disagrees with its file name is not trusted.
    return record && typeof record === 'object' && record.id === id ? record : null;
  }

  const exists = file => fsp.stat(file).then(() => true, () => false);

  async function readLock(id) {
    const info = await readJson(lockPath(id)).catch(() => null);
    return info && typeof info === 'object' ? info : null;
  }

  async function holds(id, token) {
    if (!token) return false;
    const info = await readLock(id);
    return Boolean(info && info.token === token);
  }

  async function removeLockIfOwned(id, token) {
    if (!(await holds(id, token))) return false;
    await fsp.unlink(lockPath(id)).catch(() => {});
    return true;
  }

  async function touchLock(id) {
    const at = now() / 1000;
    await fsp.utimes(lockPath(id), at, at);
  }

  /**
   * Remove a lock only when it is older than the stale window. The rename is
   * atomic, and the renamed file must be the very file that was judged stale
   * (same inode and mtime, plus the same token when it has one): if another
   * process reaped it and took a fresh lock in between — even before our
   * token read — or the holder refreshed it, the lock is put back.
   */
  async function reapStaleLock(id) {
    const file = lockPath(id);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return true;
    if (now() - stat.mtimeMs < lockStaleMs) return false;
    const judged = await readLock(id);
    const reapPath = `${file}.reap-${crypto.randomUUID()}`;
    try {
      await fsp.rename(file, reapPath);
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
    const reaped = await readJson(reapPath).catch(() => null);
    const reapedStat = await fsp.stat(reapPath).catch(() => null);
    // mtime as well as ino: a replacement lock may reuse the inode number.
    const sameFile = Boolean(reapedStat && reapedStat.ino === stat.ino && reapedStat.dev === stat.dev
      && Math.abs(reapedStat.mtimeMs - stat.mtimeMs) < 1);
    const sameLock = sameFile && (!judged?.token || reaped?.token === judged.token);
    if (!sameLock) {
      // Never clobber: link fails if someone already holds the lock again.
      await fsp.link(reapPath, file).catch(() => {});
      await fsp.unlink(reapPath).catch(() => {});
      return false;
    }
    await fsp.unlink(reapPath).catch(() => {});
    return true;
  }

  async function acquireLock(id, token) {
    await fsp.mkdir(baseDir, { recursive: true });
    const file = lockPath(id);
    const payload = JSON.stringify({ token, pid, host, at: isoAt(now()) });
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try {
        handle = await fsp.open(file, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (attempt > 0 || !(await reapStaleLock(id))) return false;
        continue;
      }
      try { await handle.writeFile(payload); } finally { await handle.close(); }
      await touchLock(id).catch(() => {});
      return true;
    }
    return false;
  }

  async function readActive(id) {
    const record = await readRecord(activePath(id), id);
    if (!record) return null;
    // A crash between "write done/" and "unlink active" leaves both copies;
    // the terminal copy wins and the active leftover is dropped.
    if (await exists(donePath(id))) {
      await fsp.unlink(activePath(id)).catch(() => {});
      return null;
    }
    return record;
  }

  async function create(input) {
    const record = normalizeNewRecord(input, now());
    await writeAtomic(activePath(record.id), record);
    return record;
  }

  async function get(id) {
    assertDeliveryId(id);
    return (await readRecord(donePath(id), id)) || readActive(id);
  }

  async function listActive({ limit = scanCap } = {}) {
    const names = await fsp.readdir(baseDir).catch(err => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const cap = Math.max(1, Math.min(scanCap, Number(limit) || scanCap));
    const ids = names.map(name => RECORD_FILE_RE.exec(name)?.[1]).filter(Boolean).sort().slice(0, cap);
    const records = [];
    for (const id of ids) {
      const record = await readActive(id).catch(() => null);
      if (record && (record.status === 'pending' || record.status === 'delivering')) records.push(record);
    }
    return records;
  }

  async function findPendingByFile(fileId, { userId = null, limit } = {}) {
    if (typeof fileId !== 'string' || !fileId) return [];
    const records = await listActive({ limit });
    return records.filter(record => Array.isArray(record.fileIds) && record.fileIds.includes(fileId)
      && (!userId || record.userId === userId));
  }

  /**
   * Take the delivery for this process. Returns { token, record } or null
   * when another holder is live, the record is gone, or it is terminal.
   */
  async function claim(id) {
    assertDeliveryId(id);
    const before = await readActive(id);
    if (!before || (before.status !== 'pending' && before.status !== 'delivering')) return null;
    const token = crypto.randomUUID();
    if (!(await acquireLock(id, token))) return null;
    try {
      // Re-read under the lock: a previous holder may have finished between
      // our first read and the lock.
      const fresh = await readActive(id);
      if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'delivering')) {
        await removeLockIfOwned(id, token);
        return null;
      }
      const at = isoAt(now());
      const record = { ...fresh, status: 'delivering', claimedAt: at, updatedAt: at };
      await writeAtomic(activePath(id), record);
      return { token, record };
    } catch (err) {
      await removeLockIfOwned(id, token).catch(() => {});
      throw err;
    }
  }

  /** Keep a long delivery (analysis, big artifacts) from looking stale. */
  async function refresh(id, token) {
    if (!(await holds(id, token))) return false;
    await touchLock(id).catch(() => {});
    return true;
  }

  async function patch(id, token, fields = {}) {
    if (!(await holds(id, token))) return null;
    const record = await readActive(id);
    if (!record) return null;
    const next = { ...record, updatedAt: isoAt(now()) };
    if (Object.prototype.hasOwnProperty.call(fields, 'deliveryChatId')) next.deliveryChatId = clipString(fields.deliveryChatId, 200);
    await writeAtomic(activePath(id), next);
    return next;
  }

  /**
   * Record a refine job's outcome on an active refine record (the media
   * worker reported it). Taken under the claim lock so it never races a
   * holder's read-modify-write; a busy lock is retried briefly, then given
   * up (the delivery's own fallbacks still close the record). The first
   * terminal outcome is kept: a failure never replaces an outcome already
   * recorded — not an «ok» (a duplicate hook), not an earlier failure (a
   * refine that fails reports its real reason, then the worker's generic
   * «refine_failed»). Only a failure followed by an «ok» is upgraded.
   * Returns the updated record, or null when there is nothing to record
   * (not a refine, terminal, gone, busy).
   */
  async function noteRefineOutcome(id, outcome, { tries = 5, waitMs = 150 } = {}) {
    assertDeliveryId(id);
    const value = normalizeRefineOutcome(outcome, now());
    if (!value) return null;
    const keeps = record => value.status === 'failed' && REFINE_STATUSES.includes(record.refine?.status);
    for (let attempt = 0; attempt < Math.max(1, tries); attempt++) {
      const before = await readActive(id);
      if (!before || before.kind !== 'refine' || (before.status !== 'pending' && before.status !== 'delivering')) return null;
      if (keeps(before)) return before;
      const token = crypto.randomUUID();
      if (await acquireLock(id, token)) {
        try {
          const fresh = await readActive(id);
          if (!fresh || fresh.kind !== 'refine' || (fresh.status !== 'pending' && fresh.status !== 'delivering')) return null;
          if (keeps(fresh)) return fresh;
          const next = { ...fresh, refine: value, updatedAt: isoAt(now()) };
          await writeAtomic(activePath(id), next);
          return next;
        } finally {
          await removeLockIfOwned(id, token).catch(() => {});
        }
      }
      if (attempt < tries - 1) await new Promise((resolve) => { setTimeout(resolve, Math.max(0, waitMs)); });
    }
    return null;
  }

  /** Hand the delivery back (files still pending, or shutdown). */
  async function release(id, token) {
    assertDeliveryId(id);
    if (!(await holds(id, token))) return null;
    const record = await readActive(id);
    let next = null;
    if (record) {
      next = { ...record, status: 'pending', updatedAt: isoAt(now()) };
      await writeAtomic(activePath(id), next);
    }
    await removeLockIfOwned(id, token);
    return next;
  }

  /**
   * Terminal success. Idempotent and token-tolerant: once the message is in
   * the chat the record must say so, even if the lock was reclaimed.
   */
  async function markDelivered(id, token, { deliveredMessageId = null, deliveredChatId = null } = {}) {
    assertDeliveryId(id);
    const done = await readRecord(donePath(id), id);
    if (done) {
      await removeLockIfOwned(id, token);
      return done;
    }
    const record = await readActive(id);
    if (!record) return null;
    const at = isoAt(now());
    const next = { ...record, status: 'delivered', deliveredAt: at, updatedAt: at, lastError: null,
      nextAttemptAt: null, deliveredMessageId: clipString(deliveredMessageId, 200),
      deliveryChatId: clipString(deliveredChatId, 200) || record.deliveryChatId || null };
    await writeAtomic(donePath(id), next);
    await fsp.unlink(activePath(id)).catch(() => {});
    await removeLockIfOwned(id, token);
    return next;
  }

  /**
   * Count a failed attempt. Below maxAttempts the record returns to pending
   * with nextAttemptAt set from the backoff table; at maxAttempts it becomes
   * terminal 'failed'. Requires the lock: a reclaimed delivery is handled by
   * its new holder.
   */
  async function markFailed(id, token, error, { maxAttempts = MAX_ATTEMPTS, backoffMs = RETRY_BACKOFF_MS } = {}) {
    assertDeliveryId(id);
    if (!(await holds(id, token))) return null;
    const record = await readActive(id);
    if (!record) {
      await removeLockIfOwned(id, token);
      return null;
    }
    const attempts = (Number(record.attempts) || 0) + 1;
    const nowMs = now();
    const at = isoAt(nowMs);
    const lastError = safeError(error);
    if (attempts >= Math.max(1, Number(maxAttempts) || MAX_ATTEMPTS)) {
      const next = { ...record, status: 'failed', attempts, lastError, nextAttemptAt: null, failedAt: at, updatedAt: at };
      await writeAtomic(donePath(id), next);
      await fsp.unlink(activePath(id)).catch(() => {});
      await removeLockIfOwned(id, token);
      return next;
    }
    const table = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : RETRY_BACKOFF_MS;
    const delay = Math.max(0, Number(table[Math.min(attempts - 1, table.length - 1)]) || 0);
    const next = { ...record, status: 'pending', attempts, lastError, nextAttemptAt: isoAt(nowMs + delay), updatedAt: at };
    await writeAtomic(activePath(id), next);
    await removeLockIfOwned(id, token);
    return next;
  }

  /**
   * Drop delivered/failed records past retention, plus leftovers from
   * crashes (tmp files, reaped locks, locks of records that no longer exist).
   */
  async function sweepOld({ maxAgeMs = RETENTION_MS, now: nowMs = now() } = {}) {
    let removed = 0;
    const doneNames = await fsp.readdir(doneDir).catch(() => []);
    for (const name of doneNames) {
      const full = path.join(doneDir, name);
      const id = RECORD_FILE_RE.exec(name)?.[1];
      if (!id) {
        if (/\.tmp$/.test(name)) {
          const stat = await fsp.stat(full).catch(() => null);
          if (stat && nowMs - stat.mtimeMs > ORPHAN_TMP_MS) await fsp.unlink(full).catch(() => {});
        }
        continue;
      }
      const record = await readRecord(full, id).catch(() => null);
      const stat = record ? null : await fsp.stat(full).catch(() => null);
      const updated = record ? Date.parse(record.updatedAt || record.createdAt || '') : stat?.mtimeMs;
      if (Number.isFinite(updated) && nowMs - updated > maxAgeMs) {
        await fsp.unlink(full).catch(() => {});
        removed++;
      }
    }
    const names = await fsp.readdir(baseDir).catch(() => []);
    for (const name of names) {
      const full = path.join(baseDir, name);
      const lockId = /^(md_[0-9a-f-]{36})\.lock$/.exec(name)?.[1];
      const leftover = /\.tmp$/.test(name) || /\.lock\.reap-[0-9a-f-]{36}$/.test(name);
      if (!leftover && !(lockId && isValidDeliveryId(lockId))) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      if (leftover && nowMs - stat.mtimeMs > ORPHAN_TMP_MS) await fsp.unlink(full).catch(() => {});
      else if (lockId && nowMs - stat.mtimeMs > lockStaleMs && !(await exists(activePath(lockId)))) {
        await fsp.unlink(full).catch(() => {});
      }
    }
    return { removed };
  }

  return {
    root: baseDir,
    doneDir,
    staleMs: lockStaleMs,
    create,
    get,
    listActive,
    findPendingByFile,
    claim,
    holds,
    refresh,
    patch,
    release,
    noteRefineOutcome,
    markDelivered,
    markFailed,
    sweepOld,
  };
}

module.exports = {
  createMediaDeliveryStore,
  normalizeNewRecord,
  normalizeRefineOutcome,
  normalizeRefineRange,
  isValidDeliveryId,
  assertDeliveryId,
  newDeliveryId,
  deliveryRoot,
  staleMsFrom,
  MediaDeliveryError,
  DELIVERY_ID_RE,
  MODES,
  KINDS,
  FORMATS,
  STATUSES,
  MAX_FILES,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  RETENTION_MS,
  DEFAULT_STALE_MS,
};
