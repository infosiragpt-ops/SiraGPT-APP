'use strict';

/**
 * chunked-upload-store — resumable, chunked uploads for large media.
 *
 * Production sits behind a Cloudflare tunnel whose proxy rejects any single
 * request body above 100 MB, so a 300 MB lecture video could never reach the
 * backend in one multipart POST. The composer now splits big files into
 * chunks (default 16 MB) and the backend reassembles them on disk:
 *
 *   init      → creates `<userDir>/.parts/<uploadId>.part` (+ `.json` meta)
 *   chunk N   → written at offset N × chunkSize (retries / out-of-order safe)
 *   status    → which chunks already landed + when the session expires, so
 *               the client resumes after an outage, a deploy or a reload
 *               instead of sending every byte again
 *   complete  → every chunk present + size matches → renamed to the same
 *               `files-<ts>-<rand>.<ext>` layout multer produces, and handed
 *               to the regular processing pipeline as a multer-like object.
 *               Idempotent: the meta stays for an hour with the File id, so a
 *               complete whose first response was lost answers the same row.
 *
 * State lives on disk (meta JSON next to the part file) so a backend restart
 * between chunks does not lose the upload. Sessions untouched for
 * `SIRAGPT_CHUNKED_UPLOAD_STALE_MS` (48 h) are swept on init and by a global,
 * unref'd sweeper over every `<UPLOAD_DIR>/<user>/.parts`. A full disk is a
 * typed 507 (`insufficient_storage`): checked up front with statfs and mapped
 * from ENOSPC on every write.
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { createKeyMutex } = require('../utils/key-mutex');

const MB = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * MB;
const MIN_CHUNK_BYTES = 1 * MB;
const MAX_CHUNK_BYTES = 64 * MB;
const HOUR_MS = 60 * 60 * 1000;
// A 5 h lecture over a slow uplink, a laptop that sleeps overnight or a long
// outage must still find its bytes on the server the next day.
const DEFAULT_STALE_MS = 48 * HOUR_MS;
const MIN_STALE_MS = 10 * 60 * 1000;
const MAX_STALE_MS = 30 * 24 * HOUR_MS;
// How long a finished upload keeps its meta (with the File id) so a repeated
// complete answers the same row instead of a 404.
const COMPLETED_RETENTION_MS = HOUR_MS;
// Free space required before a chunked upload starts: the file plus 10 %.
const FREE_SPACE_FACTOR = 1.1;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const PARTS_DIR = '.parts';
const INSUFFICIENT_STORAGE_MESSAGE = 'No hay espacio suficiente en el servidor para guardar este archivo. Inténtalo más tarde o avisa al administrador.';

/** Stale window for unfinished sessions (env `SIRAGPT_CHUNKED_UPLOAD_STALE_MS`, default 48 h). */
function resolveStaleMs(env = process.env) {
  const raw = Number(env && env.SIRAGPT_CHUNKED_UPLOAD_STALE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALE_MS;
  return Math.min(MAX_STALE_MS, Math.max(MIN_STALE_MS, Math.floor(raw)));
}

// Every operation on one upload (chunk, complete, abort) is a read-modify-write
// of its meta JSON plus the part file. Requests for the same upload can overlap
// (a retried chunk whose first attempt is still running, a client sending chunks
// in parallel, a doubled complete), so they run one at a time per upload. The
// body is already buffered by express.raw before the handler, so this only
// serialises the short disk work. In-process: production runs one node process.
const uploadLocks = createKeyMutex();

function withUploadLock(userDir, uploadId, fn) {
  return uploadLocks.withLock(metaPathFor(userDir, uploadId), fn);
}

class ChunkedUploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ChunkedUploadError';
    this.status = status;
    this.code = code;
  }
}

function notFoundError() {
  return new ChunkedUploadError(404, 'upload_not_found', 'La subida no existe o caducó. Vuelve a adjuntar el archivo.');
}

function isNoSpaceError(err) {
  const code = err && err.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

function insufficientStorageError() {
  return new ChunkedUploadError(507, 'insufficient_storage', INSUFFICIENT_STORAGE_MESSAGE);
}

/** A full disk (or quota) becomes a typed 507; anything else is returned as is. */
function mapStorageError(err) {
  return isNoSpaceError(err) ? insufficientStorageError() : err;
}

async function withStorageErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapStorageError(err);
  }
}

/**
 * Free bytes on the filesystem that holds `dir`, or null when statfs is not
 * available (old runtime, exotic filesystem): the preflight is then skipped
 * and ENOSPC on write stays the safety net.
 */
