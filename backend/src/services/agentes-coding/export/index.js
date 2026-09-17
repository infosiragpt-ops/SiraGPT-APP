'use strict';

/**
 * agentes-coding/export — zip/tarball of a jailed session workspace.
 *
 * Metadata + in-memory artifact (no host dump). Path jail + size caps.
 * Flag: AGENTES_CODING_V2 (default OFF). See docs/agentes-coding-export-deploy.md
 */

const crypto = require('node:crypto');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail } = require('../coding-sandbox/errors');
const { jailRelPath } = require('../coding-sandbox/path-jail');
const { parsePositiveInt } = require('../coding-sandbox/limits');
const { buildArchive } = require('./archive');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 256;
const MAX_EXPORTS = 8;
const SKIP_PREFIXES = ['.git/', '.sira/exports/'];

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

function resolveCaps(env = process.env, opts = {}) {
  return {
    maxBytes: parsePositiveInt(
      opts.maxBytes || env.AGENTES_CODING_EXPORT_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      1024,
      32 * 1024 * 1024,
    ),
    maxFiles: parsePositiveInt(
      opts.maxFiles || env.AGENTES_CODING_EXPORT_MAX_FILES,
      DEFAULT_MAX_FILES,
      1,
      2000,
    ),
  };
}

async function requireSession(sandbox, sessionId) {
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  await sandbox.listFiles(sessionId, '.');
  const raw = typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return raw;
}

function getStore(raw) {
  if (!raw.exports) raw.exports = { items: [] };
  if (!Array.isArray(raw.exports.items)) raw.exports.items = [];
  return raw.exports;
}

function skipExportPath(rel) {
  const p = String(rel || '');
  if (p === '.git' || p.startsWith('.git/')) return true;
  return SKIP_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

function underPrefix(rel, prefix) {
  if (!prefix || prefix === '.') return true;
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

function publicExport(row, { includeBytes = false } = {}) {
  const out = {
    id: row.id,
    format: row.format,
    bytes: row.bytes,
    sha256: row.sha256,
    files: row.files,
    fileCount: row.fileCount,
    artifactPath: row.artifactPath,
    createdAt: row.createdAt,
    mime: row.mime,
  };
  if (includeBytes) out.contentBase64 = row.buffer.toString('base64');
  return out;
}

async function collectEntries(sandbox, sessionId, opts = {}) {
  const prefix = opts.path ? jailRelPath(opts.path, { forList: true }) : '.';
  const listed = await sandbox.listFiles(sessionId, prefix);
  const entries = [];
  let total = 0;
  for (const item of listed || []) {
    const rel = typeof item === 'string' ? item : item && item.path;
    if (!rel || skipExportPath(rel)) continue;
    let jailed;
    try {
      jailed = jailRelPath(rel);
    } catch {
      continue;
    }
    if (!underPrefix(jailed, prefix)) continue;
    const buf = await sandbox.readFile(sessionId, jailed);
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
    total += data.length;
    entries.push({ path: jailed, data, size: data.length });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, total, prefix };
}

async function exportSession(sandbox, sessionId, opts = {}) {
  const env = opts.env || process.env;
  const caps = resolveCaps(env, opts);
  const raw = await requireSession(sandbox, sessionId);
  const { entries, total, prefix } = await collectEntries(sandbox, sessionId, opts);
  if (entries.length > caps.maxFiles) {
    fail('E_QUOTA', `El export supera ${caps.maxFiles} archivos.`);
  }
  if (total > caps.maxBytes) {
    fail('E_QUOTA', `El workspace supera ${caps.maxBytes} bytes.`);
  }
  let archive;
  try {
    archive = buildArchive(opts.format, entries);
  } catch (err) {
    if (err && err.code && err.status) throw err;
    fail('E_EXPORT_FAILED', String(err && err.message || err || '').slice(0, 160));
  }
  if (archive.bytes.length > caps.maxBytes) {
    fail('E_QUOTA', `El archivo exportado supera ${caps.maxBytes} bytes.`);
  }
  const id = `exp_${crypto.randomBytes(8).toString('hex')}`;
  const sha256 = crypto.createHash('sha256').update(archive.bytes).digest('hex');
  const artifactPath = jailRelPath(`.sira/exports/${id}.${archive.ext}`);
  const row = {
    id,
    format: archive.format,
    bytes: archive.bytes.length,
    sha256,
    files: entries.map((e) => ({ path: e.path, size: e.size })),
    fileCount: entries.length,
    artifactPath,
    createdAt: Date.now(),
    mime: archive.mime,
    prefix,
    buffer: archive.bytes,
  };
  const store = getStore(raw);
  store.items.push(row);
  if (store.items.length > MAX_EXPORTS) store.items.splice(0, store.items.length - MAX_EXPORTS);
  return {
    ok: true,
    export: publicExport(row, { includeBytes: opts.includeBytes === true }),
  };
}

async function listExports(sandbox, sessionId) {
  const raw = await requireSession(sandbox, sessionId);
  const store = getStore(raw);
  return {
    ok: true,
    exports: store.items.map((row) => publicExport(row)),
  };
}

async function getExport(sandbox, sessionId, exportId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  const id = String(exportId || '').trim();
  if (!id) fail('E_PARAMS', 'Falta el id de exportación.');
  const row = getStore(raw).items.find((item) => item.id === id);
  if (!row) fail('E_EXPORT_NOT_FOUND');
  return {
    ok: true,
    export: publicExport(row, { includeBytes: opts.includeBytes === true }),
    buffer: opts.raw === true ? row.buffer : undefined,
  };
}

function forget(sandbox, sessionId) {
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (raw && raw.exports) raw.exports = { items: [] };
}

async function exportForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return exportSession(sandbox, sessionId, { ...opts, env, ...extras });
}

async function listForRequest(sandbox, sessionId, env) {
  requireEnabled(env);
  return listExports(sandbox, sessionId);
}

async function getForRequest(sandbox, sessionId, exportId, opts, env) {
  requireEnabled(env);
  return getExport(sandbox, sessionId, exportId, opts);
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  requireEnabled,
  resolveCaps,
  exportSession,
  listExports,
  getExport,
  forget,
  exportForRequest,
  listForRequest,
  getForRequest,
  skipExportPath,
};
