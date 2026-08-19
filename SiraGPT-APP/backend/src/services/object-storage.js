'use strict';

/**
 * Unified object storage for user-generated binaries (uploads, generated
 * videos, generated images, rendered documents).
 *
 * Goal: keep ZERO durable binaries on the VM filesystem so the app scales
 * horizontally and the deploy image stays small. Cloudflare R2 is the
 * backing store (free egress, ~$0.015/GB-month). Text stays in Postgres.
 *
 * A "ref" is the value persisted in the DB. It is either:
 *   - an R2 ref:  "r2:<key>"   (when R2 is configured)
 *   - a local path: "/abs/or/relative/path" (dev fallback when R2 is off)
 *
 * R2 keys deliberately MIRROR the public upload-relative path
 * ("uploads/<userId>/<filename>") so the existing `/uploads/...` URLs keep
 * resolving via a thin R2 fallback middleware — no frontend changes needed.
 *
 * The AWS SDK is loaded lazily by r2-storage, so requiring this module is
 * always safe even when R2 deps/secrets are absent.
 */

const fsSync = require('fs');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createR2ArtifactStorage } = require('../orchestration/r2-storage');

const REF_PREFIX = 'r2:';

let _storage; // memoised per-process
function storage(env = process.env) {
  if (_storage === undefined || _storage === null) {
    try {
      _storage = createR2ArtifactStorage({ env });
    } catch {
      _storage = { enabled: false };
    }
  }
  return _storage;
}

function enabled(env = process.env) {
  const s = storage(env);
  return Boolean(s && s.enabled);
}

function isRemote(ref) {
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX);
}
function keyFromRef(ref) {
  return isRemote(ref) ? ref.slice(REF_PREFIX.length) : ref;
}
function refFromKey(key) {
  return REF_PREFIX + key;
}

// ── Key builders (R2 keys mirror the public path so URLs stay stable) ──
function sanitizeSegment(value, fallback = 'anon') {
  const seg = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  return seg || fallback;
}
function uploadKey(userId, filename) {
  return `uploads/${sanitizeSegment(userId)}/${sanitizeSegment(filename, 'file.bin')}`;
}
function videoKey(filename) {
  return `videos/${sanitizeSegment(filename, 'video.mp4')}`;
}
function imageKey(userId, filename) {
  return `images/${sanitizeSegment(userId)}/${sanitizeSegment(filename, 'image.png')}`;
}
function docKey(userId, filename) {
  return `documents/${sanitizeSegment(userId)}/${sanitizeSegment(filename, 'document.bin')}`;
}

// ── Writes ──
async function putBuffer({ key, buffer, contentType, metadata, env = process.env }) {
  if (!enabled(env)) throw new Error('object-storage: R2 not configured');
  await storage(env).put({ key, body: buffer, contentType: contentType || 'application/octet-stream', metadata });
  return { key, ref: refFromKey(key), storage: 'r2' };
}

/**
 * Upload a binary that currently lives on disk to R2 and (optionally) remove
 * the local copy. When R2 is off, leaves the file on disk and returns its
 * path as the ref — preserving the legacy local-disk behaviour for dev.
 */
async function persistLocalFile({ localPath, key, contentType, metadata, deleteLocal = true, env = process.env }) {
  if (!enabled(env)) {
    return { key: null, ref: localPath, storage: 'local' };
  }
  const buffer = await fs.readFile(localPath);
  await storage(env).put({ key, body: buffer, contentType: contentType || 'application/octet-stream', metadata });
  if (deleteLocal) {
    try { await fs.unlink(localPath); } catch { /* best-effort */ }
  }
  return { key, ref: refFromKey(key), storage: 'r2' };
}

// ── Reads ──
async function signedUrl(refOrKey, ttl, env = process.env) {
  if (!enabled(env)) return null;
  return storage(env).signedGetUrl(keyFromRef(refOrKey), ttl);
}

/**
 * Return a readable stream for a ref, honouring an optional HTTP byte-range.
 * Works for both R2 refs and local paths so call sites can swap
 * `fs.createReadStream(file.path)` for this transparently.
 * Returns { stream, contentLength, contentType, contentRange }.
 */
async function readStream(ref, { range } = {}, env = process.env) {
  if (isRemote(ref)) {
    const obj = await storage(env).getObject(keyFromRef(ref), { range });
    return {
      stream: obj.Body,
      contentLength: obj.ContentLength,
      contentType: obj.ContentType,
      contentRange: obj.ContentRange,
    };
  }
  // Local fallback. `range` here is an HTTP header string we don't parse;
  // local call sites pass byte offsets directly to fs, so this branch is
  // only used when range is undefined.
  return {
    stream: fsSync.createReadStream(ref),
    contentLength: undefined,
    contentType: undefined,
    contentRange: undefined,
  };
}

/** Size + content-type of a ref. Returns null if it cannot be determined. */
async function stat(ref, env = process.env) {
  try {
    if (isRemote(ref)) {
      const h = await storage(env).head(keyFromRef(ref));
      return { size: h.ContentLength, contentType: h.ContentType };
    }
    const st = await fs.stat(ref);
    return { size: st.size, contentType: undefined };
  } catch {
    return null;
  }
}

async function exists(ref, env = process.env) {
  if (isRemote(ref)) {
    try { await storage(env).head(keyFromRef(ref)); return true; } catch { return false; }
  }
  return fsSync.existsSync(ref);
}

/**
 * Ensure a local copy of a ref exists on disk and return its path plus a
 * cleanup() to remove the temp file. For local refs this is a no-op passthrough
 * (cleanup does nothing). Used by tools that require a filesystem path
 * (LibreOffice/Gotenberg renderers, file-type sniffers, etc.).
 */
async function toLocalTemp(ref, env = process.env) {
  if (!isRemote(ref)) {
    return { path: ref, cleanup: async () => {} };
  }
  const key = keyFromRef(ref);
  const tmp = path.join(os.tmpdir(), `r2-${crypto.randomBytes(8).toString('hex')}${path.extname(key)}`);
  const obj = await storage(env).getObject(key);
  await new Promise((resolve, reject) => {
    const out = fsSync.createWriteStream(tmp);
    obj.Body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    obj.Body.pipe(out);
  });
  return { path: tmp, cleanup: async () => { try { await fs.unlink(tmp); } catch { /* best-effort */ } } };
}

async function remove(ref, env = process.env) {
  if (!ref) return;
  if (isRemote(ref)) {
    try { await storage(env).delete(keyFromRef(ref)); } catch { /* best-effort */ }
    return;
  }
  try { await fs.unlink(ref); } catch { /* best-effort */ }
}

// Test seam: allow tests to inject a fake storage backend.
function __setStorageForTests(fake) { _storage = fake; }

module.exports = {
  REF_PREFIX,
  enabled,
  isRemote,
  keyFromRef,
  refFromKey,
  uploadKey,
  videoKey,
  imageKey,
  docKey,
  sanitizeSegment,
  putBuffer,
  persistLocalFile,
  signedUrl,
  readStream,
  stat,
  exists,
  toLocalTemp,
  remove,
  __setStorageForTests,
};