async function freeBytesAt(dir, statfs = fsPromises.statfs) {
  if (typeof statfs !== 'function') return null;
  try {
    const st = await statfs(dir);
    const free = Number(st && st.bavail) * Number(st && st.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch (_) {
    return null;
  }
}

/**
 * Preflight: refuse up front (507) when the disk cannot hold `size × 1.1`,
 * instead of failing at chunk N of a multi-gigabyte upload.
 */
async function assertFreeSpace({ dir, size, statfs } = {}) {
  const needed = Math.ceil(Number(size) * FREE_SPACE_FACTOR);
  if (!Number.isFinite(needed) || needed <= 0) return { checked: false, free: null, needed: 0 };
  const free = await freeBytesAt(dir, statfs);
  if (free === null) return { checked: false, free: null, needed };
  if (free < needed) {
    console.warn(`[chunked-upload] insufficient storage: need ${needed} bytes, ${free} free`);
    throw insufficientStorageError();
  }
  return { checked: true, free, needed };
}

function safeExt(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function isValidUploadId(id) {
  return /^[a-f0-9]{32}$/.test(String(id || ''));
}

function partsDirFor(userDir) {
  return path.join(userDir, PARTS_DIR);
}

function metaPathFor(userDir, uploadId) {
  return path.join(partsDirFor(userDir), `${uploadId}.json`);
}

function partPathFor(userDir, uploadId) {
  return path.join(partsDirFor(userDir), `${uploadId}.part`);
}

async function pathExists(p) {
  try {
    await fsPromises.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

async function readMeta(userDir, uploadId) {
  if (!isValidUploadId(uploadId)) throw new ChunkedUploadError(400, 'bad_upload_id', 'Identificador de subida inválido.');
  let raw;
  try {
    raw = await fsPromises.readFile(metaPathFor(userDir, uploadId), 'utf8');
  } catch (_) {
    throw notFoundError();
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new ChunkedUploadError(500, 'upload_meta_corrupt', 'El estado de la subida está dañado. Vuelve a adjuntar el archivo.');
  }
}

async function writeMeta(userDir, meta) {
  const target = metaPathFor(userDir, meta.uploadId);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(tmp, JSON.stringify(meta), 'utf8');
    await fsPromises.rename(tmp, target);
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => {});
    throw mapStorageError(err);
  }
}

function normalizeChunkSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(n)));
}

function chunkBytesFor(meta, idx) {
  return idx === meta.totalChunks - 1 ? meta.size - idx * meta.chunkSize : meta.chunkSize;
}

function receivedIndexes(meta) {
  const list = Array.isArray(meta.received) ? meta.received : [];
  return [...new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < meta.totalChunks))].sort((a, b) => a - b);
}

function lastTouchedMs(meta) {
  const touched = Date.parse(meta.updatedAt || meta.createdAt || '');
  return Number.isFinite(touched) ? touched : 0;
}

function expiresAtMs(meta, staleMs) {
  if (meta.completedAt) {
    const done = Date.parse(meta.completedAt);
    return (Number.isFinite(done) ? done : lastTouchedMs(meta)) + COMPLETED_RETENTION_MS;
  }
  return lastTouchedMs(meta) + staleMs;
}

