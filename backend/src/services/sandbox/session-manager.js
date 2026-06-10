'use strict';

/**
 * sandbox/session-manager — scoped temp workspaces for document editing.
 *
 * Each session gets an isolated directory under OS tmpdir:
 *   /tmp/sira-sandbox-{sessionId}/
 *
 * Lifecycle:
 *   createSession()          → allocates dir, optionally pulls file from R2
 *   getSession(id)           → returns { workdir, files, createdAt } or null
 *   touchSession(id)         → resets the TTL (called after each tool use)
 *   destroySession(id)       → rm -rf the workdir immediately
 *   listFiles(id)            → shallow listing of files in workdir
 *
 * Cleanup:
 *   Sessions are destroyed automatically after SESSION_TTL_MS (default 30min)
 *   of inactivity. A GC sweep runs every GC_INTERVAL_MS (default 5min).
 *
 * Security:
 *   All path operations are confined to the session workdir via
 *   assertInsideWorkdir(). No symlink escapes are followed.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const SESSION_TTL_MS   = parseInt(process.env.SANDBOX_SESSION_TTL_MS  || String(30 * 60_000), 10);
const GC_INTERVAL_MS   = parseInt(process.env.SANDBOX_GC_INTERVAL_MS  || String(5  * 60_000), 10);
const MAX_FILE_BYTES   = parseInt(process.env.SANDBOX_MAX_FILE_BYTES   || String(50 * 1024 * 1024), 10); // 50 MB
const MAX_SESSIONS     = parseInt(process.env.SANDBOX_MAX_SESSIONS     || '200', 10);

const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(os.tmpdir(), 'sira-sandbox');

const sessions = new Map(); // sessionId → { workdir, lastTouched, userId, meta }

// ── helpers ────────────────────────────────────────────────────────────────

function mkdirSafe(p) {
  try { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); } catch (_) { /* exists */ }
}

function rmSafe(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* already gone */ }
}

function assertInsideWorkdir(workdir, filePath) {
  const real = path.resolve(workdir, filePath);
  if (!real.startsWith(path.resolve(workdir) + path.sep) && real !== path.resolve(workdir)) {
    throw Object.assign(new Error(`path_escape: "${filePath}" is outside the sandbox workdir`), { code: 'PATH_ESCAPE' });
  }
  return real;
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

// ── GC ─────────────────────────────────────────────────────────────────────

let gcTimer = null;

function runGc() {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastTouched > SESSION_TTL_MS) {
      rmSafe(sess.workdir);
      sessions.delete(id);
    }
  }
}

function startGc() {
  if (gcTimer) return;
  gcTimer = setInterval(runGc, GC_INTERVAL_MS);
  if (typeof gcTimer.unref === 'function') gcTimer.unref();
}

startGc();

// ── R2 download helper ──────────────────────────────────────────────────────

async function downloadFromR2(r2Key, destPath) {
  let storage;
  try {
    const { createR2ArtifactStorage } = require('../orchestration/r2-storage');
    storage = createR2ArtifactStorage();
  } catch (_) {
    throw new Error('R2 storage not configured');
  }

  const realKey = String(r2Key).replace(/^r2:/, '');
  const resp = await storage.getObject(realKey);
  const writeStream = fs.createWriteStream(destPath);

  if (resp.Body && typeof resp.Body.pipe === 'function') {
    await pipeline(resp.Body, writeStream);
  } else if (resp.Body && typeof resp.Body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of resp.Body) {
      writeStream.write(chunk);
    }
    writeStream.end();
    await new Promise((res, rej) => { writeStream.on('finish', res); writeStream.on('error', rej); });
  } else {
    throw new Error('R2 getObject returned unexpected Body type');
  }
}

// ── upload helper ───────────────────────────────────────────────────────────

