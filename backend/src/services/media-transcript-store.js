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
 *     timeOffsetSec?,
 *     // optional, written only when the result carries them (contract C5):
 *     source?: 'asr' | 'subtitles' | 'onscreen', quality?, audioStream?,
 *     hints?, embeddedSubtitles?: { language, codec, segments: [{ s, e, t }] },
 *     onScreenText?: [{ s, e, t, c? }], cleanup? }
 *
 * The version stays 1: every new field is optional and a reader that does not
 * know it ignores it (an older process during a deploy reads the sidecar as
 * before). `normalizeSidecar` bounds every list again on read.
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
const {
  normalizeTranscriptResult, speakerLabels, normalizeQuality, normalizeTimedTextList, normalizeEmbeddedSubtitles,
  normalizeCleanupStats, normalizeSource, normalizeMediaHints, normalizeHintLanguage,
} = require('./media-transcript-format');

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
  Object.assign(sidecar, sidecarExtras(result, meta));
  return sidecar;
}

/** Engine `audioStream` → { streamOrdinal, reason, index?, language? } or null. */
function normalizeAudioStream(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ordinal = Number(raw.streamOrdinal);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1000) return null;
  const out = { streamOrdinal: ordinal, reason: String(raw.reason || '').replace(/[^\w.-]+/g, '_').slice(0, 40) || null };
  const index = Number(raw.index);
  if (Number.isInteger(index) && index >= 0 && index <= 10000) out.index = index;
  const language = normalizeHintLanguage(raw.language);
  if (language) out.language = language;
  return out;
}

/** Hints stored with a transcript: { language?, terms?, speakers?, verbatim? } or null. */
function normalizeStoredHints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hints = normalizeMediaHints(raw) || {};
  const language = normalizeHintLanguage(raw.language);
  const out = { ...(language ? { language } : {}), ...hints };
  return Object.keys(out).length ? out : null;
}

/**
 * Optional C5 fields of a result, bounded and compacted for the sidecar.
 * Written only when present, so a plain ASR result keeps the exact v1 shape.
 */
function sidecarExtras(result, meta = normalizeTranscriptResult(result)) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const out = {};
  if (meta.source) out.source = meta.source;
  if (meta.subtitleOrigin) out.subtitleOrigin = meta.subtitleOrigin;
  if (meta.quality) out.quality = meta.quality;
  const audioStream = normalizeAudioStream(r.audioStream);
  if (audioStream) out.audioStream = audioStream;
  const hints = normalizeStoredHints(r.hints);
  if (hints) out.hints = hints;
  if (meta.embeddedSubtitles) {
    out.embeddedSubtitles = {
      language: meta.embeddedSubtitles.language,
      codec: meta.embeddedSubtitles.codec,
      segments: meta.embeddedSubtitles.segments.map((s) => ({ s: s.start, e: s.end, t: s.text })),
    };
  }
  if (meta.onScreenText.length) {
    out.onScreenText = meta.onScreenText.map((item) => ({ s: item.start, e: item.end, t: item.text, ...(item.confidence != null ? { c: item.confidence } : {}) }));
  }
  if (meta.storedCleanup) out.cleanup = meta.storedCleanup;
  return out;
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
  // Segment texts the queue kept for a refine or a gap retry.
  try {
    if (await purgeCheckpointPointer(fileId, opts)) out.checkpoint = true;
  } catch (err) {
    if (!out.error) out.error = (err && err.code) || 'unlink_failed';
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
    ...normalizedSidecarExtras(sidecar),
    ...extra,
  };
}

/**
 * The optional C5 fields of a stored sidecar, bounded again on read (a
 * sidecar is never trusted for sizes). An older sidecar has none of them: it
 * reads as `source: 'asr'` with no quality report.
 */
