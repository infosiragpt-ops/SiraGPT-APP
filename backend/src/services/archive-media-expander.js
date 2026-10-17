'use strict';

/**
 * archive-media-expander — the audio, video and photos inside a ZIP upload
 * become files of their own, so they are transcribed and read like any
 * upload. The common case is WhatsApp «Exportar chat»: `_chat.txt` plus
 * dozens of `PTT-…opus` voice notes and `IMG-…jpg` photos; until now only
 * the text was read.
 *
 *   expandArchiveMedia({ prisma, userId, parent, userDir, schedule, ... })
 *     → { ok, children: [{ fileId, kind, member, mimeType, size, reused? }],
 *         skipped: { <reason>: count }, truncated, reason?, whatsapp }
 *
 * Contract C3 of the «transcription never fails» plan:
 * - members are extracted up to caps of count and total bytes, media first;
 * - each becomes a child File row of the same user in the user's upload
 *   directory (`<UPLOAD_DIR>/<userId>/<filename>`, like multer's uploads),
 *   re-validated by magic bytes with the upload policy;
 * - media go to the durable media queue and images to the existing image
 *   processing, through the caller's `schedule(file, row)`;
 * - the link is `DocumentAnalysis.metadata.archiveParent` on the child
 *   (WhatsApp sender and time when the chat text names the member) and
 *   `archiveExpansion` on the parent.
 *
 * Safety: archives up to 100 MB are read with pizzip, larger ones with
 * `unzip -v` + a streaming `unzip -p` per member. Every member is inflated
 * through a byte counter (never more than the size its header declares, so
 * a lying header cannot become a zip bomb), CRC-checked when Node can, and
 * written under a name WE choose — the member path never touches the disk
 * (no zip-slip). Suspicious compression ratios, oversize members, the total
 * cap and a disk-space reserve are enforced before anything is written.
 * Idempotent: child names are derived from (parent, member), so a second
 * pass over the same archive reuses the rows instead of duplicating them.
 * Never throws; logs carry ids and counts only.
 *
 * Restarts: a member is inflated into `<userDir>/.parts/<filename>.part`
 * (the folder the chunked-upload sweeper reclaims), checked there, given its
 * File row and only then renamed into the upload folder, so a deploy never
 * leaves an extracted member without a row. The parent carries
 * `archiveExpansion.state = 'running'` (with the `processed` member
 * indices) until the final record; `resumeArchiveExpansions()` finishes
 * what a restart interrupted, without recreating a child the user deleted.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PassThrough, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const uploadPolicy = require('./upload-security-policy');
const { isUnsafeEntryName, escapeUnzipPattern } = require('./zip-parser');
const { runMediaCommand } = require('./media-probe');
const { PARTS_DIR } = require('./chunked-upload-store');

const MB = 1024 * 1024;
const DB_FILE_SIZE_MAX = 2147483647;
const ZIP_MIMES = new Set(['application/zip', 'application/x-zip', 'application/x-zip-compressed']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif']);
const IMAGE_CANONICAL = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['jfif', 'image/jpeg'], ['png', 'image/png'], ['gif', 'image/gif'],
  ['webp', 'image/webp'], ['bmp', 'image/bmp'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'],
  ['heic', 'image/heic'], ['heif', 'image/heif'], ['avif', 'image/avif'],
]);
// TypeScript sources share `.ts/.mts/.cts` with MPEG-TS video; MIDI is not
// speech. Neither is worth a transcription job.
const NOT_MEDIA_EXTENSIONS = new Set(['ts', 'cts', 'mid', 'midi']);
const CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'vue', 'svelte', 'scala', 'dart']);
const CODE_MANIFESTS = new Set(['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'composer.json', 'gemfile', 'package.swift', 'pubspec.yaml', 'tsconfig.json']);
const WHATSAPP_CHAT_RE = /^(?:_chat\.txt|whatsapp chat.*\.txt|chat de whatsapp.*\.txt|conversa do whatsapp.*\.txt|whatsapp-chat.*\.txt)$/i;
const DEFLATE = '\x08\x00';
const STORE = '\x00\x00';

function intFromEnv(env, name, fallback, min, max) {
  const n = Number.parseInt(env && env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Effective caps: explicit `limits` win, then env, then defaults. */
function resolveLimits(env = process.env, limits = {}) {
  const uploadLimits = uploadPolicy.resolveUploadLimits(env);
  const finite = (v, fb) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fb);
  return {
    maxMembers: finite(limits.maxMembers, intFromEnv(env, 'SIRAGPT_ARCHIVE_MEDIA_MAX_MEMBERS', 60, 1, 500)),
    maxImages: limits.maxImages != null && Number(limits.maxImages) >= 0
      ? Math.floor(Number(limits.maxImages))
      : intFromEnv(env, 'SIRAGPT_ARCHIVE_MEDIA_MAX_IMAGES', 30, 0, 500),
    maxBytes: finite(limits.maxBytes, intFromEnv(env, 'SIRAGPT_ARCHIVE_MEDIA_MAX_MB', 1024, 1, 20 * 1024) * MB),
    maxRatio: finite(limits.maxRatio, intFromEnv(env, 'SIRAGPT_ARCHIVE_MEDIA_MAX_RATIO', 100, 2, 10_000)),
    ratioMinBytes: finite(limits.ratioMinBytes, 1 * MB),
    maxMediaMemberBytes: finite(limits.maxMediaMemberBytes, finite(uploadLimits.mediaFileSize, 10 * 1024 * MB)),
    maxImageMemberBytes: finite(limits.maxImageMemberBytes, Math.min(finite(uploadLimits.fileSize, 100 * MB), 100 * MB)),
    minMediaBytes: finite(limits.minMediaBytes, 1024),
    minImageBytes: finite(limits.minImageBytes, 12 * 1024),
    pizzipMaxBytes: finite(limits.pizzipMaxBytes, 100 * MB),
    timeoutMs: finite(limits.timeoutMs, intFromEnv(env, 'SIRAGPT_ARCHIVE_MEDIA_TIMEOUT_MS', 10 * 60 * 1000, 5000, 60 * 60 * 1000)),
    freeSpaceReserveBytes: limits.freeSpaceReserveBytes != null ? Number(limits.freeSpaceReserveBytes) : 512 * MB,
    chatTextMaxBytes: finite(limits.chatTextMaxBytes, 8 * MB),
  };
}

function isEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.SIRAGPT_ARCHIVE_MEDIA ?? '1'));
}

function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A ZIP upload (not a docx/xlsx/epub/jar, which are ZIP containers too). */
function isArchiveCandidate(file) {
  const name = String((file && (file.originalName || file.originalname || file.name)) || '');
  const mime = String((file && (file.mimeType || file.mimetype)) || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(name);
  if (ext === 'zip') return true;
  return !ext && ZIP_MIMES.has(mime);
}

/** Member → { kind: 'media'|'image'|'chat'|null, ext, canonicalMime }. */
function classifyMember(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const base = normalized.split('/').pop() || '';
  const ext = extOf(base);
  if (WHATSAPP_CHAT_RE.test(base)) return { kind: 'chat', ext, canonicalMime: 'text/plain' };
  if (!ext) return { kind: null, ext };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', ext, canonicalMime: IMAGE_CANONICAL.get(ext) };
  if (NOT_MEDIA_EXTENSIONS.has(ext)) return { kind: null, ext };
  // `.mts` is a camcorder clip (AVCHD, upper case / BDMV tree) or a TS module.
  if (ext === 'mts' && !/\.MTS$/.test(base) && !/BDMV\/STREAM\//i.test(normalized)) return { kind: null, ext };
  if (uploadPolicy.isMediaExtension(ext)) {
    return { kind: 'media', ext, canonicalMime: uploadPolicy.MEDIA_EXTENSION_MIME.get(ext) || 'application/octet-stream' };
  }
  return { kind: null, ext };
}

function isNoiseMember(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const base = normalized.split('/').pop() || '';
  return normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')
    || base.startsWith('.') || /^thumbs\.db$/i.test(base) || /(^|\/)node_modules\//.test(normalized) || /(^|\/)\.git\//.test(normalized);
}

/** A source-code archive: its images are icons and its sounds are assets. */
function looksLikeCodeArchive(entries) {
  let code = 0;
  for (const e of entries) {
    const normalized = String(e.name || '').replace(/\\/g, '/');
    if (/(^|\/)\.git\//.test(normalized)) return true;
    const base = (normalized.split('/').pop() || '').toLowerCase();
    if (!/(^|\/)node_modules\//.test(normalized) && CODE_MANIFESTS.has(base)) return true;
    if (CODE_EXTENSIONS.has(extOf(base))) code += 1;
    if (code >= 15) return true;
  }
  return false;
}

/** Visible name for the child: the member's basename, made safe. */
function displayNameFor(member, index, ext) {
  const base = String(member || '').replace(/\\/g, '/').split('/').pop() || '';
  let clean = base.replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').trim();
  if (clean.length > 180) {
    const suffix = ext ? `.${ext}` : '';
    clean = clean.slice(0, 180 - suffix.length) + suffix;
  }
  const safe = uploadPolicy.sanitizeFilename(clean);
  return safe && safe !== '.' && safe !== '..' ? safe : `archivo-${index + 1}${ext ? `.${ext}` : ''}`;
}

/** Deterministic child filename: same parent + member ⇒ same row (idempotent). */
function childFilenameFor(parentId, entryIndex, member, ext) {
  const hash = crypto.createHash('sha1').update(String(member)).digest('hex').slice(0, 10);
  const safeParent = String(parentId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'parent';
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext || '') ? `.${ext}` : '';
  return `archive-${safeParent}-${String(entryIndex).padStart(4, '0')}-${hash}${safeExt}`;
}

const WA_IOS_RE = /^\[([^\]]{6,40})\]\s+([^:]{1,80}):\s/;
const WA_ANDROID_RE = /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?)\s+-\s+([^:]{1,80}):\s/i;
const ATTACHMENT_TOKEN_RE = /[\p{L}\p{N}_.-]+\.[A-Za-z0-9]{2,5}/gu;

/**
 * Pure: WhatsApp chat text → Map(memberBasename → { at, sender }) for the
 * members the chat mentions (Android «… (archivo adjunto)», iOS
 * «<adjunto: …>»). Times stay as written: the export's locale decides the
 * day/month order.
 */
function parseWhatsAppAttachments(text, basenames) {
  const wanted = new Set(Array.from(basenames || []).map((n) => String(n)));
  const found = new Map();
  if (!wanted.size) return found;
  const lines = String(text || '').split(/\r?\n/);
  const limit = Math.min(lines.length, 200_000);
  for (let i = 0; i < limit && found.size < wanted.size; i += 1) {
    const line = lines[i].replace(/[‎‏‪-‮]/g, '');
    const m = WA_IOS_RE.exec(line) || WA_ANDROID_RE.exec(line);
    if (!m) continue;
    const tokens = line.slice(m[0].length).match(ATTACHMENT_TOKEN_RE) || [];
    for (const token of tokens) {
      if (wanted.has(token) && !found.has(token)) {
        found.set(token, { at: m[1].trim().slice(0, 40), sender: m[2].trim().slice(0, 80) });
      }
    }
  }
  return found;
}

// ── Readers ─────────────────────────────────────────────────────────────

function typedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** Counts bytes (fails past `limit`) and accumulates the CRC-32 when Node has it. */
function createByteGuard(limit) {
  const state = { bytes: 0, crc: 0 };
  const hasCrc = typeof zlib.crc32 === 'function';
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      state.bytes += chunk.length;
      if (state.bytes > limit) { cb(typedError('member_overflow', 'member larger than declared')); return; }
      if (hasCrc) state.crc = zlib.crc32(chunk, state.crc);
      cb(null, chunk);
    },
  });
  return { stream, state, hasCrc };
}

async function verifyWritten(state, hasCrc, entry) {
  if (Number.isFinite(entry.size) && state.bytes !== entry.size) throw typedError('size_mismatch');
  if (hasCrc && Number.isFinite(entry.crc32) && ((state.crc >>> 0) !== (entry.crc32 >>> 0))) throw typedError('crc_mismatch');
  return state.bytes;
}