function multerFileFor(userDir, meta, filename) {
  return {
    fieldname: 'files',
    originalname: meta.name,
    encoding: '7bit',
    mimetype: meta.mimeType,
    size: meta.size,
    destination: userDir,
    filename,
    path: path.join(userDir, filename),
    chunked: true,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.userDir  the user's upload directory (already resolved/validated)
 * @param {string} opts.name     original file name
 * @param {number} opts.size     total bytes
 * @param {string} opts.mimeType declared mime
 * @param {number} [opts.chunkSize]
 * @param {number} opts.maxBytes hard cap for this file family
 * @param {boolean} [opts.checkFreeSpace] refuse with 507 when the disk cannot hold size × 1.1
 * @param {Function} [opts.statfs] injectable `fs.promises.statfs` (tests)
 */
async function initChunkedUpload({ userDir, name, size, mimeType, chunkSize, maxBytes, checkFreeSpace = false, statfs } = {}) {
  const total = Number(size);
  if (!userDir) throw new ChunkedUploadError(400, 'bad_owner', 'Propietario de la subida inválido.');
  if (!Number.isFinite(total) || total <= 0) throw new ChunkedUploadError(400, 'bad_size', 'Tamaño de archivo inválido.');
  if (Number.isFinite(maxBytes) && total > maxBytes) {
    throw new ChunkedUploadError(413, 'file_too_large', `El archivo supera el máximo de ${Math.round(maxBytes / MB)} MB.`);
  }
  const chunk = normalizeChunkSize(chunkSize);
  const totalChunks = Math.ceil(total / chunk);
  const uploadId = randomUUID().replace(/-/g, '');
  const nowIso = new Date().toISOString();
  const meta = {
    uploadId,
    name: String(name || 'archivo'),
    mimeType: String(mimeType || 'application/octet-stream'),
    size: total,
    chunkSize: chunk,
    totalChunks,
    received: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await withStorageErrors(() => fsPromises.mkdir(partsDirFor(userDir), { recursive: true }));
  if (checkFreeSpace) await assertFreeSpace({ dir: userDir, size: total, statfs });
  // Create (or truncate) the part file up front so chunk writes can open r+.
  try {
    const fh = await fsPromises.open(partPathFor(userDir, uploadId), 'w');
    await fh.close();
    await writeMeta(userDir, meta);
  } catch (err) {
    await fsPromises.unlink(partPathFor(userDir, uploadId)).catch(() => {});
    throw mapStorageError(err);
  }
  return {
    uploadId,
    chunkSize: chunk,
    totalChunks,
    size: total,
    expiresAt: new Date(expiresAtMs(meta, resolveStaleMs())).toISOString(),
  };
}

/**
 * Owner-scoped status of one session: the caller resolves `userDir` from the
 * authenticated user, so another user's id simply is not found (404).
 */
async function getChunkedUploadStatus({ userDir, uploadId, now = Date.now(), staleMs = resolveStaleMs() } = {}) {
  const meta = await readMeta(userDir, uploadId);
  const expiresAt = expiresAtMs(meta, staleMs);
  // An unfinished session past its window is gone for the client even when
  // the sweeper has not reached it yet: resuming into it could race the sweep.
  if (!meta.completedAt && now > expiresAt) throw notFoundError();
  const received = receivedIndexes(meta);
  const receivedBytes = received.reduce((sum, idx) => sum + chunkBytesFor(meta, idx), 0);
  return {
    uploadId: meta.uploadId,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    chunkSize: meta.chunkSize,
    totalChunks: meta.totalChunks,
    received,
    receivedBytes,
    state: meta.completedAt ? 'completed' : (meta.finalizing ? 'finalizing' : 'uploading'),
    completed: Boolean(meta.completedAt),
    fileId: meta.completedFileId || null,
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function writeChunk({ userDir, uploadId, index, buffer } = {}) {
  if (!isValidUploadId(uploadId)) throw new ChunkedUploadError(400, 'bad_upload_id', 'Identificador de subida inválido.');
  return withUploadLock(userDir, uploadId, () => writeChunkLocked({ userDir, uploadId, index, buffer }));
}

async function writeChunkLocked({ userDir, uploadId, index, buffer }) {
  const meta = await readMeta(userDir, uploadId);
  if (meta.completedAt || meta.finalizing) {
    throw new ChunkedUploadError(409, 'upload_completed', 'Esta subida ya se completó; no admite más trozos.');
  }
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= meta.totalChunks) {
    throw new ChunkedUploadError(400, 'bad_chunk_index', `Índice de trozo inválido (0–${meta.totalChunks - 1}).`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ChunkedUploadError(400, 'empty_chunk', 'Trozo vacío.');
  }
  const expected = chunkBytesFor(meta, idx);
  if (buffer.length !== expected) {
    throw new ChunkedUploadError(400, 'bad_chunk_size', `El trozo ${idx} debía medir ${expected} bytes y mide ${buffer.length}.`);
  }
  let fh;
  try {
    fh = await fsPromises.open(partPathFor(userDir, uploadId), 'r+');
  } catch (err) {
    // The part vanished under the meta (sweep, manual cleanup): the session is gone.
    if (err && err.code === 'ENOENT') throw notFoundError();
    throw mapStorageError(err);
  }
  try {
    await fh.write(buffer, 0, buffer.length, idx * meta.chunkSize);
  } catch (err) {
    throw mapStorageError(err);
  } finally {
    await fh.close().catch(() => {});
  }
  if (!meta.received.includes(idx)) meta.received.push(idx);
  meta.received.sort((a, b) => a - b);
  meta.updatedAt = new Date().toISOString();
  await writeMeta(userDir, meta);
  return { uploadId, index: idx, received: meta.received.length, totalChunks: meta.totalChunks };
}

async function rollbackFinalize(userDir, meta, finalPath, partPath) {
  try {
    await fsPromises.rename(finalPath, partPath);
    delete meta.finalizing;
    await writeMeta(userDir, meta);
  } catch (_) {
    // The pipeline already removed the final file (or it cannot move back):
    // nothing left to resume, so the session ends here.
    if (!(await pathExists(finalPath))) {
      await fsPromises.unlink(metaPathFor(userDir, meta.uploadId)).catch(() => {});
    }
  }
}

/**
 * Finalise: every chunk present and the part file has the announced size.
 * Returns a multer-shaped file object the regular pipeline understands, plus
 * `replayed` / `completedFileId` / `finalizeResult`.
 *
 * `finalize(file)` (optional) runs INSIDE the upload's lock right after the
 * rename — the route creates the File row there — and returns `{ fileId }`.
 * The id is kept in the meta for an hour so a repeated complete returns the
 * same file (`replayed: true`) instead of a 404. A finalize without a file id
 * (policy rejection, DB failure) ends the session; one that throws rolls the
 * rename back so the client can retry the complete.
 */
async function completeChunkedUpload({ userDir, uploadId, finalize } = {}) {
  if (!isValidUploadId(uploadId)) throw new ChunkedUploadError(400, 'bad_upload_id', 'Identificador de subida inválido.');
  return withUploadLock(userDir, uploadId, () => completeChunkedUploadLocked({ userDir, uploadId, finalize }));
}

async function completeChunkedUploadLocked({ userDir, uploadId, finalize }) {
  const meta = await readMeta(userDir, uploadId);
  if (meta.completedAt) {
    return {
      ...multerFileFor(userDir, meta, meta.completedFilename),
      replayed: true,
      completedFileId: meta.completedFileId || null,
      finalizeResult: null,
    };
  }
  const partPath = partPathFor(userDir, uploadId);
  let filename = null;
  const interrupted = meta.finalizing && typeof meta.finalizing.filename === 'string' ? meta.finalizing.filename : null;
  if (interrupted && !(await pathExists(partPath)) && (await pathExists(path.join(userDir, interrupted)))) {
    // A previous complete renamed the file and the process died before it
    // recorded the outcome: finish that attempt instead of reporting 409.
    filename = interrupted;
  } else {
    const received = receivedIndexes(meta);
    if (received.length !== meta.totalChunks) {
      const missing = [];
      for (let i = 0; i < meta.totalChunks && missing.length < 5; i += 1) if (!received.includes(i)) missing.push(i);
      throw new ChunkedUploadError(409, 'chunks_missing', `Faltan trozos por subir (${meta.totalChunks - received.length}); ejemplo: ${missing.join(', ')}.`);
    }
    const stat = await fsPromises.stat(partPath).catch(() => null);
    if (!stat || stat.size !== meta.size) {
      throw new ChunkedUploadError(409, 'size_mismatch', `El archivo ensamblado mide ${stat ? stat.size : 0} bytes y se anunciaron ${meta.size}.`);
    }
    filename = `files-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}${safeExt(meta.name)}`;
    meta.finalizing = { filename, startedAt: new Date().toISOString() };
    await writeMeta(userDir, meta);
    await withStorageErrors(() => fsPromises.rename(partPath, path.join(userDir, filename)));
  }
  const file = multerFileFor(userDir, meta, filename);

  let finalizeResult = null;
  if (typeof finalize === 'function') {
    try {
      finalizeResult = await finalize({ ...file });
    } catch (err) {
      await rollbackFinalize(userDir, meta, file.path, partPath);
      throw err;
    }
    const fileId = finalizeResult && typeof finalizeResult.fileId === 'string' && finalizeResult.fileId
      ? finalizeResult.fileId
      : null;
    if (!fileId) {
      // The pipeline refused or lost the file: nothing to replay, session over.
      await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
      return { ...file, replayed: false, completedFileId: null, finalizeResult };
    }
    meta.completedFileId = fileId;
  }

  delete meta.finalizing;
  meta.completedAt = new Date().toISOString();
  meta.updatedAt = meta.completedAt;
  meta.completedFilename = filename;
  meta.completedFileId = meta.completedFileId || null;
  try {
    await writeMeta(userDir, meta);
  } catch (err) {
    // The upload itself succeeded; only its replay record could not be kept.
    console.warn(`[chunked-upload] could not record completion of ${uploadId}: ${err && err.message ? err.message : err}`);
    await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
  }
  return { ...file, replayed: false, completedFileId: meta.completedFileId, finalizeResult };
}

async function abortChunkedUpload({ userDir, uploadId } = {}) {
  if (!isValidUploadId(uploadId)) return false;
  return withUploadLock(userDir, uploadId, async () => {
    // A completed session has no part file any more: only its replay record
    // goes, never the final file (it belongs to the File row now).
    await fsPromises.unlink(partPathFor(userDir, uploadId)).catch(() => {});
    await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
    return true;
  });
}

async function sweepPartsDir(userDir, { maxAgeMs = resolveStaleMs(), now = Date.now(), completedRetentionMs = COMPLETED_RETENTION_MS } = {}) {
  const dir = partsDirFor(userDir);
  let entries = [];
  try {
    entries = await fsPromises.readdir(dir);
  } catch (_) {
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    // `.tmp` is a meta write a crash interrupted between writeFile and rename.
    if (!/\.(json|part|tmp)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    const stat = await fsPromises.stat(full).catch(() => null);
    if (!stat) continue;
    const age = now - stat.mtimeMs;
    let stale = age > maxAgeMs;
    if (!stale && entry.endsWith('.json') && age > completedRetentionMs) {
      // A finished session only keeps its replay record for an hour.
      try {
        stale = Boolean(JSON.parse(await fsPromises.readFile(full, 'utf8')).completedAt);
      } catch (_) {
        stale = false;
      }
    }
    if (stale) {
      try {
        await fsPromises.unlink(full);
        removed += 1;
        bytes += stat.size;
      } catch (_) { /* raced with another cleanup */ }
    }
  }
  return { removed, bytes };
}

/** Remove sessions untouched for longer than `maxAgeMs`. Best-effort. */
async function sweepStaleChunkedUploads(userDir, opts = {}) {
  return (await sweepPartsDir(userDir, opts)).removed;
}

/** Sweep every `<rootDir>/<user>/.parts`. Best-effort; never throws. */
async function sweepAllChunkedUploads(rootDir, opts = {}) {
  let entries = [];
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
  } catch (_) {
    return { dirs: 0, removed: 0, bytes: 0 };
  }
  let dirs = 0;
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const userDir = path.join(rootDir, entry.name);
    if (!(await pathExists(partsDirFor(userDir)))) continue;
    dirs += 1;
    const result = await sweepPartsDir(userDir, opts);
    removed += result.removed;
    bytes += result.bytes;
  }
  return { dirs, removed, bytes };
}

let globalSweeper = null;

/**
 * One process-wide sweeper (idempotent): aborted uploads, closed tabs and
 * users who never come back must not keep gigabytes of parts forever. The
 * timers are unref'd so they never hold the process open.
 */
function startChunkedUploadSweeper({ rootDir, intervalMs = DEFAULT_SWEEP_INTERVAL_MS, firstRunMs = 60_000, env = process.env, logger = console } = {}) {
  if (globalSweeper) return globalSweeper;
  if (!rootDir) return null;
  let running = false;
  const runNow = async () => {
    if (running) return { dirs: 0, removed: 0, bytes: 0, skipped: true };
    running = true;
    try {
      const result = await sweepAllChunkedUploads(rootDir, { maxAgeMs: resolveStaleMs(env) });
      if (result.removed > 0 && logger && typeof logger.log === 'function') {
        logger.log(`[chunked-upload] sweep removed ${result.removed} stale file(s), ${result.bytes} bytes reclaimed`);
      }
      return result;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') logger.warn(`[chunked-upload] sweep failed: ${err && err.message ? err.message : err}`);
      return { dirs: 0, removed: 0, bytes: 0, error: true };
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void runNow(); }, Math.max(1, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  const first = setTimeout(() => { void runNow(); }, Math.max(0, Math.min(firstRunMs, intervalMs)));
  if (typeof first.unref === 'function') first.unref();
  const handle = {
    timer,
    runNow,
    stop() {
      clearInterval(timer);
      clearTimeout(first);
      if (globalSweeper === handle) globalSweeper = null;
    },
  };
  globalSweeper = handle;
  return handle;
}

function partsDirExists(userDir) {
  return fs.existsSync(partsDirFor(userDir));
}

module.exports = {
  ChunkedUploadError,
  DEFAULT_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  DEFAULT_STALE_MS,
  COMPLETED_RETENTION_MS,
  FREE_SPACE_FACTOR,
  PARTS_DIR,
  INSUFFICIENT_STORAGE_MESSAGE,
  resolveStaleMs,
  assertFreeSpace,
  mapStorageError,
  initChunkedUpload,
  getChunkedUploadStatus,
  writeChunk,
  completeChunkedUpload,
  abortChunkedUpload,
  sweepStaleChunkedUploads,
  sweepAllChunkedUploads,
  startChunkedUploadSweeper,
  normalizeChunkSize,
  isValidUploadId,
  partsDirExists,
};
