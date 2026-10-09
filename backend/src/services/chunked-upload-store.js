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
 *   complete  → every chunk present + size matches → renamed to the same
 *               `files-<ts>-<rand>.<ext>` layout multer produces, and handed
 *               to the regular processing pipeline as a multer-like object.
 *
 * State lives on disk (meta JSON next to the part file) so a backend restart
 * between chunks does not lose the upload. Stale sessions are swept on init.
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const MB = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * MB;
const MIN_CHUNK_BYTES = 1 * MB;
const MAX_CHUNK_BYTES = 64 * MB;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const PARTS_DIR = '.parts';

class ChunkedUploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ChunkedUploadError';
    this.status = status;
    this.code = code;
  }
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

async function readMeta(userDir, uploadId) {
  if (!isValidUploadId(uploadId)) throw new ChunkedUploadError(400, 'bad_upload_id', 'Identificador de subida inválido.');
  let raw;
  try {
    raw = await fsPromises.readFile(metaPathFor(userDir, uploadId), 'utf8');
  } catch (_) {
    throw new ChunkedUploadError(404, 'upload_not_found', 'La subida no existe o caducó. Vuelve a adjuntar el archivo.');
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new ChunkedUploadError(500, 'upload_meta_corrupt', 'El estado de la subida está dañado. Vuelve a adjuntar el archivo.');
  }
}

async function writeMeta(userDir, meta) {
  const target = metaPathFor(userDir, meta.uploadId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsPromises.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(meta), 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fsPromises.rename(tmp, target);
  const directory = await fsPromises.open(partsDirFor(userDir), 'r').catch(() => null);
  if (directory) { try { await directory.sync(); } catch { /* some filesystems do not support directory fsync */ } finally { await directory.close(); } }
}

async function withUploadLock(userDir, uploadId, task) {
  if (!isValidUploadId(uploadId)) throw new ChunkedUploadError(400, 'bad_upload_id', 'Identificador de subida inválido.');
  await fsPromises.mkdir(partsDirFor(userDir), { recursive: true });
  const lock = path.join(partsDirFor(userDir), `${uploadId}.lock`);
  try { await fsPromises.mkdir(lock); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const stat = await fsPromises.stat(lock).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 120_000) {
      const removed = await fsPromises.rmdir(lock).then(() => true).catch(() => false);
      if (removed) return withUploadLock(userDir, uploadId, task);
    }
    throw new ChunkedUploadError(429, 'upload_busy', 'La subida está procesando otro trozo. Reintenta en unos segundos.');
  }
  try { return await task(); } finally { await fsPromises.rmdir(lock).catch(() => {}); }
}

function publicStatus(meta) {
  return { uploadId: meta.uploadId, name: meta.name, mimeType: meta.mimeType, size: meta.size,
    chunkSize: meta.chunkSize, totalChunks: meta.totalChunks, received: meta.received,
    chunkHashes: meta.chunkHashes || [], status: meta.status || 'uploading', files: meta.response?.files };
}

function normalizeChunkSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(n)));
}

/**
 * @param {object} opts
 * @param {string} opts.userDir  the user's upload directory (already resolved/validated)
 * @param {string} opts.name     original file name
 * @param {number} opts.size     total bytes
 * @param {string} opts.mimeType declared mime
 * @param {number} [opts.chunkSize]
 * @param {number} opts.maxBytes hard cap for this file family
 */