async function openPizzipReader(zipPath) {
  const PizZip = require('pizzip');
  const buffer = await fsp.readFile(zipPath);
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (_) {
    throw typedError('archive_unreadable');
  }
  const entries = Object.values(zip.files).map((f, index) => {
    const data = f._data && typeof f._data === 'object' ? f._data : null;
    const perms = Number(f.unixPermissions);
    return {
      index,
      name: f.name,
      isDir: Boolean(f.dir) || /\/$/.test(f.name),
      isSymlink: Number.isFinite(perms) && (perms & 0o170000) === 0o120000,
      size: data && Number.isFinite(data.uncompressedSize) ? data.uncompressedSize : NaN,
      compressedSize: data && Number.isFinite(data.compressedSize) ? data.compressedSize : NaN,
      crc32: data && Number.isFinite(data.crc32) ? data.crc32 : NaN,
      handle: data,
    };
  });
  const rawOf = (entry) => {
    const data = entry.handle;
    if (!data || typeof data.getCompressedContent !== 'function') throw typedError('unsupported_entry');
    const method = data.compressionMethod;
    if (method !== DEFLATE && method !== STORE) throw typedError('unsupported_compression');
    const raw = data.getCompressedContent();
    return { raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), method };
  };
  return {
    kind: 'pizzip',
    entries,
    async extract(entry, dest, { signal } = {}) {
      const { raw, method } = rawOf(entry);
      const source = new PassThrough();
      source.end(raw);
      const guard = createByteGuard(entry.size);
      const stages = method === DEFLATE ? [source, zlib.createInflateRaw(), guard.stream] : [source, guard.stream];
      await pipeline(...stages, fs.createWriteStream(dest), { signal });
      return verifyWritten(guard.state, guard.hasCrc, entry);
    },
    async readText(entry, cap) {
      const { raw, method } = rawOf(entry);
      if (entry.size > cap) throw typedError('member_overflow');
      const out = method === DEFLATE ? zlib.inflateRawSync(raw, { maxOutputLength: cap }) : raw;
      return out.toString('utf8');
    },
    close() { zip = null; },
  };
}

// «    5000  Defl:N       22 100% 2026-10-16 15:29 acc63e2e  dir/name.opus»
const UNZIP_V_RE = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+%)\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]{8})\s+(.+)$/;

/** Pure: `unzip -v` stdout → entries. */
function parseUnzipVerbose(stdout) {
  const entries = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = UNZIP_V_RE.exec(line);
    if (!m) continue;
    const name = m[8];
    entries.push({
      index: entries.length,
      name,
      isDir: name.endsWith('/'),
      isSymlink: false,
      size: Number.parseInt(m[1], 10),
      compressedSize: Number.parseInt(m[3], 10),
      method: m[2],
      crc32: Number.parseInt(m[7], 16),
    });
  }
  return entries;
}

