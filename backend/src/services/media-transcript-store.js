'use strict';

/**
 * media-transcript-store — durable home of a media transcription's SEGMENTS.
 *
 * File.extractedText keeps readable text; File has no Json column, and the
 * segments of a 5-hour recording (≈ 3-6 k entries, 0.5-1 MB of JSON) must not
 * live in the database. They go to a gzip sidecar next to the uploads:
 *
 *   <UPLOAD_DIR>/.transcripts/<fileId>.json.gz
 *   { version: 1, fileId, userId, language, durationSec, providers, engine,
 *     coverage, gaps, partial, segments: [{ s, e, t, spk?, conf? }], createdAt,
 *     timeOffsetSec? }
 *
 * plus a small pointer + stats in DocumentAnalysis.metadata
 * ({ kind: 'media_transcript', sidecar, durationSec, providers, coverage,
 *    speakers, segmentCount, language, partial, gaps, engine }). That row is
 * written as `pending`: it holds no chunks, so document-intelligence still
 * builds the real analysis (chunks, summary) from File.extractedText the
 * first time someone asks for it.
 *
 * A clip cut from a longer recording (a link section «del minuto 60 al 90»)
 * has its offset on the recording's clock recorded next to the sidecar
 * (<fileId>.clip.json) before its job is queued, so a job lost and re-queued
 * with only { fileId, userId } still stores the transcript on that clock.
 *
 * The sidecar path is derived from the fileId (never read from the database),
 * so a later document-intelligence pass that rewrites `metadata` cannot point
 * a reader at another file. Reads are owner-scoped: the File row must belong to
 * the user and not be deleted. `/uploads` never serves this directory: its
 * first path segment starts with a dot (see upload-static-access). Deleting
 * the file (route, account scrub) removes both files (`purgeMediaTranscript`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { normalizeTranscriptResult, speakerLabels } = require('./media-transcript-format');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const SIDECAR_VERSION = 1;
const SIDECAR_DIRNAME = '.transcripts';
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// A 5-hour transcript is ~1 MB of JSON; anything far beyond is not ours.
const MAX_SIDECAR_JSON_BYTES = 64 * 1024 * 1024;
const MAX_GAPS_IN_METADATA = 200;
const CLIP_RECORD_VERSION = 1;
// Same ceiling as a delivery's offset: a week of recording clock.
const MAX_CLIP_OFFSET_SEC = 7 * 24 * 3600;

function transcriptsRoot(env = process.env) {
  return path.join(path.resolve(env.UPLOAD_DIR || 'uploads'), SIDECAR_DIRNAME);
}

function rootOf(opts = {}) {
  return opts.root ? path.resolve(opts.root) : transcriptsRoot(opts.env || process.env);
}

function isValidFileId(fileId) {
  return typeof fileId === 'string' && FILE_ID_RE.test(fileId);
}

/** Absolute sidecar path for a fileId; throws on an id that is not a plain token. */
function sidecarPathFor(fileId, opts = {}) {
  if (!isValidFileId(fileId)) {
    const err = new Error('media-transcript-store: invalid fileId');
    err.code = 'INVALID_FILE_ID';
    throw err;
  }
  return path.join(rootOf(opts), `${fileId}.json.gz`);
}

/** Absolute path of a clip's offset record; throws like `sidecarPathFor`. */
function clipRecordPathFor(fileId, opts = {}) {
  sidecarPathFor(fileId, opts);
  return path.join(rootOf(opts), `${fileId}.clip.json`);
}

/** A finite offset in [0, a week], rounded to milliseconds; anything else is 0. */
function normalizeOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round3(Math.min(n, MAX_CLIP_OFFSET_SEC));
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Engine segment → compact { s, e, t, spk?, conf? }. */
function compactSegment(seg) {
  const out = { s: round3(seg.start), e: round3(seg.end), t: seg.text };
  if (seg.speaker != null) out.spk = seg.speaker;
  if (seg.confidence != null) out.conf = round3(seg.confidence);
  return out;
}

/** Compact sidecar segment → engine shape { start, end, text, speaker?, confidence? }. */
function expandSegment(seg) {
  const out = { start: Number(seg.s) || 0, end: Number(seg.e) || 0, text: String(seg.t == null ? '' : seg.t) };
  if (seg.spk != null) out.speaker = seg.spk;
  if (seg.conf != null && Number.isFinite(Number(seg.conf))) out.confidence = Number(seg.conf);
  return out;
}