function normalizedSidecarExtras(sidecar) {
  const out = { source: normalizeSource(sidecar.source) || 'asr' };
  if (out.source === 'subtitles' && sidecar.subtitleOrigin === 'platform') out.subtitleOrigin = 'platform';
  const quality = normalizeQuality(sidecar.quality);
  if (quality) out.quality = quality;
  const audioStream = normalizeAudioStream(sidecar.audioStream);
  if (audioStream) out.audioStream = audioStream;
  const hints = normalizeStoredHints(sidecar.hints);
  if (hints) out.hints = hints;
  const embedded = normalizeEmbeddedSubtitles(sidecar.embeddedSubtitles);
  if (embedded) out.embeddedSubtitles = embedded;
  const onScreenText = normalizeTimedTextList(sidecar.onScreenText);
  if (onScreenText.length) out.onScreenText = onScreenText;
  const cleanup = normalizeCleanupStats(sidecar.cleanup);
  if (cleanup) out.cleanup = cleanup;
  return out;
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
    // Optional C5 stats (numbers and labels only, never text).
    ...(meta.source && meta.source !== 'asr' ? { source: meta.source } : {}),
    ...(meta.quality ? { quality: {
      score: meta.quality.score,
      level: meta.quality.level,
      lowConfidence: meta.quality.lowConfidence.length,
      enginesUsed: meta.quality.enginesUsed,
    } } : {}),
    ...(normalizeAudioStream(result && result.audioStream) ? { audioStream: normalizeAudioStream(result.audioStream) } : {}),
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
  // The transcript text was just rewritten: a summary cached from the old
  // text (document-summarizer's `llmSummary`) would contradict it.
  const { llmSummary: _staleSummary, ...kept } = plainObject(existing && existing.metadata);
  const metadata = { ...kept, ...media };
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

// ── transcription hints (durable copy, contract C5) ─────────────────────────
//
// What the user said about a recording («está en inglés», names, number of
// speakers, «literal») travels in the job data AND in
// DocumentAnalysis.metadata.mediaHints, so a job lost from Redis and re-queued
// by the recovery sweep with only { fileId, userId } still gets them. A later
// document-intelligence pass that rewrites `metadata` may drop the copy; the
// job data and the sidecar (`hints`) keep it for the run in flight.

const MAX_MEDIA_HINT_TERMS = 30;

function isoOrNow(at) {
  const date = at == null ? new Date() : new Date(at);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/** Stored mediaHints (any shape) → { language?, terms?, speakers?, verbatim?, updatedAt? } or null. */
function normalizeMediaHintsRecord(raw) {
  const hints = normalizeStoredHints(raw);
  if (!hints) return null;
  const updatedAt = raw && raw.updatedAt && !Number.isNaN(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : null;
  return { ...hints, ...(updatedAt ? { updatedAt } : {}) };
}

/**
 * Merge new hints into the stored ones: a new language, speaker count or
 * verbatim flag replaces the old one; terms accumulate (newest first, ≤ 30).
 */
function mergeMediaHints(previous, next) {
  const out = { ...(previous || {}) };
  delete out.updatedAt;
  if (next.language) out.language = next.language;
  if (next.speakers != null) out.speakers = next.speakers;
  if (typeof next.verbatim === 'boolean') out.verbatim = next.verbatim;
  if (next.terms && next.terms.length) {
    const seen = new Set();
    const terms = [];
    for (const term of [...next.terms, ...(out.terms || [])]) {
      const key = String(term).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length >= MAX_MEDIA_HINT_TERMS) break;
    }
    out.terms = terms;
  }
  return out;
}

/**
 * Durably record hints for a file of `userId` (DocumentAnalysis.metadata.mediaHints).
 * Never throws: { ok, mediaHints } or { ok: false, reason }.
 */
async function recordMediaHints(prisma, { fileId, userId, language = null, hints = null, at = null } = {}) {
  if (!userId || !isValidFileId(fileId)) return { ok: false, reason: 'invalid' };
  if (!prisma || !prisma.documentAnalysis || typeof prisma.documentAnalysis.upsert !== 'function'
    || typeof prisma.documentAnalysis.findUnique !== 'function') return { ok: false, reason: 'unavailable' };
  const next = normalizeStoredHints({ ...(normalizeMediaHints(hints) || {}), language });
  if (!next) return { ok: false, reason: 'empty' };
  const owner = String(userId);
  try {
    let fileMime = null;
    if (prisma.file && typeof prisma.file.findFirst === 'function') {
      const file = await prisma.file.findFirst({ where: { id: fileId, userId: owner, deletedAt: null }, select: { id: true, mimeType: true } });
      if (!file) return { ok: false, reason: 'not_found' };
      fileMime = file.mimeType || null;
    }
    const existing = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { userId: true, metadata: true } });
    if (existing && existing.userId !== owner) return { ok: false, reason: 'foreign' };
    const metadata = plainObject(existing && existing.metadata);
    const mediaHints = { ...mergeMediaHints(normalizeMediaHintsRecord(metadata.mediaHints), next), updatedAt: isoOrNow(at) };
    await prisma.documentAnalysis.upsert({
      where: { fileId },
      // `pending`: this row holds no analysis yet; document-intelligence
      // builds it from the transcript when someone asks.
      create: { userId: owner, fileId, status: 'pending', mimeType: fileMime, metadata: { mediaHints } },
      update: { metadata: { ...metadata, mediaHints } },
    });
    return { ok: true, mediaHints };
  } catch (_) {
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * Owner-scoped read of what the media pointer row knows: the durable hints and
 * the recording's duration. Never throws: { mediaHints, durationSec }.
 */
async function readMediaAnalysisInfo(prisma, { fileId, userId } = {}) {
  const empty = { mediaHints: null, durationSec: null };
  if (!userId || !isValidFileId(fileId) || !prisma || !prisma.documentAnalysis
    || typeof prisma.documentAnalysis.findUnique !== 'function') return empty;
  try {
    const row = await prisma.documentAnalysis.findUnique({ where: { fileId }, select: { userId: true, metadata: true } });
    if (!row || row.userId !== String(userId)) return empty;
    const metadata = plainObject(row.metadata);
    const duration = Number(metadata.durationSec);
    return {
      mediaHints: normalizeMediaHintsRecord(metadata.mediaHints),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch (_) {
    return empty;
  }
}

/** The durable hints of a file (see recordMediaHints), or null. Never throws. */
async function readMediaHints(prisma, ref = {}) {
  return (await readMediaAnalysisInfo(prisma, ref)).mediaHints;
}

// ── kept checkpoints (refine) ───────────────────────────────────────────────
//
// The media queue keeps a file's checkpointed segment texts after it
// finishes (so «revisa el minuto 12» re-transcribes one piece, not five
// hours) and after a partial result (the gap retry needs them). Their
// directory is named after a hash of the owner and the size, which a delete
// route does not know, so the queue leaves a pointer here; deleting the file
// removes the directory through it.

const CHECKPOINT_DIR_RE = /^media-[a-f0-9]{64}-\d+$/;
const CHECKPOINT_POINTER_VERSION = 1;

function checkpointRootOf(opts = {}) {
  if (opts.checkpointRoot) return path.resolve(opts.checkpointRoot);
  const env = opts.env || process.env;
  return env.MEDIA_TRANSCRIPTION_CHECKPOINT_DIR
    ? path.resolve(env.MEDIA_TRANSCRIPTION_CHECKPOINT_DIR)
    : path.join(path.resolve(env.UPLOAD_DIR || 'uploads'), '.transcription-checkpoints');
}

/** Absolute path of a file's checkpoint pointer; throws like `sidecarPathFor`. */
function checkpointPointerPathFor(fileId, opts = {}) {
  sidecarPathFor(fileId, opts);
  return path.join(rootOf(opts), `${fileId}.ckpt.json`);
}

/** Remember which checkpoint directory belongs to a file. Never throws. */
async function recordCheckpointPointer({ fileId, userId, dir, ...opts } = {}) {
  if (!userId || !isValidFileId(fileId) || !dir) return { ok: false, reason: 'invalid' };
  const name = path.basename(String(dir));
  if (!CHECKPOINT_DIR_RE.test(name)) return { ok: false, reason: 'invalid' };
  const target = checkpointPointerPathFor(fileId, opts);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ version: CHECKPOINT_POINTER_VERSION, fileId, userId: String(userId), dir: name }));
    await fs.promises.rename(tmp, target);
    return { ok: true };
  } catch (_) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * Remove the checkpoint directory a pointer names (and the pointer). Returns
 * true when a directory was removed; never throws on a missing one.
 */
async function purgeCheckpointPointer(fileId, opts = {}) {
  let pointerPath;
  try { pointerPath = checkpointPointerPathFor(fileId, opts); } catch (_) { return false; }
  let record = null;
  try { record = JSON.parse(await fs.promises.readFile(pointerPath, 'utf8')); } catch (_) { return false; }
  let removed = false;
  if (record && record.fileId === fileId && CHECKPOINT_DIR_RE.test(String(record.dir || ''))) {
    const dir = path.join(checkpointRootOf(opts), record.dir);
    const existed = await fs.promises.stat(dir).then(() => true, () => false);
    await fs.promises.rm(dir, { recursive: true, force: true });
    removed = existed;
  }
  await fs.promises.unlink(pointerPath).catch(() => {});
  return removed;
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
  recordMediaHints,
  readMediaHints,
  readMediaAnalysisInfo,
  recordCheckpointPointer,
  purgeCheckpointPointer,
  // helpers (pure) for callers and tests
  buildSidecar,
  normalizeSidecar,
  mediaTranscriptMetadata,
  sidecarExtras,
  normalizeAudioStream,
  normalizeStoredHints,
  mergeMediaHints,
  sidecarPathFor,
  clipRecordPathFor,
  checkpointPointerPathFor,
  checkpointRootOf,
  transcriptsRoot,
  SIDECAR_VERSION,
  SIDECAR_DIRNAME,
};