async function openUnzipReader(zipPath, { signal, unzipBin = 'unzip', spawnImpl = spawn, run = runMediaCommand } = {}) {
  const listing = await run(unzipBin, ['-v', zipPath], { signal, timeoutMs: 60_000, maxStdoutBytes: 16 * MB, spawnImpl });
  if (listing.missing) throw typedError('unzip_missing');
  if (listing.aborted) throw typedError('aborted');
  if (listing.timedOut || listing.stdoutTruncated || (listing.code !== 0 && listing.code !== 1)) throw typedError('archive_unreadable');
  const entries = parseUnzipVerbose(listing.stdout);
  const streamMember = (entry, sink, limit, { signal: memberSignal } = {}) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(unzipBin, ['-p', zipPath, escapeUnzipPattern(entry.name)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err && err.code === 'ENOENT' ? typedError('unzip_missing') : typedError('extract_failed'));
      return;
    }
    let exitCode = null;
    let failed = null;
    const exited = new Promise((done) => child.on('close', (code) => { exitCode = code; done(); }));
    child.on('error', (err) => { failed = err && err.code === 'ENOENT' ? typedError('unzip_missing') : typedError('extract_failed'); });
    const guard = createByteGuard(limit);
    pipeline(child.stdout, guard.stream, sink, { signal: memberSignal })
      .catch((err) => { failed = failed || err; try { child.kill('SIGKILL'); } catch (_) { /* gone */ } })
      .then(() => exited)
      .then(() => {
        if (failed) { reject(failed.code ? failed : typedError(memberSignal && memberSignal.aborted ? 'aborted' : 'extract_failed')); return; }
        if (exitCode !== 0 && exitCode !== 1) { reject(typedError('extract_failed')); return; }
        resolve(guard);
      });
  });
  return {
    kind: 'unzip',
    entries,
    async extract(entry, dest, { signal: memberSignal } = {}) {
      const guard = await streamMember(entry, fs.createWriteStream(dest), entry.size, { signal: memberSignal });
      return verifyWritten(guard.state, guard.hasCrc, entry);
    },
    async readText(entry, cap) {
      if (entry.size > cap) throw typedError('member_overflow');
      const chunks = [];
      const sink = new (require('node:stream').Writable)({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      await streamMember(entry, sink, Math.min(cap, entry.size), { signal });
      return Buffer.concat(chunks).toString('utf8');
    },
    close() {},
  };
}

// ── DocumentAnalysis metadata (merge, never clobber) ───────────────────

/**
 * Merge `patch` into DocumentAnalysis.metadata of a file the user owns.
 * Creates a `pending` row when none exists. Never throws; false on refusal.
 */
async function mergeAnalysisMetadata(prisma, { fileId, userId, patch, mimeType = null }) {
  try {
    if (!prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.upsert !== 'function') return false;
    let existing = null;
    if (typeof prisma.documentAnalysis.findUnique === 'function') {
      existing = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { userId: true, metadata: true } });
      if (existing && existing.userId !== userId) return false;
    }
    const base = existing && existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata : {};
    const metadata = { ...base, ...patch };
    await prisma.documentAnalysis.upsert({
      where: { fileId },
      create: { userId, fileId, status: 'pending', mimeType, metadata },
      update: { metadata },
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Re-apply the archive link after a pass that rewrites the analysis
 * metadata (document-intelligence on an image child). Never throws.
 */
function stampArchiveParent(prisma, { fileId, userId, archiveParent, mimeType = null }) {
  if (!fileId || !userId || !archiveParent || typeof archiveParent !== 'object') return Promise.resolve(false);
  return mergeAnalysisMetadata(prisma, { fileId, userId, patch: { archiveParent }, mimeType });
}

// ── Main ────────────────────────────────────────────────────────────────

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

async function defaultDetectMime(filePath) {
  try {
    const { fileTypeFromFile } = await import('file-type');
    const detected = await fileTypeFromFile(filePath);
    if (detected && detected.mime) return { mime: detected.mime, source: 'magic-bytes' };
  } catch (_) { /* fall through */ }
  return { mime: null, source: 'fallback' };
}

async function freeBytes(dir) {
  try {
    if (typeof fsp.statfs !== 'function') return Infinity;
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return Infinity;
  }
}

// Parents being expanded in this process: a resume never races a live run
// (both would write the same partials).
const activeExpansions = new Set();

/** Only ENOENT counts as missing (a permission error is not a lost file). */
function fileMissing(p) {
  return fsp.stat(p).then(() => false, (err) => Boolean(err && err.code === 'ENOENT'));
}

/** Undo a row whose file could not be moved in. Never throws. */
async function dropChildRow(prisma, id, logger) {
  try {
    if (typeof prisma.file.delete === 'function') {
      await prisma.file.delete({ where: { id } });
      return;
    }
  } catch (_) { /* reported below */ }
  try { logger.warn(`[archive-media] could not remove child row ${id} after a failed rename`); } catch (_) { /* best-effort */ }
}

/**
 * See the module header. Never throws. `attempt` is set by
 * resumeArchiveExpansions() and kept in the running marker.
 */
async function expandArchiveMedia({
  prisma, userId, parent, userDir, schedule = null, detectMime = defaultDetectMime,
  signal = null, env = process.env, limits = {}, logger = console, now = Date.now,
  unzipBin = 'unzip', spawnImpl = spawn, run = runMediaCommand, readerFactory = null, attempt = 0,
} = {}) {
  const startedAt = now();
  const children = [];
  const skipped = {};
  const out = { ok: false, children, skipped, truncated: false, whatsapp: false };
  let bytesWritten = 0;
  let reader = null;
  let claimed = null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const caps = resolveLimits(env, limits);
  const timer = setTimeout(() => controller.abort(), caps.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const finish = (fields = {}) => {
    Object.assign(out, fields);
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try { if (reader) reader.close(); } catch (_) { /* best-effort */ }
    if (claimed) activeExpansions.delete(claimed);
    if (out.reason === 'disabled') return out; // kill switch: silent
    try {
      const media = children.filter((c) => c.kind === 'media').length;
      const images = children.filter((c) => c.kind === 'image').length;
      const reused = children.filter((c) => c.reused).length;
      const skip = Object.entries(skipped).map(([k, v]) => `${k}:${v}`).join(',') || '-';
      const line = `[archive-media] parent=${(parent && parent.id) || '-'} ok=${out.ok} media=${media} images=${images} reused=${reused} `
        + `bytes=${bytesWritten} skip=${skip} truncated=${out.truncated} reason=${out.reason || '-'} elapsedMs=${Math.max(0, now() - startedAt)}`;
      if (out.ok) (logger.info || logger.log).call(logger, line);
      else logger.warn(line);
    } catch (_) { /* logging is best-effort */ }
    return out;
  };

  try {
    if (!isEnabled(env)) return finish({ reason: 'disabled' });
    if (!prisma || !prisma.file || typeof prisma.file.create !== 'function') return finish({ reason: 'no_database' });
    if (!userId || !parent || !parent.id || !parent.path || !userDir) return finish({ reason: 'invalid_input' });
    if (!isArchiveCandidate(parent)) return finish({ reason: 'not_archive' });
    if (activeExpansions.has(parent.id)) return finish({ reason: 'already_running' });
    claimed = parent.id;
    activeExpansions.add(claimed);
    const resolvedDir = path.resolve(String(userDir));
    const partsDir = path.join(resolvedDir, PARTS_DIR);
    const stat = await fsp.stat(parent.path).catch(() => null);
    if (!stat || !stat.isFile()) return finish({ reason: 'archive_missing' });
    if (typeof prisma.file.findFirst === 'function') {
      const owned = await prisma.file.findFirst({ where: { id: parent.id, userId, deletedAt: null }, select: { id: true } });
      if (!owned) return finish({ reason: 'parent_not_found' });
    }

    try {
      reader = readerFactory
        ? await readerFactory(parent.path, { size: stat.size, signal: controller.signal })
        : stat.size <= caps.pizzipMaxBytes
          ? await openPizzipReader(parent.path)
          : await openUnzipReader(parent.path, { signal: controller.signal, unzipBin, spawnImpl, run });
    } catch (err) {
      const code = (err && err.code) || 'archive_unreadable';
      if (code === 'unzip_missing') {
        try { logger.warn('[archive-media] unzip not available — large archives are not expanded (degraded)'); } catch (_) { /* best-effort */ }
      }
      return finish({ reason: code === 'aborted' ? 'aborted' : code });
    }

    const entries = Array.isArray(reader.entries) ? reader.entries : [];
    if (looksLikeCodeArchive(entries)) return finish({ ok: true, reason: 'code_archive' });

    // Selection: media first, then images, in archive order.
    const media = [];
    const images = [];
    let chatEntry = null;
    for (const entry of entries) {
      if (!entry || entry.isDir || !entry.name) continue;
      const cls = classifyMember(entry.name);
      if (!cls.kind) continue;
      if (isNoiseMember(entry.name)) continue;
      if (cls.kind === 'chat') { if (!chatEntry) chatEntry = entry; continue; }
      if (isUnsafeEntryName(entry.name)) { bump(skipped, 'unsafe_path'); continue; }
      if (entry.isSymlink) { bump(skipped, 'symlink'); continue; }
      if (!Number.isFinite(entry.size) || !Number.isFinite(entry.compressedSize)) { bump(skipped, 'unreadable_entry'); continue; }
      const memberCap = cls.kind === 'media' ? caps.maxMediaMemberBytes : caps.maxImageMemberBytes;
      const minBytes = cls.kind === 'media' ? caps.minMediaBytes : caps.minImageBytes;
      if (entry.size < minBytes) { bump(skipped, 'too_small'); continue; }
      if (entry.size > memberCap) { bump(skipped, 'too_large'); continue; }
      if (entry.size >= caps.ratioMinBytes
        && (entry.compressedSize <= 0 || entry.size / entry.compressedSize > caps.maxRatio)) {
        bump(skipped, 'suspicious_ratio');
        continue;
      }
      (cls.kind === 'media' ? media : images).push({ entry, cls });
    }
    const selected = [];
    let declaredTotal = 0;
    const take = (list, cap) => {
      let taken = 0;
      for (const item of list) {
        if (selected.length >= caps.maxMembers || taken >= cap) { bump(skipped, 'count_cap'); out.truncated = true; continue; }
        if (declaredTotal + item.entry.size > caps.maxBytes) { bump(skipped, 'total_cap'); out.truncated = true; continue; }
        declaredTotal += item.entry.size;
        selected.push(item);
        taken += 1;
      }
    };
    take(media, Infinity);
    take(images, caps.maxImages);
    if (selected.length === 0) return finish({ ok: true, reason: 'no_media' });

    // Member → its deterministic names: same parent + member ⇒ same row.
    const namesFor = ({ entry, cls }) => {
      const memberPath = String(entry.name).replace(/\\/g, '/');
      const filename = childFilenameFor(parent.id, entry.index, memberPath, cls.ext);
      // Inflated where the chunked-upload sweeper reclaims what a restart
      // abandons (`<userDir>/.parts/*.part`; its own parts are <32 hex>.part).
      return { memberPath, filename, target: path.join(resolvedDir, filename), partial: path.join(partsDir, `${filename}.part`) };
    };
    const sizeOnDisk = (p) => fsp.stat(p).then((s) => (s.isFile() ? s.size : 0), () => 0);

    // Members an interrupted run already turned into children (the running
    // marker's `processed`): one without a row now was deleted by the user,
    // and a resume does not bring it back.
    const previous = await readExpansionMarker(prisma, parent.id);
    // A resume has just claimed this marker: not reading it back means the
    // database did not answer, and without `processed` a deleted child
    // would come back.
    if (attempt > 0 && !previous) return finish({ reason: 'lookup_failed' });
    const processed = new Set(previous && previous.state === 'running' && Array.isArray(previous.processed)
      ? previous.processed.filter(Number.isInteger) : []);
    // What a member needs: its row is reused (also when the file was moved
    // to R2), the child was deleted, a row whose file never arrived (a
    // restart between the row and the rename) is filled again, or it is
    // extracted. The disk budget and the loop decide the same way.
    const memberState = async ({ entry }, names) => {
      if (path.dirname(path.resolve(names.target)) !== resolvedDir) return { action: 'unsafe' };
      // A repaired row goes to the caller's schedule(file, row): it carries
      // what a freshly created one does (owner, names, type, stage).
      let existing = null;
      if (typeof prisma.file.findFirst === 'function') {
        try {
          existing = await prisma.file.findFirst({
            where: { userId, filename: names.filename },
            select: {
              id: true, userId: true, filename: true, originalName: true, mimeType: true, size: true, path: true,
              deletedAt: true, processingStage: true,
            },
          });
        } catch (_) {
          // A lookup that fails (pool timeout, reset) is not «no row»: a
          // resume may already have one, and a second row would mean a
          // second transcription. A first run has none.
          if (attempt > 0) return { action: 'lookup_failed' };
        }
      }
      if (!existing) return { action: processed.has(entry.index) ? 'deleted' : 'extract' };
      if (existing.deletedAt || existing.path !== names.target || !(await fileMissing(names.target))) return { action: 'reuse', existing };
      return { action: 'repair', existing };
    };

    // Disk: never fill the uploads volume; keep a reserve for everyone else.
    // Only the bytes a member will still write are charged: nothing for a
    // reused or deleted child, less for one a restart half wrote, or a
    // resume would skip what fits.
    await fsp.mkdir(partsDir, { recursive: true });
    const free = await freeBytes(resolvedDir);
    if (Number.isFinite(free)) {
      let budget = free - caps.freeSpaceReserveBytes;
      for (let i = 0; i < selected.length; i += 1) {
        const names = namesFor(selected[i]);
        const { action } = await memberState(selected[i], names);
        // The database cannot say what is done: the marker stays running
        // (as the claim wrote it) and a later resume tries again.
        if (action === 'lookup_failed') return finish({ reason: 'lookup_failed' });
        if (action === 'extract' || action === 'repair') {
          const onDisk = Math.max(await sizeOnDisk(names.target), await sizeOnDisk(names.partial));
          budget -= Math.max(0, selected[i].entry.size - onDisk);
        }
        if (budget < 0) {
          bump(skipped, 'disk_space', selected.length - i);
          selected.length = i;
          out.truncated = true;
          break;
        }
      }
      if (selected.length === 0) return finish({ reason: 'disk_space' });
    }

    // WhatsApp context (sender + time of each attachment), best-effort.
    let waRefs = new Map();
    if (chatEntry && chatEntry.size <= caps.chatTextMaxBytes && !isUnsafeEntryName(chatEntry.name)) {
      try {
        const text = await reader.readText(chatEntry, caps.chatTextMaxBytes);
        const names = selected.map((s) => String(s.entry.name).replace(/\\/g, '/').split('/').pop());
        waRefs = parseWhatsAppAttachments(text, names);
        out.whatsapp = true;
      } catch (_) {
        bump(skipped, 'chat_unreadable');
      }
    }

    // Until the final record below, a restart leaves this marker behind and
    // resumeArchiveExpansions() finishes the job. Each child made (or found)
    // is added to `processed` as soon as it exists.
    const runningAt = new Date(now()).toISOString();
    const runningMarker = () => ({
      state: 'running', at: runningAt, ...(attempt > 0 ? { attempt } : {}), processed: [...processed].sort((a, b) => a - b),
    });
    const recordProcessed = async (index) => {
      if (processed.has(index)) return;
      processed.add(index);
      await mergeAnalysisMetadata(prisma, { fileId: parent.id, userId, patch: { archiveExpansion: runningMarker() } });
    };
    await mergeAnalysisMetadata(prisma, { fileId: parent.id, userId, patch: { archiveExpansion: runningMarker() } });

    const parentName = String(parent.originalName || parent.originalname || 'archivo.zip').slice(0, 200);
    let retryLater = false;
    for (let n = 0; n < selected.length; n += 1) {
      const { entry, cls } = selected[n];
      if (controller.signal.aborted) {
        bump(skipped, signal && signal.aborted ? 'aborted' : 'timeout', selected.length - n);
        out.truncated = true;
        break;
      }
      const names = namesFor(selected[n]);
      const { memberPath, filename, target, partial } = names;
      // Asked again here: the budget's answer may be minutes old.
      const state = await memberState(selected[n], names);
      if (state.action === 'lookup_failed') {
        // Stop here; the final record keeps the marker running.
        bump(skipped, 'lookup_failed', selected.length - n);
        out.truncated = true;
        retryLater = true;
        break;
      }
      if (state.action === 'unsafe') { bump(skipped, 'unsafe_path'); continue; }
      if (state.action === 'deleted') { bump(skipped, 'deleted_by_user'); continue; }
      if (state.action === 'reuse') {
        const { existing } = state;
        children.push({ fileId: existing.id, kind: cls.kind, member: memberPath.slice(0, 300), mimeType: existing.mimeType || null, size: existing.size || 0, reused: true });
        await recordProcessed(entry.index);
        continue;
      }
      let row = state.action === 'repair' ? state.existing : null;
      const repaired = Boolean(row);

      let written = 0;
      try {
        written = await reader.extract(entry, partial, { signal: controller.signal });
      } catch (err) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        const code = (err && err.code) || '';
        const reason = controller.signal.aborted ? (signal && signal.aborted ? 'aborted' : 'timeout')
          : code === 'member_overflow' || code === 'size_mismatch' || code === 'ERR_BUFFER_TOO_LARGE' ? 'size_mismatch'
            : code === 'crc_mismatch' ? 'crc_mismatch'
              : code === 'ENOSPC' ? 'disk_space'
                : 'extract_failed';
        bump(skipped, reason);
        if (reason === 'aborted' || reason === 'timeout' || reason === 'disk_space') {
          out.truncated = true;
          if (reason !== 'disk_space' || n === selected.length - 1) continue;
          bump(skipped, 'disk_space', selected.length - n - 1);
          break;
        }
        continue;
      }

      // Same byte-level check as a direct upload, on the partial.
      const displayName = displayNameFor(memberPath, n, cls.ext);
      let detected = { mime: null, source: 'fallback' };
      try { detected = (await detectMime(partial, cls.canonicalMime)) || detected; } catch (_) { /* fallback */ }
      const verdict = uploadPolicy.validateUploadPolicy({
        originalName: displayName,
        declaredMime: cls.canonicalMime,
        detectedMime: detected.mime || cls.canonicalMime,
        detectionSource: detected.source || (detected.mime ? 'magic-bytes' : 'fallback'),
        size: written,
        env,
      });
      const finalMime = verdict && verdict.ok ? String(verdict.mimeType || '').toLowerCase() : '';
      // Every real picture has magic bytes; a few audio formats (raw AC-3,
      // some AMR/CAF) do not, and the media worker re-validates them anyway.
      const magic = detected.source === 'magic-bytes' && Boolean(detected.mime);
      const kindOk = cls.kind === 'media'
        ? /^(audio|video)\//.test(finalMime)
        : magic && /^image\//.test(finalMime) && finalMime !== 'image/svg+xml';
      if (!verdict || !verdict.ok || !kindOk || verdict.executable || verdict.activeContent) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        bump(skipped, verdict && verdict.ok ? 'type_mismatch' : 'rejected_by_policy');
        continue;
      }

      const basename = memberPath.split('/').pop();
      const wa = waRefs.get(basename) || null;
      const archiveParent = {
        fileId: parent.id,
        name: parentName,
        member: memberPath.slice(0, 300),
        index: entry.index,
        kind: cls.kind,
        ...(wa ? { whatsapp: wa } : {}),
      };
      const initialStage = cls.kind === 'media' ? 'uploaded' : 'extracting';
      // Row first, then the rename: no extracted member ever sits in the
      // upload folder without its File row.
      if (!row) {
        try {
          row = await prisma.file.create({
            data: {
              userId,
              filename,
              originalName: displayName,
              mimeType: finalMime,
              size: Math.min(written, DB_FILE_SIZE_MAX),
              path: target,
              extractedText: null,
              openaiFileId: null,
              processingStage: initialStage,
              processingStageAt: new Date(now()),
            },
          });
        } catch (_) {
          await fsp.rm(partial, { force: true }).catch(() => {});
          bump(skipped, 'db_create_failed');
          continue;
        }
      }
      try {
        await fsp.rename(partial, target);
      } catch (_) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        if (!repaired) await dropChildRow(prisma, row.id, logger);
        bump(skipped, 'extract_failed');
        continue;
      }
      bytesWritten += written;
      if (repaired) {
        // While its file was missing, the media worker may have marked the
        // row failed (and a failed row is not queued again): the file is
        // here now, so it starts over like a new child. Owner-scoped.
        const restart = { processingStage: initialStage, processingStageAt: new Date(now()), processingError: null };
        if (typeof prisma.file.updateMany === 'function') {
          await prisma.file.updateMany({ where: { id: row.id, userId }, data: restart }).catch(() => {
            try { logger.warn(`[archive-media] could not reset the stage of repaired child ${row.id}`); } catch (_) { /* best-effort */ }
          });
        }
        row = {
          ...row,
          ...restart,
          userId,
          filename,
          originalName: row.originalName || displayName,
          mimeType: row.mimeType || finalMime,
        };
      }
      await mergeAnalysisMetadata(prisma, { fileId: row.id, userId, patch: { archiveParent }, mimeType: finalMime });
      children.push({ fileId: row.id, kind: cls.kind, member: memberPath.slice(0, 300), mimeType: finalMime, size: written, ...(repaired ? { repaired: true } : {}) });
      await recordProcessed(entry.index);
      if (typeof schedule === 'function') {
        try {
          await schedule({
            path: target,
            filename,
            originalname: displayName,
            mimetype: finalMime,
            size: written,
            fieldname: 'files',
            archiveParent,
            // While its file was missing, the media queue may have kept a
            // failed job for this row: the caller queues it as a retry.
            ...(repaired ? { repaired: true } : {}),
          }, row);
        } catch (err) {
          try { logger.warn(`[archive-media] schedule failed for child ${row.id} (${(err && err.code) || 'error'})`); } catch (_) { /* best-effort */ }
        }
      }
    }

    const aborted = Boolean(signal && signal.aborted);
    // A caller's abort (a shutdown) or a lookup that failed stays
    // resumable; a timeout is final.
    const resumable = aborted || retryLater;
    await mergeAnalysisMetadata(prisma, {
      fileId: parent.id,
      userId,
      patch: {
        archiveExpansion: {
          state: resumable ? 'running' : 'done',
          ...(attempt > 0 ? { attempt } : {}),
          ...(resumable ? { processed: runningMarker().processed } : {}),
          at: new Date(now()).toISOString(),
          children: children.slice(0, 200).map((c) => ({ fileId: c.fileId, kind: c.kind })),
          media: children.filter((c) => c.kind === 'media').length,
          images: children.filter((c) => c.kind === 'image').length,
          skipped: { ...skipped },
          truncated: out.truncated,
          whatsapp: out.whatsapp,
        },
      },
    });
    return finish({
      ok: !resumable,
      ...(aborted ? { reason: 'aborted' } : retryLater ? { reason: 'lookup_failed' } : controller.signal.aborted ? { reason: 'timeout' } : {}),
    });
  } catch (err) {
    try { logger.warn(`[archive-media] internal error (${(err && (err.code || err.name)) || 'error'})`); } catch (_) { /* best-effort */ }
    return finish({ ok: false, reason: 'internal_error' });
  }
}

// A resumed run that stops on one of these will never get further.
const PERMANENT_RESUME_FAILURES = new Set([
  'invalid_input', 'not_archive', 'archive_missing', 'parent_not_found', 'archive_unreadable', 'code_archive', 'no_media',
]);

async function readExpansionMarker(prisma, fileId) {
  try {
    const row = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { metadata: true } });
    const marker = row && row.metadata && row.metadata.archiveExpansion;
    return marker && typeof marker === 'object' ? marker : null;
  } catch (_) {
    return null;
  }
}

