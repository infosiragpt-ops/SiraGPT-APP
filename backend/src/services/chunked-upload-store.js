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
const { randomUUID } = require('crypto');

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
  await fsPromises.writeFile(tmp, JSON.stringify(meta), 'utf8');
  await fsPromises.rename(tmp, target);
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
async function initChunkedUpload({ userDir, name, size, mimeType, chunkSize, maxBytes } = {}) {
  const total = Number(size);
  if (!userDir) throw new ChunkedUploadError(400, 'bad_owner', 'Propietario de la subida inválido.');
  if (!Number.isFinite(total) || total <= 0) throw new ChunkedUploadError(400, 'bad_size', 'Tamaño de archivo inválido.');
  if (Number.isFinite(maxBytes) && total > maxBytes) {
    throw new ChunkedUploadError(413, 'file_too_large', `El archivo supera el máximo de ${Math.round(maxBytes / MB)} MB.`);
  }
  const chunk = normalizeChunkSize(chunkSize);
  const totalChunks = Math.ceil(total / chunk);
  const uploadId = randomUUID().replace(/-/g, '');
  const meta = {
    uploadId,
    name: String(name || 'archivo'),
    mimeType: String(mimeType || 'application/octet-stream'),
    size: total,
    chunkSize: chunk,
    totalChunks,
    received: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fsPromises.mkdir(partsDirFor(userDir), { recursive: true });
  // Create (or truncate) the part file up front so chunk writes can open r+.
  const fh = await fsPromises.open(partPathFor(userDir, uploadId), 'w');
  await fh.close();
  await writeMeta(userDir, meta);
  return { uploadId, chunkSize: chunk, totalChunks, size: total };
}

async function writeChunk({ userDir, uploadId, index, buffer } = {}) {
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
  const fh = await fsPromises.open(partPathFor(userDir, uploadId), 'r+');
  try {
    await fh.write(buffer, 0, buffer.length, idx * meta.chunkSize);
  } finally {
    await fh.close();
  }
  if (!meta.received.includes(idx)) meta.received.push(idx);
  meta.received.sort((a, b) => a - b);
  meta.updatedAt = new Date().toISOString();
  await writeMeta(userDir, meta);
  return { uploadId, index: idx, received: meta.received.length, totalChunks: meta.totalChunks };
}

/**
 * Finalise: every chunk present and the part file has the announced size.
 * Returns a multer-shaped file object the regular pipeline understands.
 */
async function completeChunkedUpload({ userDir, uploadId } = {}) {
  const meta = await readMeta(userDir, uploadId);
  if (meta.received.length !== meta.totalChunks) {
    const missing = [];
    for (let i = 0; i < meta.totalChunks && missing.length < 5; i += 1) if (!meta.received.includes(i)) missing.push(i);
    throw new ChunkedUploadError(409, 'chunks_missing', `Faltan trozos por subir (${meta.totalChunks - meta.received.length}); ejemplo: ${missing.join(', ')}.`);
  }
  const partPath = partPathFor(userDir, uploadId);
  const stat = await fsPromises.stat(partPath).catch(() => null);
  if (!stat || stat.size !== meta.size) {
    throw new ChunkedUploadError(409, 'size_mismatch', `El archivo ensamblado mide ${stat ? stat.size : 0} bytes y se anunciaron ${meta.size}.`);
  }
  const filename = `files-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}${safeExt(meta.name)}`;
  const finalPath = path.join(userDir, filename);
  await fsPromises.rename(partPath, finalPath);
  await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
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
  };
}

async function abortChunkedUpload({ userDir, uploadId } = {}) {
  if (!isValidUploadId(uploadId)) return false;
  await fsPromises.unlink(partPathFor(userDir, uploadId)).catch(() => {});
  await fsPromises.unlink(metaPathFor(userDir, uploadId)).catch(() => {});
  return true;
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
  abortChunkedUpload,
  sweepStaleChunkedUploads,
  normalizeChunkSize,
  isValidUploadId,
  partsDirExists,
};