/**
 * Engine result → sidecar object (pure). A text-only (legacy) result is kept as
 * ONE synthetic segment spanning the duration and flagged `synthetic: true`, so
 * the formatter renders it as plain text instead of inventing timestamps.
 */
function buildSidecar({ fileId, userId, result }, { now = new Date() } = {}) {
  const meta = normalizeTranscriptResult(result);
  let segments = meta.segments.filter((s) => s.text).map(compactSegment);
  let synthetic = false;
  if (!segments.length && meta.text) {
    segments = [{ s: 0, e: round3(meta.durationSec || 0), t: meta.text }];
    synthetic = true;
  }
  const sidecar = {
    version: SIDECAR_VERSION,
    fileId,
    userId,
    language: meta.language,
    durationSec: meta.durationSec == null ? null : round3(meta.durationSec),
    providers: meta.providers,
    engine: meta.engine,
    coverage: meta.coverage == null ? null : round3(meta.coverage),
    gaps: meta.gaps.map((g) => ({ start: round3(g.start), end: round3(g.end), reason: g.reason })),
    partial: meta.partial,
    segments,
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  if (synthetic) sidecar.synthetic = true;
  if (meta.timeOffsetSec > 0) sidecar.timeOffsetSec = round3(meta.timeOffsetSec);
  return sidecar;
}

/**
 * Write the sidecar atomically (temp file + rename) and return
 * { sidecarPath, bytes, segmentCount, sidecar }. Throws on a bad fileId, a
 * missing userId or a failed write — the caller decides whether that is fatal.
 */
async function writeSidecar({ fileId, userId, result }, opts = {}) {
  if (!userId) throw new Error('media-transcript-store: userId required');
  const target = sidecarPathFor(fileId, opts);
  const sidecar = buildSidecar({ fileId, userId: String(userId), result }, opts);
  const body = await gzip(Buffer.from(JSON.stringify(sidecar), 'utf8'));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { sidecarPath: target, bytes: body.length, segmentCount: sidecar.segments.length, sidecar };
}

function isValidSidecar(value, fileId) {
  return Boolean(value)
    && typeof value === 'object'
    && value.version === SIDECAR_VERSION
    && value.fileId === fileId
    && typeof value.userId === 'string'
    && Array.isArray(value.segments);
}

/**
 * Raw sidecar object (compact segments) or null when it is missing, corrupt,
 * oversized, of another version, or written for another fileId. Never throws.
 */
async function readSidecar(fileId, opts = {}) {
  let target;
  try {
    target = sidecarPathFor(fileId, opts);
  } catch (_) {
    return null;
  }
  let raw;
  try {
    raw = await fs.promises.readFile(target);
  } catch (_) {
    return null;
  }
  try {
    const json = await gunzip(raw, { maxOutputLength: MAX_SIDECAR_JSON_BYTES });
    const parsed = JSON.parse(json.toString('utf8'));
    return isValidSidecar(parsed, fileId) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Remove a sidecar; true when one existed. Never throws on a missing file. */
async function deleteSidecar(fileId, opts = {}) {
  let target;
  try {
    target = sidecarPathFor(fileId, opts);
  } catch (_) {
    return false;
  }
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Remove everything stored for a file's transcript: the sidecar and a clip's
 * offset record. Never throws (a delete route or the account scrub must not
 * fail on it); reports what existed and, when an unlink failed for any reason
 * but absence (EACCES, EBUSY, EIO…), `error` with its code, so the caller can
 * log it and retry instead of taking the transcript for gone.
 */
async function purgeMediaTranscript(fileId, opts = {}) {
  const out = { sidecar: false, clip: false };
  if (!isValidFileId(fileId)) return out;
  try {
    out.sidecar = await deleteSidecar(fileId, opts);
  } catch (err) {
    out.error = (err && err.code) || 'unlink_failed';
  }
  try {
    await fs.promises.unlink(clipRecordPathFor(fileId, opts));
    out.clip = true;
  } catch (err) {
    if (!(err && err.code === 'ENOENT') && !out.error) out.error = (err && err.code) || 'unlink_failed';
  }
  return out;
}

/**
 * Durably record where a clip starts on its recording's clock (seconds).
 * Written before the clip's job is queued; the media queue reads it back when
 * a job arrives without `timeOffsetSec`. An offset of 0 removes the record.
 * With `prisma`, the File row must be the user's and not deleted. Never
 * throws: { ok, timeOffsetSec } or { ok: false, reason }.
 */
async function recordMediaClipOffset({ fileId, userId, timeOffsetSec, prisma = null, ...opts } = {}) {
  if (!userId || !isValidFileId(fileId)) return { ok: false, reason: 'invalid' };
  const owner = String(userId);
  if (prisma && prisma.file && typeof prisma.file.findFirst === 'function') {
    let file = null;
    try {
      file = await prisma.file.findFirst({ where: { id: fileId, userId: owner, deletedAt: null }, select: { id: true } });
    } catch (_) {
      return { ok: false, reason: 'lookup_failed' };
    }
    if (!file) return { ok: false, reason: 'not_found' };
  }
  const offset = normalizeOffset(timeOffsetSec);
  const target = clipRecordPathFor(fileId, opts);
  if (!offset) {
    await fs.promises.unlink(target).catch(() => {});
    return { ok: true, timeOffsetSec: 0 };
  }
  const body = JSON.stringify({ version: CLIP_RECORD_VERSION, fileId, userId: owner, timeOffsetSec: offset, recordedAt: new Date().toISOString() });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, target);
  } catch (_) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, timeOffsetSec: offset };
}

/**
 * The clip offset (seconds) for a file of `userId`: its offset record, else
 * the offset its last sidecar was written with (a gap retry of a clip), else
 * 0. Records of another user or file count as absent. Never throws.
 */
async function readMediaClipOffset({ fileId, userId, ...opts } = {}) {
  if (!userId || !isValidFileId(fileId)) return 0;
  const owner = String(userId);
  try {
    const raw = await fs.promises.readFile(clipRecordPathFor(fileId, opts), 'utf8');
    const record = JSON.parse(raw);
    if (record && record.version === CLIP_RECORD_VERSION && record.fileId === fileId && record.userId === owner) {
      return normalizeOffset(record.timeOffsetSec);
    }
  } catch (_) { /* no record: fall back to the sidecar */ }
  const sidecar = await readSidecar(fileId, opts);
  return sidecar && sidecar.userId === owner ? normalizeOffset(sidecar.timeOffsetSec) : 0;
}

/** Sidecar → engine-shaped result the formatter accepts directly. */
function normalizeSidecar(sidecar, extra = {}) {
  if (!sidecar) return null;
  const timeOffsetSec = normalizeOffset(sidecar.timeOffsetSec);
  return {
    ok: true,
    version: sidecar.version,
    fileId: sidecar.fileId,
    userId: sidecar.userId,
    language: sidecar.language || null,
    durationSec: sidecar.durationSec == null ? null : Number(sidecar.durationSec),
    providers: sidecar.providers && typeof sidecar.providers === 'object' ? sidecar.providers : {},
    engine: sidecar.engine || null,
    coverage: sidecar.coverage == null ? null : Number(sidecar.coverage),
    gaps: Array.isArray(sidecar.gaps) ? sidecar.gaps : [],
    partial: sidecar.partial === true,
    synthetic: sidecar.synthetic === true,
    segments: sidecar.segments.map(expandSegment),
    createdAt: sidecar.createdAt || null,
    ...(timeOffsetSec ? { timeOffsetSec } : {}),
    ...extra,
  };
}

/**
 * Owner-scoped load: the File row must belong to `userId` and not be deleted,
 * and the sidecar must have been written for that same file and user. Returns
 * the normalized transcript ({ ok, fileId, fileName, segments:[{start,end,text,
 * speaker?,confidence?}], gaps, durationSec, language, providers, engine,
 * coverage, partial, synthetic, createdAt }) or null.
 */
async function loadMediaTranscript(prisma, { userId, fileId } = {}, opts = {}) {
  if (!userId || !isValidFileId(fileId) || !prisma || !prisma.file || typeof prisma.file.findFirst !== 'function') return null;
  let file;
  try {
    file = await prisma.file.findFirst({
      where: { id: fileId, userId: String(userId), deletedAt: null },
      select: { id: true, originalName: true, filename: true, mimeType: true },
    });
  } catch (_) {
    return null;
  }
  if (!file) return null;
  const sidecar = await readSidecar(fileId, opts);
  if (!sidecar || sidecar.userId !== String(userId)) return null;
  return normalizeSidecar(sidecar, {
    fileName: file.originalName || file.filename || null,
    mimeType: file.mimeType || null,
  });
}

/** Relative pointer stored in the database («.transcripts/<fileId>.json.gz»), never an absolute path. */
function sidecarPointer(sidecarPath, fileId) {
  const base = sidecarPath ? path.basename(String(sidecarPath)) : (isValidFileId(fileId) ? `${fileId}.json.gz` : null);
  return base ? `${SIDECAR_DIRNAME}/${base}` : null;
}

/** DocumentAnalysis.metadata for a media transcript (pure). */
function mediaTranscriptMetadata(result, { sidecarPath, fileId } = {}) {
  const meta = normalizeTranscriptResult(result);
  const speakers = speakerLabels(meta.segments).count;
  const offset = meta.timeOffsetSec > 0 ? { timeOffsetSec: round3(meta.timeOffsetSec) } : {};
  return {
    kind: 'media_transcript',
    sidecar: sidecarPointer(sidecarPath, fileId),
    durationSec: meta.durationSec == null ? null : round3(meta.durationSec),
    providers: meta.providers,
    coverage: meta.coverage == null ? null : round3(meta.coverage),
    speakers,
    segmentCount: meta.segments.filter((s) => s.text).length,
    language: meta.language,
    partial: meta.partial,
    gaps: meta.gaps.slice(0, MAX_GAPS_IN_METADATA).map((g) => ({ start: round3(g.start), end: round3(g.end), reason: g.reason })),
    engine: meta.engine,
    ...offset,
  };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Transcript text length (charCount column): segments joined, or the legacy text. */
function transcriptCharCount(result) {
  const meta = normalizeTranscriptResult(result);
  if (meta.legacy) return meta.text.length;
  return meta.segments.filter((s) => s.text).map((s) => s.text).join(' ').length;
}

/**
 * Upsert the media transcript pointer + stats into DocumentAnalysis (keyed by
 * the unique fileId). Only columns of the model are written; existing metadata
 * keys from document-intelligence are preserved and the media keys win. The big
 * segments array is NEVER stored here. Returns the row, or null when the file
 * is not the user's / is deleted, or a row for this file belongs to someone else.
 *
 * The row is `pending`, never `ready`: it has no chunks or summary, and
 * document-intelligence serves any `ready` row as a finished analysis (0
 * chunks, no summary — «the file is empty»). `pending` also invalidates an
 * analysis of the previous text when a gap retry replaces the transcript.
 */
async function upsertMediaTranscriptAnalysis(prisma, { fileId, userId, result, sidecarPath, mimeType } = {}) {
  if (!prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.upsert !== 'function') return null;
  if (!userId || !isValidFileId(fileId)) return null;
  const owner = String(userId);
  let fileMime = mimeType || null;
  if (prisma.file && typeof prisma.file.findFirst === 'function') {
    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: owner, deletedAt: null },
      select: { id: true, mimeType: true },
    });
    if (!file) return null;
    fileMime = fileMime || file.mimeType || null;
  }
  let existing = null;
  if (typeof prisma.documentAnalysis.findUnique === 'function') {
    existing = await prisma.documentAnalysis.findUnique({
      where: { fileId },
      select: { userId: true, metadata: true },
    });
    if (existing && existing.userId !== owner) return null;
  }
  const media = mediaTranscriptMetadata(result, { sidecarPath, fileId });
  const metadata = { ...plainObject(existing && existing.metadata), ...media };
  const language = media.language ? String(media.language).slice(0, 32) : null;
  const charCount = transcriptCharCount(result);
  return prisma.documentAnalysis.upsert({
    where: { fileId },
    create: {
      userId: owner,
      fileId,
      status: 'pending',
      language,
      mimeType: fileMime,
      charCount,
      metadata,
    },
    update: {
      status: 'pending',
      language,
      charCount,
      metadata,
    },
  });
}

module.exports = {
  writeSidecar,
  readSidecar,
  deleteSidecar,
  purgeMediaTranscript,
  loadMediaTranscript,
  upsertMediaTranscriptAnalysis,
  recordMediaClipOffset,
  readMediaClipOffset,
  // helpers (pure) for callers and tests
  buildSidecar,
  normalizeSidecar,
  mediaTranscriptMetadata,
  sidecarPathFor,
  clipRecordPathFor,
  transcriptsRoot,
  SIDECAR_VERSION,
  SIDECAR_DIRNAME,
};