/**
 * Claim an interrupted parent: one owner-scoped compare-and-set on the
 * marker's `at` (unchanged since `seen` was read) writes `fields` (the
 * attempt and a fresh `at`). True only for the process whose write landed.
 * Never throws.
 */
async function claimExpansion(prisma, row, seen, fields) {
  try {
    const fresh = await prisma.documentAnalysis.findUnique({ where: { fileId: row.fileId }, select: { userId: true, metadata: true } });
    const base = fresh && fresh.userId === row.userId && fresh.metadata && typeof fresh.metadata === 'object' && !Array.isArray(fresh.metadata)
      ? fresh.metadata : null;
    const current = base && base.archiveExpansion;
    if (!current || current.state !== 'running' || current.at !== seen.at) return false;
    const result = await prisma.documentAnalysis.updateMany({
      where: { fileId: row.fileId, userId: row.userId, metadata: { path: ['archiveExpansion', 'at'], equals: seen.at } },
      data: { metadata: { ...base, archiveExpansion: { ...current, ...fields } } },
    });
    return Boolean(result && result.count === 1);
  } catch (_) {
    return false;
  }
}

/**
 * A `running` marker younger than this may belong to a live run of another
 * process: a run ends within the expansion timeout of its start (`at`), so
 * the default is that timeout + 5 min.
 */