async function uploadToR2(localPath, r2Key, contentType = 'application/octet-stream') {
  let storage;
  try {
    const { createR2ArtifactStorage } = require('../orchestration/r2-storage');
    storage = createR2ArtifactStorage();
  } catch (_) {
    throw new Error('R2 storage not configured');
  }
  const buf = fs.readFileSync(localPath);
  await storage.upload({ key: r2Key, body: buf, contentType });
  return r2Key;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Create a new sandbox session.
 *
 * @param {object} opts
 * @param {string}        [opts.userId]    — owner (for audit / quota)
 * @param {string}        [opts.r2Key]     — optional R2 object to mount at workdir
 * @param {string}        [opts.filename]  — name to save the mounted file as
 * @param {object}        [opts.meta]      — arbitrary caller metadata
 * @returns {{ sessionId, workdir, filename|null }}
 */
async function createSession({ userId = null, r2Key = null, filename = null, meta = {} } = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw Object.assign(new Error('sandbox_session_limit: too many active sessions'), { code: 'SESSION_LIMIT' });
  }

  const sessionId = newId();
  const workdir   = path.join(SANDBOX_ROOT, sessionId);
  mkdirSafe(workdir);

  let mountedFilename = null;

  if (r2Key) {
    const base = filename || path.basename(String(r2Key).replace(/^r2:/, ''));
    const dest = path.join(workdir, base);
    await downloadFromR2(r2Key, dest);
    mountedFilename = base;
  }

  sessions.set(sessionId, {
    workdir,
    lastTouched: Date.now(),
    userId,
    meta: { ...meta, mountedFile: mountedFilename },
  });

  return { sessionId, workdir, filename: mountedFilename };
}

/**
 * Returns the session record or null.
 */
function getSession(sessionId) {
  return sessions.get(String(sessionId || '')) || null;
}

/**
 * Reset TTL for an active session. Call this after each tool execution.
 */
function touchSession(sessionId) {
  const s = sessions.get(String(sessionId || ''));
  if (s) s.lastTouched = Date.now();
  return Boolean(s);
}

/**
 * Immediately destroy a session and its workdir.
 */
function destroySession(sessionId) {
  const s = sessions.get(String(sessionId || ''));
  if (!s) return false;
  rmSafe(s.workdir);
  sessions.delete(String(sessionId));
  return true;
}

/**
 * List files in the session workdir (shallow, relative paths).
 */
function listFiles(sessionId) {
  const s = getSession(sessionId);
  if (!s) return [];
  try {
    return fs.readdirSync(s.workdir).filter((f) => {
      try { return fs.statSync(path.join(s.workdir, f)).isFile(); } catch (_) { return false; }
    });
  } catch (_) { return []; }
}

/**
 * Read a file from the session workdir. Returns { ok, content, truncated }.
 */
function readFile(sessionId, filePath, { maxBytes = 512 * 1024 } = {}) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  try {
    const abs = assertInsideWorkdir(s.workdir, filePath);
    const buf = fs.readFileSync(abs);
    const truncated = buf.length > maxBytes;
    return { ok: true, content: buf.slice(0, maxBytes).toString('utf8'), truncated, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Write a file in the session workdir.
 */
function writeFile(sessionId, filePath, content) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  try {
    const abs = assertInsideWorkdir(s.workdir, filePath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) return { ok: false, error: `file_too_large: ${bytes} bytes` };
    mkdirSafe(path.dirname(abs));
    fs.writeFileSync(abs, content, 'utf8');
    touchSession(sessionId);
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Surgical text replacement in a file.
 */
function patchFile(sessionId, filePath, oldText, newText) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  try {
    const abs = assertInsideWorkdir(s.workdir, filePath);
    const content = fs.readFileSync(abs, 'utf8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) return { ok: false, error: 'old_text_not_found' };
    const updated = content.split(oldText).join(newText);
    fs.writeFileSync(abs, updated, 'utf8');
    touchSession(sessionId);
    return { ok: true, replacements: occurrences };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Finalize a session: upload a named file back to R2 and return the key.
 */
async function finalizeFile(sessionId, filename, { r2Prefix = 'sandbox-output' } = {}) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  try {
    const abs = assertInsideWorkdir(s.workdir, filename);
    if (!fs.existsSync(abs)) return { ok: false, error: 'file_not_found' };
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf':  'application/pdf',
      '.csv':  'text/csv',
      '.txt':  'text/plain',
      '.md':   'text/markdown',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const r2Key = `${r2Prefix}/${sessionId}/${filename}`;
    await uploadToR2(abs, r2Key, contentType);
    return { ok: true, r2Key, filename };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createSession,
  getSession,
  touchSession,
  destroySession,
  listFiles,
  readFile,
  writeFile,
  patchFile,
  finalizeFile,
  SANDBOX_ROOT,
};