async function initChunkedUpload({ userDir, name, size, mimeType, chunkSize, maxBytes, chunkHashes } = {}) {
  const total = Number(size);
  if (!userDir) throw new ChunkedUploadError(400, 'bad_owner', 'Propietario de la subida inválido.');
  if (!Number.isSafeInteger(total) || total <= 0) throw new ChunkedUploadError(400, 'bad_size', 'Tamaño de archivo inválido.');
  if (Number.isFinite(maxBytes) && total > maxBytes) {
    throw new ChunkedUploadError(413, 'file_too_large', `El archivo supera el máximo de ${Math.round(maxBytes / MB)} MB.`);
  }
  const chunk = normalizeChunkSize(chunkSize);
  const totalChunks = Math.ceil(total / chunk);
  if (chunkHashes !== undefined && (!Array.isArray(chunkHashes) || chunkHashes.length !== totalChunks || chunkHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new ChunkedUploadError(400, 'bad_chunk_hashes', 'La identidad de los trozos es inválida.');
  }
  const identity = chunkHashes ? createHash('sha256').update(JSON.stringify({ name: String(name || 'archivo'), size: total, mimeType: String(mimeType || 'application/octet-stream'), chunkSize: chunk, chunkHashes })).digest('hex') : null;
  const uploadId = identity ? identity.slice(0, 32) : randomUUID().replace(/-/g, '');
  return withUploadLock(userDir, uploadId, async () => {
  if (identity) {
    const prior = await readMeta(userDir, uploadId).catch(err => { if (err.status === 404) return null; throw err; });
    if (prior) return publicStatus(prior);
  }
  const meta = {
    uploadId,
    name: String(name || 'archivo'),
    mimeType: String(mimeType || 'application/octet-stream'),
    size: total,
    chunkSize: chunk,
    totalChunks,
    received: [],
    chunkHashes: chunkHashes || [],
    receivedHashes: {},
    status: 'uploading',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fsPromises.mkdir(partsDirFor(userDir), { recursive: true });
  // Create (or truncate) the part file up front so chunk writes can open r+.
  const fh = await fsPromises.open(partPathFor(userDir, uploadId), 'w');
  await fh.close();
  await writeMeta(userDir, meta);
  return publicStatus(meta);
  });
}

async function writeChunk({ userDir, uploadId, index, buffer } = {}) {
  return withUploadLock(userDir, uploadId, async () => {
  const meta = await readMeta(userDir, uploadId);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= meta.totalChunks) {
    throw new ChunkedUploadError(400, 'bad_chunk_index', `Índice de trozo inválido (0–${meta.totalChunks - 1}).`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ChunkedUploadError(400, 'empty_chunk', 'Trozo vacío.');
  }
  const isLast = idx === meta.totalChunks - 1;
  const expected = isLast ? meta.size - idx * meta.chunkSize : meta.chunkSize;
  if (buffer.length !== expected) {
    throw new ChunkedUploadError(400, 'bad_chunk_size', `El trozo ${idx} debía medir ${expected} bytes y mide ${buffer.length}.`);
  }
  const hash = createHash('sha256').update(buffer).digest('hex');
  if ((meta.chunkHashes?.[idx] && meta.chunkHashes[idx] !== hash) || (meta.receivedHashes?.[idx] && meta.receivedHashes[idx] !== hash)) {
    throw new ChunkedUploadError(409, 'chunk_hash_mismatch', 'El trozo no coincide con el archivo seleccionado.');
  }
  if (meta.received.includes(idx)) return { uploadId, index: idx, received: meta.received.length, totalChunks: meta.totalChunks };
  if (meta.status !== 'uploading' && meta.status !== undefined) throw new ChunkedUploadError(409, 'upload_finalized', 'La subida ya fue ensamblada.');
  const fh = await fsPromises.open(partPathFor(userDir, uploadId), 'r+');
  try {
    let written = 0;
    while (written < buffer.length) {
      const result = await fh.write(buffer, written, buffer.length - written, idx * meta.chunkSize + written);
      if (!result.bytesWritten) throw new Error('chunk_write_failed');
      written += result.bytesWritten;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (!meta.received.includes(idx)) meta.received.push(idx);
  meta.received.sort((a, b) => a - b);
  meta.updatedAt = new Date().toISOString();
  meta.receivedHashes = { ...meta.receivedHashes, [idx]: hash };
  await writeMeta(userDir, meta);
  return { uploadId, index: idx, received: meta.received.length, totalChunks: meta.totalChunks };
  });
}

/**
 * Finalise: every chunk present and the part file has the announced size.
 * Returns a multer-shaped file object the regular pipeline understands.
 */
async function completeChunkedUpload({ userDir, uploadId } = {}) {
  return withUploadLock(userDir, uploadId, async () => {
  const meta = await readMeta(userDir, uploadId);
  if (meta.received.length !== meta.totalChunks) {
    const missing = [];
    for (let i = 0; i < meta.totalChunks && missing.length < 5; i += 1) if (!meta.received.includes(i)) missing.push(i);
    throw new ChunkedUploadError(409, 'chunks_missing', `Faltan trozos por subir (${meta.totalChunks - meta.received.length}); ejemplo: ${missing.join(', ')}.`);
  }
  const filename = meta.filename || `files-${uploadId}${safeExt(meta.name)}`;
  const finalPath = path.join(userDir, filename);
  const partPath = partPathFor(userDir, uploadId);
  const alreadyAssembled = await fsPromises.stat(finalPath).catch(() => null);
  const stat = alreadyAssembled || await fsPromises.stat(partPath).catch(() => null);
  if (!stat || stat.size !== meta.size) {
    throw new ChunkedUploadError(409, 'size_mismatch', `El archivo ensamblado mide ${stat ? stat.size : 0} bytes y se anunciaron ${meta.size}.`);
  }
  if (!alreadyAssembled) await fsPromises.rename(partPath, finalPath);
  meta.filename = filename;
  meta.status = meta.response ? 'completed' : 'assembled';
  meta.updatedAt = new Date().toISOString();
  await writeMeta(userDir, meta);
  return {
    fieldname: 'files',
    originalname: meta.name,
    encoding: '7bit',
    mimetype: meta.mimeType,
    size: meta.size,
    destination: userDir,
    filename,
    path: finalPath,
    chunked: true,
    deterministicId: `upload_${createHash('sha256').update(`${path.resolve(userDir)}:${uploadId}`).digest('hex').slice(0, 40)}`,
  };
  });
}

async function getChunkedUploadStatus({ userDir, uploadId } = {}) { return publicStatus(await readMeta(userDir, uploadId)); }
async function getCompletedResponse({ userDir, uploadId } = {}) { return (await readMeta(userDir, uploadId)).response || null; }
async function saveCompletedResponse({ userDir, uploadId, response } = {}) {
  return withUploadLock(userDir, uploadId, async () => {
    const meta = await readMeta(userDir, uploadId);
    meta.response = response; meta.status = 'completed'; meta.updatedAt = new Date().toISOString();
    await writeMeta(userDir, meta);
    return response;
  });
}

async function abortChunkedUpload({ userDir, uploadId } = {}) {
  if (!isValidUploadId(uploadId)) return false;
  return withUploadLock(userDir, uploadId, async () => {
  const meta = await readMeta(userDir, uploadId).catch(() => null);
  // Assembly is the commit boundary: a File row may already exist while its
  // final response is being saved. Never delete a registered binary on Cancel.
  if (meta?.status === 'assembled' || meta?.status === 'completed') return false;
  await fsPromises.unlink(partPathFor(userDir, uploadId)).catch(() => {});
  await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
  return true;
  });
}

/** Remove sessions untouched for longer than `maxAgeMs`. Best-effort. */
async function sweepStaleChunkedUploads(userDir, { maxAgeMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const dir = partsDirFor(userDir);
  let entries = [];
  try {
    entries = await fsPromises.readdir(dir);
  } catch (_) {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!/\.(json|part)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    const stat = await fsPromises.stat(full).catch(() => null);
    if (!stat) continue;
    if (now - stat.mtimeMs > maxAgeMs) {
      await fsPromises.unlink(full).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

function partsDirExists(userDir) {
  return fs.existsSync(partsDirFor(userDir));
}

module.exports = {
  ChunkedUploadError,
  DEFAULT_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  PARTS_DIR,
  initChunkedUpload,
  writeChunk,
  completeChunkedUpload,
  getChunkedUploadStatus,
  getCompletedResponse,
  saveCompletedResponse,
  abortChunkedUpload,
  sweepStaleChunkedUploads,
  normalizeChunkSize,
  isValidUploadId,
  partsDirExists,
};