function resumeMinAgeMs(env = process.env, limits = {}, minAgeMs = null) {
  return minAgeMs != null && Number.isFinite(Number(minAgeMs))
    ? Math.max(0, Number(minAgeMs))
    : resolveLimits(env, limits).timeoutMs + 5 * 60 * 1000;
}

/**
 * Finish the expansions a restart interrupted: parents whose
 * `archiveExpansion.state` is still `running` are expanded again (rows
 * already made are reused, a row whose file never arrived is filled, a
 * `processed` member whose row is gone was deleted by the user and is
 * skipped as `deleted_by_user`). routes/files.js runs it after boot
 * through startArchiveExpansionResume(), with the same `resolveUserDir`,
 * `detectMime` and `schedule` as an upload. `minAgeMs` (default:
 * resumeMinAgeMs()) keeps a live run of another process out; those skipped
 * for age are counted in `recent` (and in `skipped`). Before running, a
 * parent is claimed with a compare-and-set on the marker's `at`, which the
 * claim refreshes: when several processes resume at once only one runs it,
 * and the others see a recent marker. Each claim counts an attempt, so a
 * run that kills the process counts too; past `maxAttempts`, or on a
 * failure that cannot heal (archive gone, parent deleted), the marker
 * becomes `abandoned`. A lookup the database does not answer (the parent,
 * the marker, a member) is not a lost parent: the marker stays running for
 * a later pass (`retry`). A repaired child reaches `schedule(file, row)`
 * with `file.repaired = true`. The parent is not offloaded to R2 here.
 * Never throws; logs counts only.
 */
async function resumeArchiveExpansions({
  prisma, resolveUserDir, schedule = null, detectMime = defaultDetectMime, env = process.env, limits = {},
  logger = console, now = Date.now, minAgeMs = null, maxAttempts = 3, limit = 20,
  unzipBin = 'unzip', spawnImpl = spawn, run = runMediaCommand, readerFactory = null,
} = {}) {
  const summary = { ok: false, found: 0, resumed: 0, retry: 0, abandoned: 0, skipped: 0, recent: 0 };
  if (!isEnabled(env)) return { ...summary, reason: 'disabled' };
  if (!prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.findMany !== 'function'
    || typeof prisma.documentAnalysis.updateMany !== 'function'
    || !prisma.file || typeof prisma.file.findFirst !== 'function' || typeof resolveUserDir !== 'function') {
    return { ...summary, reason: 'invalid_input' };
  }
  const minAge = resumeMinAgeMs(env, limits, minAgeMs);
  let rows = [];
  try {
    rows = await prisma.documentAnalysis.findMany({
      where: { metadata: { path: ['archiveExpansion', 'state'], equals: 'running' } },
      select: { fileId: true, userId: true, metadata: true },
      take: Math.max(1, Math.min(200, Number(limit) || 20)),
    });
  } catch (_) {
    return { ...summary, reason: 'query_failed' };
  }
  summary.found = rows.length;
  for (const row of rows) {
    const marker = row && row.metadata && row.metadata.archiveExpansion;
    if (!marker || marker.state !== 'running' || !row.userId || activeExpansions.has(row.fileId)) { summary.skipped += 1; continue; }
    const mark = (fields) => mergeAnalysisMetadata(prisma, {
      fileId: row.fileId, userId: row.userId, patch: { archiveExpansion: { ...marker, ...fields } },
    });
    // Every running marker this module writes has its start time; without
    // one it cannot be claimed safely, nor can it be a live run.
    const at = typeof marker.at === 'string' ? Date.parse(marker.at) : NaN;
    if (!Number.isFinite(at)) {
      await mark({ state: 'abandoned', reason: 'invalid_marker', at: new Date(now()).toISOString() });
      summary.abandoned += 1;
      continue;
    }
    if (now() - at < minAge) { summary.skipped += 1; summary.recent += 1; continue; }
    const attempt = (Number(marker.attempt) || 0) + 1;
    if (attempt > maxAttempts) {
      await mark({ state: 'abandoned', reason: 'max_attempts', at: new Date(now()).toISOString() });
      summary.abandoned += 1;
      continue;
    }
    if (!(await claimExpansion(prisma, row, marker, { attempt, at: new Date(now()).toISOString() }))) {
      summary.skipped += 1; // another process claimed it first
      continue;
    }
    // A lookup that fails (pool timeout, reset) is not «parent gone»: the
    // parent stays running and is retried (the attempt counter bounds it).
    let lookupFailed = false;
    const parent = await prisma.file.findFirst({
      where: { id: row.fileId, userId: row.userId, deletedAt: null },
      select: { id: true, originalName: true, mimeType: true, path: true },
    }).catch(() => { lookupFailed = true; return null; });
    let userDir = null;
    try { userDir = resolveUserDir(row.userId); } catch (_) { userDir = null; }
    const result = parent && userDir
      ? await expandArchiveMedia({
        prisma, userId: row.userId, parent, userDir, schedule, detectMime, env, limits, logger, now, attempt,
        unzipBin, spawnImpl, run, readerFactory,
      })
      : { reason: lookupFailed ? 'lookup_failed' : parent ? 'invalid_input' : 'parent_not_found' };
    const after = await readExpansionMarker(prisma, row.fileId);
    if (after && after.state === 'running') {
      if (PERMANENT_RESUME_FAILURES.has(result.reason)) {
        await mark({ state: 'abandoned', reason: result.reason, attempt, at: new Date(now()).toISOString() });
        summary.abandoned += 1;
      } else {
        summary.retry += 1;
      }
    } else {
      summary.resumed += 1;
    }
  }
  summary.ok = true;
  if (summary.found > 0) logResumeSummary(logger, summary);
  return summary;
}

/** One line of counts (never names): `[archive-media] resume found=… …`. */
function logResumeSummary(logger, summary) {
  try {
    const line = `[archive-media] resume found=${summary.found || 0} resumed=${summary.resumed || 0} retry=${summary.retry || 0} `
      + `abandoned=${summary.abandoned || 0} skipped=${summary.skipped || 0} recent=${summary.recent || 0}${summary.reason ? ` reason=${summary.reason}` : ''}`;
    if (summary.ok) (logger.info || logger.log).call(logger, line);
    else logger.warn(line);
  } catch (_) { /* best-effort */ }
}

/**
 * SIRAGPT_ARCHIVE_MEDIA_RESUME: the pass after boot. Default ON; OFF under
 * NODE_ENV=test unless set to '1', and off whenever SIRAGPT_ARCHIVE_MEDIA
 * switches the expansion itself off.
 */
function isResumeEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_ARCHIVE_MEDIA_RESUME) ?? '').trim();
  if (/^(0|false|off|no)$/i.test(raw) || !isEnabled(env || {})) return false;
  if (/^(1|true|on|yes)$/i.test(raw)) return true;
  return String((env && env.NODE_ENV) || '') !== 'test';
}

const BOOT_RESUME_DELAY_MS = 90 * 1000;
// After the minimum age: the second pass sees every pre-boot marker as old.
const BOOT_RESUME_SETTLE_MS = 30 * 1000;

/**
 * resumeArchiveExpansions() after boot: unref'd timers, fire-and-forget,
 * never throws, one summary line of counts per pass. A first pass a little
 * after boot (after the chunked-upload sweeper's first run) finishes what
 * earlier restarts left. The run this restart interrupted started less than
 * the minimum age ago, so when a pass skipped `recent` markers, exactly one
 * more pass runs at boot + minimum age + 30 s: every run interrupted by
 * this restart started before boot and is old enough then, while a live run
 * of another process is still younger than the minimum age. `options` go
 * to the resume as they are; leave `minAgeMs` out. Returns the first timer,
 * or null when switched off.
 */
function startArchiveExpansionResume({
  env = process.env, logger = console, delayMs = BOOT_RESUME_DELAY_MS, setTimer = setTimeout, now = Date.now, ...options
} = {}) {
  if (!isResumeEnabled(env)) return null;
  const arm = (fn, ms) => {
    const timer = setTimer(() => { fn().catch(() => {}); }, Math.max(0, Number(ms) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer || null;
  };
  let settledAt = NaN;
  const runPass = async (last) => {
    let summary;
    try {
      summary = await resumeArchiveExpansions({ ...options, env, logger, now });
    } catch (_) {
      summary = { ok: false, found: 0, reason: 'internal_error' };
    }
    // The resume already logged when it found something.
    if (!summary || !summary.ok || !(summary.found > 0)) logResumeSummary(logger, summary || { ok: false, reason: 'internal_error' });
    if (last || !summary || !(summary.recent > 0) || !Number.isFinite(settledAt)) return;
    try { arm(() => runPass(true), settledAt - now()); } catch (_) { /* best-effort */ }
  };
  try {
    settledAt = now() + resumeMinAgeMs(env, options.limits || {}, options.minAgeMs) + BOOT_RESUME_SETTLE_MS;
  } catch (_) { settledAt = NaN; /* no second pass */ }
  try {
    return arm(() => runPass(false), delayMs);
  } catch (_) {
    return null;
  }
}

module.exports = {
  expandArchiveMedia,
  resumeArchiveExpansions,
  startArchiveExpansionResume,
  isResumeEnabled,
  stampArchiveParent,
  mergeAnalysisMetadata,
  isArchiveCandidate,
  isEnabled,
  // Pure helpers (tests).
  classifyMember,
  looksLikeCodeArchive,
  parseWhatsAppAttachments,
  parseUnzipVerbose,
  childFilenameFor,
  displayNameFor,
  resolveLimits,
  openPizzipReader,
  openUnzipReader,
};
