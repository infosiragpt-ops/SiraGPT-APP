'use strict';

// File rows are the durable source of truth. Redis carries only references,
// never audio bytes or transcripts; restarting a web process loses no work.
//
// Two lanes (contract C5): recordings estimated at ≤ 15 min go to a small
// queue of their own, so a WhatsApp voice note never waits behind two 5-hour
// lectures. The long lane keeps the historical queue name: jobs queued before
// a deploy are still there after it. Every job id is the same in both lanes,
// and every lookup (enqueue, recovery, progress) asks both.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const transcriptFormat = require('./media-transcript-format');

const QUEUE_NAME = 'siragpt-media-transcription';
const SHORT_QUEUE_NAME = 'siragpt-media-transcription-short';
const ATTEMPTS = 3;
const CONCURRENCY = 2;
const SHORT_CONCURRENCY = Math.min(4, Math.max(1, positiveMs(process.env.SIRAGPT_MEDIA_SHORT_CONCURRENCY, 1)));
const SHORT_LANE_MAX_SEC = positiveMs(process.env.SIRAGPT_MEDIA_SHORT_LANE_MAX_SEC, 15 * 60);
// The enqueue-time duration probe is a format header read (ffprobe, no
// decode), bounded in time and in how many run at once.
const ENQUEUE_PROBE_TIMEOUT_MS = 4000;
const ENQUEUE_PROBE_CONCURRENCY = 2;
const ENQUEUE_PROBE_MAX_WAITING = 50;
// A job that finds its file busy with another job (a refine and a gap retry
// of the same recording) waits this long without spending an attempt.
const BUSY_PARK_MS = 30_000;
// An embedded text subtitle track kept as a cross-check next to the speech.
const SUBTITLE_CROSSCHECK_TIMEOUT_MS = 60_000;
// media-probe.extractSubtitleSegments failures that ARE an answer about the
// track (not text, not there): a retry would read the same. Every other
// failure (ffmpeg missing, timeout, extract failed, a throw) read nothing.
const SUBTITLE_VERDICT_ERRORS = new Set(['bitmap_subtitles', 'unsupported_codec', 'stream_not_found', 'invalid_stream']);
// video-onscreen-text stop reasons of a pass that ended ok but did not
// finish reading for an infrastructure reason (not its time budget).
const SCREEN_READ_ABANDONED = new Set(['ocr_unavailable', 'extract_failing']);
const MAX_KEYTERMS = 30;
const JOB_OPTIONS = Object.freeze({ attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 5000 }, removeOnFail: { age: 604800, count: 10000 } });

function jobOptions(jobId) {
  return { jobId, ...JOB_OPTIONS, backoff: { ...JOB_OPTIONS.backoff },
    removeOnComplete: { ...JOB_OPTIONS.removeOnComplete }, removeOnFail: { ...JOB_OPTIONS.removeOnFail } };
}

function envFlagOn(value, fallback = true) {
  if (value == null || String(value).trim() === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function shortLaneEnabled(env = process.env) {
  return envFlagOn(env.SIRAGPT_MEDIA_SHORT_LANE, true);
}

// Lowest bitrate plausible per family (bytes/s). The size estimate is then an
// UPPER bound of the duration: a long recording never lands in the short lane
// by mistake (a short one may land in the long lane, today's behaviour).
const MIN_BYTES_PER_SEC = Object.freeze([
  [/^audio\/(?:amr|amr-wb|3gpp)/, 590], // AMR-NB 4.75 kbps phone recorders
  [/^audio\/(?:ogg|opus|webm)|^application\/ogg/, 750], // Opus 6 kbps voice notes
  [/^audio\/(?:wav|x-wav|wave|vnd\.wave|aiff|x-aiff)/, 8000], // 8 kHz 8-bit PCM
  [/^audio\//, 1000], // 8 kbps, the floor for mp3/aac/m4a/wma
  [/^video\//, 6000], // ~48 kbps static screencasts
]);

/** Size → an upper bound of the duration in seconds (null when unknown). */
function estimateDurationFromSize(row) {
  const size = Number(row?.size);
  if (!Number.isFinite(size) || size <= 0) return null;
  const mime = String(row?.mimeType || '').toLowerCase().split(';')[0].trim();
  const match = MIN_BYTES_PER_SEC.find(([re]) => re.test(mime));
  return size / (match ? match[1] : 1000);
}

function laneForDuration(durationSec, maxSec = SHORT_LANE_MAX_SEC) {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > 0 && d <= maxSec ? 'short' : 'long';
}

const VIDEO_NAME_RE = /\.(?:mp4|m4v|mov|qt|mkv|webm|avi|wmv|flv|3gp|3g2|ts|mts|m2ts|mpg|mpeg|ogv|vob|divx)$/i;
// Containers that may carry a text subtitle track even when sent as audio.
const SUBTITLE_CONTAINER_RE = /\.(?:mka|m4a|m4b)$/i;

function isVideoLike(mimeType, name) {
  return /^video\//i.test(String(mimeType || '')) || VIDEO_NAME_RE.test(String(name || ''));
}
// One job may be a 10-hour lecture on CPU whisper. The budget covers the
// whole recording; checkpoints make any interruption resumable.
const PROCESS_TIMEOUT_MS = positiveMs(process.env.SIRAGPT_MEDIA_PROCESS_TIMEOUT_MS, 12 * 60 * 60 * 1000);
// Every deploy recreates the backend and stalls the running job. Long jobs
// must survive many of those (they resume from checkpoints), so the stalled
// ceiling is far above BullMQ's default instead of failing on the 3rd deploy.
const MAX_STALLED_COUNT = 20;
const PROGRESS_WRITE_INTERVAL_MS = 3000;
// While a long job runs, its file is re-checked on this cadence: deleting
// the file (or the account) stops the transcription instead of burning
// hours of CPU on a result nobody can read.
const OWNERSHIP_CHECK_MS = Math.max(5000, positiveMs(process.env.SIRAGPT_MEDIA_OWNERSHIP_CHECK_MS, 60_000));
const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PENDING_STAGES = ['uploaded', 'validating', 'extracting'];
// Recovery sweep (every minute by default). It used to load EVERY file stuck
// in a pending stage — any type, full rows with `extractedText` — and only
// then ask `isMediaFile`; a backlog of stuck documents made that one query a
// multi-second stall for the whole backend once a minute. The sweep now asks
// the database for media rows only, narrow columns, and a bounded number of
// rows per pass; the next pass continues.
const RECONCILE_INTERVAL_MS = Math.max(15_000, positiveMs(process.env.SIRAGPT_MEDIA_RECONCILE_INTERVAL_MS, 60_000));
const RECONCILE_MAX_ROWS = Math.max(100, positiveMs(process.env.SIRAGPT_MEDIA_RECONCILE_MAX_ROWS, 500));
const RECONCILE_PAGE_SIZE = 100;
// Mirrors `isMediaFile`: audio/video by MIME, plus the generic containers
// that are decided by file name (and an empty MIME, which `isMediaFile`
// also resolves by name).
const MEDIA_MIME_FILTER = Object.freeze([
  { mimeType: { startsWith: 'audio/' } },
  { mimeType: { startsWith: 'video/' } },
  { mimeType: { in: ['application/ogg', 'application/octet-stream', ''] } },
]);
const RECONCILE_SELECT = Object.freeze({
  id: true, userId: true, mimeType: true, originalName: true, processingStage: true, processingStageAt: true,
});

/** Prisma `where` for the recovery sweep: pending media only, past the grace period. */
function pendingMediaWhere(nowMs, graceMs = 120000) {
  return {
    deletedAt: null,
    processingStage: { in: PENDING_STAGES },
    AND: [
      { OR: [{ processingStageAt: { lt: new Date(nowMs - graceMs) } }, { processingStageAt: null }] },
      { OR: MEDIA_MIME_FILTER.map(clause => ({ ...clause })) },
    ],
  };
}

function positiveMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function checkpointRoot(env = process.env) {
  // Inside the persistent uploads volume (survives container recreation).
  // Dot-directories are never served by the /uploads static handler.
  return env.MEDIA_TRANSCRIPTION_CHECKPOINT_DIR
    || path.join(path.resolve(env.UPLOAD_DIR || 'uploads'), '.transcription-checkpoints');
}

/**
 * Per-file segment store. Each finished segment is one small JSON file
 * written atomically, so a crash mid-write never corrupts earlier segments.
 * `meta` (segment length + count) must match or the entry is ignored.
 */
function createDiskCheckpoint(dir) {
  const fileFor = index => path.join(dir, `seg-${String(index).padStart(5, '0')}.json`);
  return {
    dir,
    async load(index, meta) {
      const raw = await fs.promises.readFile(fileFor(index), 'utf8').catch(() => null);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved?.meta?.segmentSeconds !== meta?.segmentSeconds || saved?.meta?.total !== meta?.total) return null;
      return saved.part || null;
    },
    async save(index, meta, part) {
      await fs.promises.mkdir(dir, { recursive: true });
      const target = fileFor(index);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ meta, part, savedAt: new Date().toISOString() }));
      await fs.promises.rename(tmp, target);
    },
    clear: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

function checkpointFor(row, root = checkpointRoot()) {
  return createDiskCheckpoint(path.join(root, `${jobIdFor(row.id, row.userId)}-${Number(row.size) || 0}`));
}

async function sweepStaleCheckpoints({ root = checkpointRoot(), now = Date.now(), maxAgeMs = CHECKPOINT_MAX_AGE_MS } = {}) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^media-[a-f0-9]{64}-\d+$/.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) {
      await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

/**
 * Turns transcriber events into the compact progress object stored on the
 * BullMQ job (and read by /api/files/processing-status). ETA uses only
 * segments transcribed in this run, so resumed checkpoints don't skew it.
 */
function createProgressTracker({ publish, now = () => Date.now(), intervalMs = PROGRESS_WRITE_INTERVAL_MS }) {
  let lastWrite = 0;
  let lastKey = '';
  const durations = [];
  let lastSegmentAt = 0;
  const startedAt = now();
  return (event = {}) => {
    const total = Math.max(0, Number(event.total) || 0);
    const completed = Math.min(total, Math.max(0, Number(event.completed) || 0));
    const at = now();
    if (event.stage === 'segments') lastSegmentAt = at;
    if (event.stage === 'transcribe') {
      const took = at - lastSegmentAt;
      // A checkpointed segment is replayed in milliseconds; only real work counts.
      if (lastSegmentAt && took > 1000) durations.push(took);
      if (durations.length > 8) durations.shift();
      lastSegmentAt = at;
    }
    // `resuming` reports the chunks reused from checkpoints after a restart;
    // `done` closes the engine's work (the row turns ready right after).
    const percent = event.stage === 'preparing' ? 1
      : event.stage === 'segments' ? 2
        : event.stage === 'done' ? 99
          : (event.stage === 'transcribe' || event.stage === 'resuming') && total
            ? Math.min(99, Math.max(2, Math.round(2 + (97 * completed) / total))) : null;
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const progress = {
      stage: event.stage === 'preparing' ? 'preparing' : event.stage === 'resuming' ? 'resuming' : 'transcribing',
      completed, total, percent,
      gaps: Math.max(0, Number(event.gaps) || 0),
      durationSeconds: Math.round(Number(event.durationSeconds) || 0),
      etaSeconds: avg && total > completed ? Math.round((avg * (total - completed)) / 1000) : null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(at).toISOString(),
    };
    const key = `${progress.stage}:${completed}:${total}`;
    if (key === lastKey && at - lastWrite < intervalMs) return;
    lastKey = key;
    lastWrite = at;
    try { void Promise.resolve(publish(progress)).catch(() => {}); } catch (_) { /* best-effort */ }
  };
}

function isMediaFile(file) {
  const mime = String(file?.mimeType || file?.mimetype || '').toLowerCase().split(';')[0].trim();
  if (mime && mime !== 'application/octet-stream' && mime !== 'application/ogg' && !/^(audio|video)\//.test(mime)) return false;
  return require('./audio-transcriber').isAudioMedia(mime, file?.originalName || file?.originalname || '');
}

function hasTranscript(file) {
  const text = String(file?.extractedText || '').trim();
  return file?.processingStage !== 'failed' && !!text && !/^Media file .*transcription unavailable\./i.test(text)
    && !/^File .*uploaded successfully\. Content type:/i.test(text)
    && !require('./rag-audio-placeholder-filter').isAudioTranscriptionPlaceholder(text)
    && !/Estado:\s*(?:No se detect[oó] voz|El archivo supera el tama[nñ]o m[aá]ximo)\./i.test(text);
}

// A partial transcript (some segments failed on every engine) is a usable
// result: its stage is `ready` and the error says how much is missing. A
// retry re-runs only the missing segments (the checkpoints are kept).
const PARTIAL_PREFIX = 'Parcial:';
const RETRYING_PARTIAL = 'Reintentando los tramos sin transcribir…';
// Below this length a timestamped layout is noise («[00:00] hola»); a voice
// note keeps its plain text.
const TIMESTAMPED_TEXT_MIN_SECONDS = 120;

function isPartialTranscript(file) {
  return file?.processingStage === 'ready' && String(file?.processingError || '').startsWith(PARTIAL_PREFIX) && hasTranscript(file);
}

/** A partial transcript whose missing segments are being transcribed again. */
function isReprocessingPartial(file) {
  return PENDING_STAGES.includes(file?.processingStage) && file?.processingError === RETRYING_PARTIAL;
}

function partialFailureMessage(transcription = {}) {
  const gaps = Array.isArray(transcription.gaps) ? transcription.gaps.length : 0;
  const total = Number(transcription.segmentCount) || 0;
  const coverage = Number(transcription.coverage);
  const pct = Number.isFinite(coverage) ? ` (${Math.round(coverage * 100)} % transcrito)` : '';
  const counts = total ? `${gaps} de ${total} tramos` : `${gaps || 'Algunos'} tramos`;
  return `${PARTIAL_PREFIX} ${counts} no se pudieron transcribir${pct}. Reintentar recupera solo esos tramos.`;
}

function timedSegments(transcription) {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : [];
  return segments.filter(seg => Number.isFinite(Number(seg?.start)) && Number(seg?.end) > Number(seg?.start)
    && String(seg?.text || '').trim());
}

/**
 * The text stored on File.extractedText. Long recordings keep their
 * timestamps (paragraphs «[hh:mm:ss] …» and gap markers) so the model, RAG
 * and later questions can cite moments; short clips keep plain text.
 */
function transcriptTextFor(transcription, fallback, { fileName, formatter } = {}) {
  const segments = timedSegments(transcription);
  if (!formatter || !segments.length) return fallback;
  const duration = Number(transcription?.durationSec)
    || Math.max(...segments.map(seg => Number(seg.end))) - (Number(transcription?.timeOffsetSec) || 0);
  if (!(duration >= TIMESTAMPED_TEXT_MIN_SECONDS)) return fallback;
  try {
    const text = formatter.renderText({ ...transcription, segments }, { fileName, header: false });
    return String(text || '').trim() ? text : fallback;
  } catch (_) {
    return fallback;
  }
}

// A link clip («del minuto 60 al 90») is transcribed from 0; its stored text
// and sidecar follow the recording's own clock. Segments and gaps move by the
// offset, `durationSec` stays the clip's length and `timeOffsetSec` says where
// the clip starts. A result that already carries an offset is never moved
// twice.
const MAX_CLIP_OFFSET_SEC = 7 * 24 * 3600;
function clipOffset(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CLIP_OFFSET_SEC) : 0;
}
function onRecordingClock(transcription, offsetSec) {
  const offset = clipOffset(offsetSec);
  if (!offset || !transcription || typeof transcription !== 'object' || clipOffset(transcription.timeOffsetSec)) return transcription;
  const shift = list => (Array.isArray(list) ? list : []).map(item => (item && typeof item === 'object' && Number.isFinite(Number(item.start))
    ? { ...item, start: Number(item.start) + offset, ...(Number.isFinite(Number(item.end)) ? { end: Number(item.end) + offset } : {}) }
    : item));
  const out = { ...transcription, segments: shift(transcription.segments), gaps: shift(transcription.gaps), timeOffsetSec: offset };
  // Every other timed list moves with the text (doubtful stretches, the text
  // read on screen, an embedded subtitle track).
  if (Array.isArray(transcription.onScreenText)) out.onScreenText = shift(transcription.onScreenText);
  if (transcription.embeddedSubtitles && Array.isArray(transcription.embeddedSubtitles.segments)) {
    out.embeddedSubtitles = { ...transcription.embeddedSubtitles, segments: shift(transcription.embeddedSubtitles.segments) };
  }
  if (transcription.quality && Array.isArray(transcription.quality.lowConfidence)) {
    out.quality = { ...transcription.quality, lowConfidence: shift(transcription.quality.lowConfidence) };
  }
  return out;
}

/**
 * Cleanup on EVERY transcript, short clips included (contract C5): engine
 * credits, isolated sign-offs, loops, repeats and segments that only echo the
 * prompt terms. Returns the cleaned result, its plain text and whether every
 * timed segment turned out to be invented. A result without timed segments
 * is cleaned as one block; text that needs no cleanup is returned untouched.
 *
 * The length-only rules (a lone «Gracias» or one prompt word stretched over
 * ≥ 3 s, with no low engine confidence) are a guess, not evidence. When they
 * are the only thing that fired, they never turn a recording into «no
 * speech» on their own (C4: that verdict needs a second opinion), and on a
 * clip shorter than TIMESTAMPED_TEXT_MIN_SECONDS (stored raw before this
 * cleanup existed) they flag instead of delete: the engine's text is kept and
 * the stretch goes to `quality.lowConfidence` with reason 'hallucination'
 * (the renderer then keeps it too). A result made only of lexicon sign-offs,
 * credits, silence tokens or prompt runs still is removedAll.
 */
function cleanTranscription(transcription, plain, { promptTerms = [] } = {}) {
  const terms = Array.isArray(promptTerms) ? promptTerms.filter(Boolean) : [];
  const opts = terms.length ? { promptTerms: terms } : {};
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : [];
  const changed = stats => stats.removed > 0 || stats.loops > 0 || stats.hallucinations > 0;
  if (!segments.length) {
    const text = String(plain == null ? '' : plain);
    if (!text.trim()) return { transcription, plain, removedAll: false, cleanup: null };
    const { segments: kept, cleanup } = transcriptFormat.cleanSegmentsDetailed([{ start: 0, end: 0, text }], opts);
    if (!changed(cleanup)) return { transcription, plain, removedAll: false, cleanup: null };
    const next = kept.map(seg => seg.text).join(' ');
    const out = transcription && typeof transcription === 'object' ? { ...transcription, transcript: next } : transcription;
    return { transcription: out, plain: next, removedAll: !next.trim(), cleanup };
  }
  let run = transcriptFormat.cleanSegmentsDetailed(segments, opts);
  // Only the length rules fired and the engine showed no sign of inventing
  // over silence (no sign-off from the lexicon, no credit, no silence token,
  // no prompt run, nothing it scored below 0.5). On a short clip, or when
  // they would leave nothing at all, the engine's text stays, flagged,
  // instead of a deletion — or a «no se detectó voz» — nobody confirmed.
  const guessesOnly = run.evidence.soft > 0 && run.evidence.hard === 0;
  const seconds = transcriptFormat.cleanupRecordingSeconds(transcription, segments);
  const shortClip = seconds > 0 && seconds < TIMESTAMPED_TEXT_MIN_SECONDS;
  const onlyGuessed = guessesOnly && run.segments.length === 0;
  if (guessesOnly && (shortClip || onlyGuessed)) run = transcriptFormat.cleanSegmentsDetailed(segments, { ...opts, keepSuspect: true });
  const suspects = run.suspects || [];
  if (!changed(run.cleanup) && !suspects.length) return { transcription, plain, removedAll: false, cleanup: null };
  const kept = run.segments;
  const next = kept.map(seg => seg.text).join(' ');
  const out = { ...transcription, segments: kept, transcript: next };
  if (changed(run.cleanup)) out.cleanup = run.cleanup;
  if (suspects.length) out.quality = withSuspectStretches(transcription.quality, suspects, { whole: onlyGuessed });
  return {
    transcription: out,
    plain: next,
    removedAll: kept.length === 0,
    cleanup: changed(run.cleanup) ? run.cleanup : null,
  };
}

const SUSPECT_ONLY_NOTE = 'El único texto reconocido podría haberlo inventado el motor en un tramo de silencio; conviene verificarlo con el audio.';

/** The engine's quality report plus the stretches the cleanup kept but doubts (reason 'hallucination'). */
function withSuspectStretches(quality, suspects, { whole = false } = {}) {
  const base = quality && typeof quality === 'object' ? quality : {};
  const existing = Array.isArray(base.lowConfidence) ? base.lowConfidence : [];
  const lowConfidence = [...existing, ...suspects].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  const out = { ...base, lowConfidence };
  if (whole) {
    const notes = Array.isArray(base.notes) ? base.notes : [];
    if (!notes.includes(SUSPECT_ONLY_NOTE)) out.notes = [...notes, SUSPECT_ONLY_NOTE];
  }
  return out;
}

/** The text of the segments whose midpoint falls in [start, end) (whitespace-normalized). */
function windowText(result, range) {
  const start = Number(range?.start);
  const end = Number(range?.end);
  return (Array.isArray(result?.segments) ? result.segments : []).filter(seg => {
    const s = Number(seg?.start) || 0;
    const e = Number(seg?.end);
    const m = Number.isFinite(e) && e > s ? (s + e) / 2 : s;
    return m >= start && m < end;
  }).map(seg => String(seg?.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
}

/**
 * A refined window spliced into the transcript the user already has. A
 * segment (or gap, or doubtful stretch) belongs to the window when its
 * midpoint falls inside [start, end): those come from the refined result,
 * everything else stays exactly as it was. Both results are on the
 * recording's clock. A previous transcript without timestamps cannot be cut
 * by time: the refined result is taken whole.
 */
function spliceRefinedRange(previous, refined, range) {
  const prevSegments = Array.isArray(previous?.segments) ? previous.segments : null;
  if (!prevSegments || previous.synthetic || !refined || typeof refined !== 'object') return refined;
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return refined;
  const midpoint = item => {
    const s = Number(item?.start) || 0;
    const e = Number(item?.end);
    return Number.isFinite(e) && e > s ? (s + e) / 2 : s;
  };
  const inside = item => { const m = midpoint(item); return m >= start && m < end; };
  const byStart = (a, b) => (Number(a.start) || 0) - (Number(b.start) || 0);
  const segments = [...prevSegments.filter(seg => !inside(seg)),
    ...(Array.isArray(refined.segments) ? refined.segments : []).filter(inside)].sort(byStart);
  // Gaps are clipped, not moved by midpoint: the window is re-done, so an old
  // gap keeps only its stretches outside it, a new gap only those inside.
  const outsidePieces = gap => {
    const s = Number(gap.start); const e = Number(gap.end);
    if (!(e > s)) return [];
    const pieces = [];
    if (s < start) pieces.push({ ...gap, start: s, end: Math.min(e, start) });
    if (e > end) pieces.push({ ...gap, start: Math.max(s, end), end: e });
    return pieces;
  };
  const insidePiece = gap => {
    const s = Math.max(Number(gap.start), start); const e = Math.min(Number(gap.end), end);
    return e > s ? [{ ...gap, start: s, end: e }] : [];
  };
  const gaps = [...(Array.isArray(previous.gaps) ? previous.gaps : []).flatMap(outsidePieces),
    ...(Array.isArray(refined.gaps) ? refined.gaps : []).flatMap(insidePiece)]
    .filter(gap => gap.end - gap.start > 0.05).sort(byStart);
  const durationSec = Number(previous.durationSec) > 0 ? Number(previous.durationSec)
    : (Number(refined.durationSec) > 0 ? Number(refined.durationSec) : null);
  const gapSeconds = gaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  const coverage = durationSec ? Math.max(0, Math.min(1, 1 - gapSeconds / durationSec)) : (refined.coverage ?? previous.coverage ?? null);
  const baseQuality = refined.quality || previous.quality || null;
  const quality = baseQuality ? {
    ...baseQuality,
    lowConfidence: [...(previous.quality?.lowConfidence || []).filter(item => !inside(item)),
      ...(refined.quality?.lowConfidence || []).filter(inside)].sort(byStart),
  } : null;
  const offset = clipOffset(previous.timeOffsetSec) || clipOffset(refined.timeOffsetSec);
  const pickObject = (a, b) => (a && typeof a === 'object' ? a : (b && typeof b === 'object' ? b : null));
  const providers = refined.providers && Object.keys(refined.providers).length ? refined.providers : (previous.providers || {});
  const out = {
    ok: true,
    method: refined.method || previous.method || null,
    language: refined.language || previous.language || null,
    durationSec,
    segments,
    gaps,
    coverage,
    partial: gaps.length > 0,
    providers,
    engine: refined.engine || previous.engine || null,
    source: 'asr',
    transcript: segments.map(seg => String(seg.text || '')).filter(Boolean).join(' '),
  };
  if (Number.isFinite(Number(refined.segmentCount))) out.segmentCount = Number(refined.segmentCount);
  if (offset) out.timeOffsetSec = offset;
  if (quality) out.quality = quality;
  for (const key of ['audioStream', 'hints', 'embeddedSubtitles']) {
    const value = key === 'embeddedSubtitles' ? pickObject(previous[key], refined[key]) : pickObject(refined[key], previous[key]);
    if (value) out[key] = value;
  }
  if (Array.isArray(previous.onScreenText) && previous.onScreenText.length) out.onScreenText = previous.onScreenText;
  return out;
}

// Proper nouns and subject words from the file name («Clase 12 - Bioquímica
// (Dr. Pérez).mp4») bias the recogniser towards the right spelling. Device
// identifiers never do: «PTT-20261003-WA0012.opus» would make Whisper write
// «WA0012.» over a silent piece (see isDeviceIdentifierToken).
const GENERIC_NAME_WORDS = new Set(['audio', 'video', 'vídeo', 'clase', 'clases', 'grabacion', 'grabación', 'reunion',
  'reunión', 'sesion', 'sesión', 'parte', 'final', 'record', 'recording', 'meeting', 'nuevo', 'nueva', 'copia', 'copy',
  'whatsapp', 'voice', 'nota', 'notas', 'archivo', 'file', 'zoom', 'teams', 'meet', 'screen', 'pantalla']);
function keytermsFromFileName(name) {
  const stem = String(name || '').replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const words = stem.split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 4 && /\p{L}/u.test(word)
    && !/^\d+$/.test(word) && !GENERIC_NAME_WORDS.has(word.toLowerCase())
    && (/^\p{Lu}/u.test(word) || /[áéíóúñü]/i.test(word))
    && !transcriptFormat.isDeviceIdentifierToken(word));
  return [...new Set(words)].slice(0, 10);
}

/** File-name terms plus the user's terms (deduped, ≤ 30): what primes the recogniser. */
function keytermsFor(name, hints) {
  const seen = new Set();
  const out = [];
  for (const term of [...keytermsFromFileName(name), ...(Array.isArray(hints?.terms) ? hints.terms : [])]) {
    const key = String(term).toLowerCase();
    if (!term || seen.has(key) || transcriptFormat.isDeviceIdentifierToken(term)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

function jobIdFor(fileId, userId) {
  return `media-${crypto.createHash('sha256').update(`${userId}\0${fileId}`).digest('hex')}`;
}

/** One refine job per (file, window, hints): the same request twice is one job. */
function refineJobIdFor(fileId, userId, range, media = null) {
  const key = JSON.stringify([userId, fileId, Number(range?.start), Number(range?.end),
    media?.language || null, media?.hints || null]);
  return `media-refine-${crypto.createHash('sha256').update(key).digest('hex')}`;
}

const MAX_RANGE_SEC = 7 * 24 * 3600;
/** A window on the recording clock → { start, end } (seconds, ms precision) or null. */
function normalizeRange(range) {
  if (!range || typeof range !== 'object') return null;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > MAX_RANGE_SEC) return null;
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
}

/** What the request said about the recording → { language?, hints?, at } or null. */
function requestMedia({ language = null, hints = null } = {}, at = Date.now()) {
  // extractTranscriptionHints (C7) returns { language, terms, speakers,
  // verbatim } in one object: its language counts when none is given apart.
  const lang = transcriptFormat.normalizeHintLanguage(language)
    || (hints && typeof hints === 'object' ? transcriptFormat.normalizeHintLanguage(hints.language) : null);
  const normalized = transcriptFormat.normalizeMediaHints(hints);
  if (!lang && !normalized) return null;
  return { ...(lang ? { language: lang } : {}), ...(normalized ? { hints: normalized } : {}), at };
}

/** Job data fields for the hints of a request (none when it carried none). */
function mediaJobFields(media) {
  if (!media) return {};
  return { ...(media.language ? { language: media.language } : {}), ...(media.hints ? { hints: media.hints } : {}), hintsAt: media.at };
}

/** Pick the subtitle track to stand in for speech: language, then not forced, default, not SDH. */
function pickSubtitleTrack(probe, language = null) {
  const tracks = (Array.isArray(probe?.subtitles) ? probe.subtitles : [])
    .filter(track => track && track.textBased && Number.isInteger(track.streamOrdinal));
  if (!tracks.length) return null;
  const want = transcriptFormat.normalizeHintLanguage(language);
  const keys = track => [want && track.language === want ? 1 : 0, track.isForced ? 0 : 1, track.isDefault ? 1 : 0,
    track.isHearingImpaired ? 0 : 1, -track.streamOrdinal];
  return tracks.map(track => ({ track, keys: keys(track) })).sort((x, y) => {
    for (let i = 0; i < x.keys.length; i++) if (x.keys[i] !== y.keys[i]) return y.keys[i] - x.keys[i];
    return 0;
  })[0].track;
}

function timedTextFrom(list) {
  return (Array.isArray(list) ? list : []).map(item => {
    const start = Math.max(0, Number(item?.start) || 0);
    const end = Math.max(start, Number(item?.end) || start);
    return { start, end, text: String(item?.text == null ? '' : item.text).replace(/\s+/g, ' ').trim(),
      ...(Number.isFinite(Number(item?.confidence)) ? { confidence: Number(item.confidence) } : {}) };
  }).filter(item => item.text);
}

/** { start, end, text } without a per-item confidence (subtitle cues have none). */
function withoutConfidence(item) {
  return { start: item.start, end: item.end, text: item.text };
}

const ILLEGIBLE = '[ilegible]';
function isLegibleScreenItem(item) {
  const text = String(item?.text || '').trim();
  return Boolean(text) && text !== ILLEGIBLE && (text.match(/[\p{L}\p{N}]/gu) || []).length >= 3;
}

/** A text subtitle track as the transcript of a video without speech. */
function subtitleTranscription({ segments, track, codec = null, probe = null, reason, language = null }) {
  const segs = timedTextFrom(segments).map(withoutConfidence);
  const lang = track?.language || language || null;
  const langName = lang ? ` (${transcriptFormat.languageNameEs(lang)})` : '';
  const want = transcriptFormat.normalizeHintLanguage(language);
  const notes = [reason === 'no_audio_track'
    ? `El video no tiene audio; usé los subtítulos incrustados del video${langName}.`
    : `No se detectó voz en el audio; usé los subtítulos incrustados del video${langName}.`];
  if (want && track?.language && track.language !== want) {
    notes.push(`No había subtítulos en ${transcriptFormat.languageNameEs(want)}; estos están en ${transcriptFormat.languageNameEs(track.language)}.`);
  }
  const lastEnd = segs.reduce((max, seg) => Math.max(max, seg.end), 0);
  const text = segs.map(seg => seg.text).join(' ');
  return {
    ok: true, method: 'subtitles', source: 'subtitles', text, transcript: text, segments: segs,
    durationSec: probe?.ok && probe.durationSec ? probe.durationSec : (lastEnd || null),
    language: lang, coverage: null, partial: false, gaps: [], providers: {}, engine: null,
    subtitleCodec: codec || track?.codec || null,
    quality: { score: null, level: !want || !track?.language || track.language === want ? 'alta' : 'media',
      lowConfidence: [], escalations: 0, enginesUsed: ['subtitles'], notes },
  };
}

/** The text read on screen (slides, captions) as the transcript of a video without speech. */
function onScreenTranscription({ items, extraction = {}, probe = null, reason, language = null }) {
  const segs = timedTextFrom(items).map(seg => (seg.text === ILLEGIBLE ? { start: seg.start, end: seg.end, text: ILLEGIBLE } : seg));
  const legible = segs.filter(isLegibleScreenItem);
  const confidences = legible.map(seg => seg.confidence).filter(c => Number.isFinite(c));
  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  const illegibleShare = segs.length ? (segs.length - legible.length) / segs.length : 0;
  let level = mean == null ? 'media' : mean >= 0.85 ? 'alta' : mean >= 0.6 ? 'media' : 'baja';
  // Unreadable screens or a reading cut short (time budget) is never «alta».
  if (level === 'alta' && (illegibleShare > 0.3 || extraction.partial)) level = 'media';
  const notes = [reason === 'no_audio_track'
    ? 'El video no tiene audio; transcribí el texto que aparece en pantalla.'
    : 'No se detectó voz en el audio; transcribí el texto que aparece en pantalla.'];
  if (extraction.partial) notes.push('La lectura de la pantalla quedó incompleta; puede faltar el texto de algunos tramos.');
  if (segs.length > legible.length) notes.push('«[ilegible]» marca pantallas con texto que no se pudo leer.');
  const lastEnd = segs.reduce((max, seg) => Math.max(max, seg.end), 0);
  return {
    ok: true, method: 'onscreen', source: 'onscreen',
    text: segs.map(seg => seg.text).join('\n'), transcript: segs.map(seg => seg.text).join('\n'), segments: segs,
    durationSec: probe?.ok && probe.durationSec ? probe.durationSec : (lastEnd || null),
    language: transcriptFormat.normalizeHintLanguage(language) || null, coverage: null, partial: false, gaps: [],
    providers: {}, engine: null,
    quality: {
      score: mean == null ? null : Math.round(mean * 1000) / 1000, level,
      lowConfidence: segs.filter(seg => seg.text === ILLEGIBLE || (Number.isFinite(seg.confidence) && seg.confidence < 0.6))
        .map(seg => ({ start: seg.start, end: seg.end, reason: seg.text === ILLEGIBLE ? 'illegible' : 'low_confidence' })),
      escalations: Math.max(0, Number(extraction.escalated) || 0),
      enginesUsed: ['ocr', ...(Number(extraction.escalated) > 0 ? ['vision'] : [])],
      notes,
    },
  };
}

/** A one-line honest note at the top of the stored text for a transcript that is not the voice. */
function withSourceNote(text, transcription) {
  const source = transcription?.source;
  if (source !== 'subtitles' && source !== 'onscreen') return text;
  const note = transcription?.quality?.notes?.[0];
  return note ? `(${note})\n\n${text}` : text;
}

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The text a video carries could not be read this time (contract C5): the
// message never claims the screen or the subtitles were looked at.
const TEXT_UNREAD_ES = Object.freeze({
  screen: 'no se pudo leer su texto en pantalla',
  subtitles: 'no se pudieron leer sus subtítulos',
  both: 'no se pudieron leer sus subtítulos ni su texto en pantalla',
});

function publicFailureMessage(err) {
  const unread = TEXT_UNREAD_ES[err?.textUnread];
  if (unread && err?.code === 'no_speech') return `No se detectó voz en este video y ${unread}. Puedes reintentar este archivo.`;
  if (unread && err?.code === 'no_audio_track') return `Este video no tiene pista de audio y ${unread}. Puedes reintentar este archivo.`;
  switch (err?.code) {
    case 'no_speech': return err?.videoChecked
      ? 'No se detectó voz ni texto legible en pantalla en este video.'
      : 'No se detectó voz en este archivo.';
    case 'no_audio_track': return err?.videoChecked
      ? 'Este video no tiene pista de audio ni texto legible en pantalla para transcribir.'
      : 'Este archivo no tiene una pista de audio para transcribir.';
    // Engine intake verdicts (contract C4): nothing a retry would change.
    case 'truncated_container': return 'La grabación está incompleta (el archivo se cortó antes de terminar de guardarse). Si tienes el original, súbelo de nuevo.';
    case 'drm_protected': return 'Este archivo está protegido contra copia (DRM) y su audio no se puede leer.';
    case 'file_empty': return 'Este archivo está vacío.';
    case 'file_unavailable': case 'ENOENT': return 'No se pudo recuperar el archivo. Vuelve a subirlo.';
    case 'audio_decode_failed': case 'invalid_media': return 'No se pudo leer el audio. Comprueba que el archivo no esté dañado.';
    case 'media_timeout': return 'La transcripción superó el tiempo permitido. Puedes reintentar este archivo.';
    case 'low_coverage': return 'Demasiados tramos no se pudieron transcribir. Reintentar recupera solo los tramos que faltan; lo ya transcrito se conserva.';
    default: return 'No se pudo transcribir este archivo. Puedes reintentarlo sin volver a subir los demás.';
  }
}

function isTransientMediaError(err) {
  // A video whose text could not be read (OCR/ffmpeg down, no frame decoded)
  // is retried: the verdict about its voice stands, the reading did not happen.
  if (err?.textUnread && err?.retryable === true && /^(no_speech|no_audio_track)$/.test(String(err?.code || ''))) return true;
  if (/^(no_speech|no_audio_track|truncated_container|drm_protected|file_empty|file_unavailable|audio_decode_failed|unsupported_media|invalid_media|invalid_range|refine_not_ready|refine_untimed|media_not_found|media_owner_required)$/i.test(String(err?.code || ''))) return false;
  if (typeof err?.retryable === 'boolean') return err.retryable;
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429 || status === 408 || status >= 500 && status <= 599) return true;
  // low_coverage: too many segments failed on every engine this time; a
  // retry re-runs only those segments (the others are checkpointed).
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|P1001|P1002|P1008|P1017|P2024|P2034|media_timeout|media_shutdown|media_busy|transcription_timeout|provider_timeout|local_unavailable|low_coverage)$/i.test(String(err?.code || ''))) return true;
  return /rate.?limit|temporar(?:y|ily)|service unavailable|socket hang up|fetch failed|timed? out|timeout|\b429\b|\b50[234]\b/i.test(String(err?.message || ''));
}

// Unlike an unbounded toLocalTemp download, this stream is abortable and its
// scratch directory is removed on every exit, including a failed R2 download.
async function materializeMedia(ref, { signal, storage = require('./object-storage') } = {}) {
  if (!storage.isRemote(ref)) return { path: ref, cleanup: async () => {} };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sira-media-'));
  const target = path.join(dir, `source${path.extname(storage.keyFromRef(ref))}`);
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true });
  try {
    signal?.throwIfAborted();
    const { stream } = await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => storage.readStream(ref)).then(result => {
        if (signal?.aborted) { result.stream.destroy(); reject(signal.reason); }
        else resolve(result);
      }, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    await pipeline(stream, fs.createWriteStream(target), { signal });
    return { path: target, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function validateMedia(local, row) {
  const { fileTypeFromFile } = await import('file-type');
  const { validateUploadPolicy, detectTransportStream } = require('./upload-security-policy');
  const detected = await fileTypeFromFile(local.path)
    || (await detectTransportStream(local.path) ? { mime: 'video/mp2t' } : null);
  const policy = validateUploadPolicy({ originalName: row.originalName, declaredMime: row.mimeType,
    detectedMime: detected?.mime || row.mimeType, detectionSource: detected ? 'magic-bytes' : 'fallback', size: row.size });
  if (!policy.ok) throw failure(policy.code || 'invalid_media', policy.message || 'Archivo multimedia no válido.');
  if (!isMediaFile({ ...row, mimeType: policy.mimeType || row.mimeType })) throw failure('unsupported_media', 'El archivo no contiene audio o vídeo compatible.');
  return policy.mimeType || row.mimeType;
}

async function offloadMedia(row, { signal } = {}) {
  const storage = require('./object-storage');
  if (storage.isRemote(row.path) || !storage.enabled()) return row.path;
  const stored = await storage.persistLocalFileStream({ localPath: row.path,
    key: storage.uploadKey(row.userId, row.filename || path.basename(row.path)),
    contentType: row.mimeType, metadata: { fileId: row.id }, signal });
  return stored.ref;
}

async function configureMediaQueue(queue, concurrency = CONCURRENCY) {
  // BullMQ's worker concurrency is per web process. The queue-wide cap keeps
  // multiple replicas from simultaneously decoding/transcribing 50 files.
  await queue.setGlobalConcurrency(concurrency);
}

/**
 * Enqueue-time duration of a local upload: one ffprobe format read, bounded
 * in time, at most two at once, and skipped (null) when a burst of uploads
 * already has 50 waiting. Remote (R2) files are never downloaded for this.
 */
function createEnqueueDurationProbe({ probe, isRemote = () => false, timeoutMs = ENQUEUE_PROBE_TIMEOUT_MS,
  concurrency = ENQUEUE_PROBE_CONCURRENCY, maxWaiting = ENQUEUE_PROBE_MAX_WAITING } = {}) {
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise(resolve => {
    if (active < concurrency) { active++; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };
  return async (row) => {
    if (typeof probe !== 'function' || !row?.path) return null;
    try { if (isRemote(row.path)) return null; } catch (_) { return null; }
    if (waiting.length >= maxWaiting) return null;
    await acquire();
    try {
      const result = await probe(row.path, { timeoutMs });
      const duration = Number(result?.durationSec);
      return result?.ok && Number.isFinite(duration) && duration > 0 ? duration : null;
    } catch (_) {
      return null;
    } finally {
      release();
    }
  };
}

// Codes after which the stored platform captions of a link clip stand in for
// the audio: the audio has no voice, or it cannot be read at all. Transient
// failures retry first; the captions are never preferred over a transcript.
const LINK_CAPTION_FALLBACK_CODES = new Set(['no_speech', 'no_audio_track', 'audio_decode_failed',
  'truncated_container', 'drm_protected', 'unsupported_media', 'invalid_media']);

/**
 * A link clip's platform captions (stored on the RECORDING's clock) as the
 * transcript of the file, on the FILE's clock (minus the clip offset). Pure.
 */
function linkCaptionsTranscription(captions, { offsetSec = 0, reason = 'no_speech', durationSec = null } = {}) {
  const offset = Number.isFinite(Number(offsetSec)) && Number(offsetSec) > 0 ? Number(offsetSec) : 0;
  const segs = timedTextFrom((captions && captions.segments) || [])
    .map(seg => ({ start: Math.max(0, seg.start - offset), end: Math.max(0, seg.end - offset), text: seg.text }))
    .filter(seg => seg.end > 0 || seg.start > 0 || offset === 0)
    .map(withoutConfidence);
  if (!segs.length) return null;
  const lang = captions.language || null;
  const langName = lang ? ` (${transcriptFormat.languageNameEs(lang)})` : '';
  const kind = captions.kind === 'manual' ? 'del autor' : 'automáticos';
  const notes = [reason === 'no_speech'
    ? `No se detectó voz en el audio; usé los subtítulos ${kind} de la plataforma del video${langName}.`
    : `No se pudo leer el audio de la grabación; usé los subtítulos ${kind} de la plataforma del video${langName}.`];
  if (captions.kind !== 'manual') notes.push('Los subtítulos automáticos pueden tener errores; conviene verificar nombres y cifras.');
  if (captions.truncated) notes.push('Los subtítulos de la plataforma estaban incompletos; puede faltar el final.');
  const lastEnd = segs.reduce((max, seg) => Math.max(max, seg.end), 0);
  const text = segs.map(seg => seg.text).join(' ');
  return {
    ok: true, method: 'platform_captions', source: 'subtitles', subtitleOrigin: 'platform',
    text, transcript: text, segments: segs,
    durationSec: Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : (lastEnd || null),
    language: lang, coverage: null, partial: false, gaps: [], providers: {}, engine: null,
    quality: { score: null, level: captions.kind === 'manual' ? 'alta' : 'media',
      lowConfidence: [], escalations: 0, enginesUsed: ['platform_captions'], notes },
  };
}

function createMediaTranscriptionService({ prisma, getQueue, processFile, materialize = materializeMedia,
  validate = validateMedia, offload = offloadMedia, timeoutMs = PROCESS_TIMEOUT_MS, now = () => Date.now(),
  createCheckpoint = row => checkpointFor(row), reconcileMaxRows = RECONCILE_MAX_ROWS, ownershipCheckMs = OWNERSHIP_CHECK_MS,
  // Optional collaborators (wired by getService; tests inject fakes):
  // transcriptStore writes the segments sidecar + DocumentAnalysis pointer,
  // formatter renders the timestamped text, onTerminal hands a finished file
  // (ready, partial or failed) to the durable chat delivery.
  transcriptStore = null, formatter = null, onTerminal = null, logger = console,
  // Short lane (null: one lane, today's behaviour) and the enqueue-time
  // duration estimate (null: file size only).
  getShortQueue = null, estimateDurationSec = null, shortLaneMaxSec = SHORT_LANE_MAX_SEC,
  // { probe, extractSubtitles, extractOnScreenText } (media-probe +
  // video-onscreen-text): video fallbacks and the subtitle cross-check.
  // null: no probe, no fallback (today's behaviour).
  mediaTools = null,
  // (prisma, { fileId, userId }) → stored platform captions of a link clip
  // (transcribe-url-tool.readLinkCaptions) or null. null: no caption fallback.
  readLinkCaptions = null,
  // Keep the checkpointed segment texts after a complete transcript (the cut
  // audio is removed), so a refine re-transcribes one piece, not the file.
  keepPartsAfterSuccess = false }) {
  const activeControllers = new Set();
  // Files with a job running in this process (a refine and a gap retry of the
  // same recording share its checkpoints and its sidecar).
  const busyFiles = new Set();
  const warn = (...args) => { try { logger?.warn?.(...args); } catch (_) { /* logging is best-effort */ } };
  const notifyTerminal = (fileId, userId, stageName, extra = null) => {
    if (typeof onTerminal !== 'function') return;
    // Fire and forget: delivery has its own retries and a sweep; it must
    // never hold the media worker slot or fail the transcription job.
    void Promise.resolve().then(() => onTerminal({ fileId, userId, stage: stageName, ...(extra || {}) }))
      .catch(err => warn('[media-transcription-queue] delivery hook failed', err?.code || err?.message || 'delivery_error'));
  };

  // ── lanes ────────────────────────────────────────────────────────────────
  // The long lane must be there (no Redis → honest error); the short lane is
  // optional and its failure only means «one lane today».
  const laneQueues = () => {
    const lanes = [{ lane: 'long', queue: getQueue() }];
    if (typeof getShortQueue === 'function') {
      try {
        const short = getShortQueue();
        if (short) lanes.push({ lane: 'short', queue: short });
      } catch (err) { warn('[media-transcription-queue] short lane unavailable', err?.code || 'queue_error'); }
    }
    return lanes;
  };
  async function findJob(jobId, lanes) {
    for (const entry of lanes) {
      const job = await entry.queue.getJob(jobId);
      if (job) return { ...entry, job };
    }
    return null;
  }
  async function chooseLane(row, lanes, { durationSec = null } = {}) {
    if (lanes.length < 2) return lanes[0];
    let estimate = Number(durationSec) > 0 ? Number(durationSec) : null;
    if (estimate == null) {
      const bySize = estimateDurationFromSize(row);
      // The size bound is already short: no probe needed.
      if (bySize != null && bySize <= shortLaneMaxSec) estimate = bySize;
      else {
        if (typeof estimateDurationSec === 'function') {
          try { estimate = await estimateDurationSec(row); } catch (_) { estimate = null; }
        }
        if (!(Number(estimate) > 0)) estimate = bySize;
      }
    }
    const lane = laneForDuration(estimate, shortLaneMaxSec);
    return lanes.find(entry => entry.lane === lane) || lanes[0];
  }

  // ── hints ────────────────────────────────────────────────────────────────
  async function persistHints(row, media) {
    if (!media || typeof transcriptStore?.recordMediaHints !== 'function') return;
    try {
      const saved = await transcriptStore.recordMediaHints(prisma, { fileId: row.id, userId: row.userId,
        language: media.language || null, hints: media.hints || null, at: media.at });
      if (saved && saved.ok === false && saved.reason !== 'unavailable') warn('[media-transcription-queue] hints not stored durably', saved.reason);
    } catch (err) { warn('[media-transcription-queue] hints not stored durably', err?.code || 'hints_error'); }
  }
  // The job's own hints, or the durable copy when it is newer (a lost job is
  // re-queued with only { fileId, userId }; a later chat turn adds names to
  // a job that is still waiting).
  async function mediaOptionsFor(job, row) {
    const data = job.data || {};
    const fromJob = (data.language || data.hints) ? { language: transcriptFormat.normalizeHintLanguage(data.language),
      hints: transcriptFormat.normalizeMediaHints(data.hints), at: Number(data.hintsAt) || 0 } : null;
    let durable = null;
    if (typeof transcriptStore?.readMediaHints === 'function') {
      try {
        const record = await transcriptStore.readMediaHints(prisma, { fileId: row.id, userId: row.userId });
        if (record) durable = { language: transcriptFormat.normalizeHintLanguage(record.language),
          hints: transcriptFormat.normalizeMediaHints(record), at: Date.parse(record.updatedAt || '') || 0 };
      } catch (_) { durable = null; }
    }
    const chosen = !durable ? fromJob : (!fromJob ? durable : (durable.at > fromJob.at ? durable : fromJob));
    return { language: chosen?.language || null, hints: chosen?.hints || null };
  }
  const storedHints = media => {
    const out = { ...(media.language ? { language: media.language } : {}), ...(media.hints || {}) };
    return Object.keys(out).length ? out : null;
  };

  // ── checkpoints after the result is durable ─────────────────────────────
  async function rememberCheckpoint(checkpoint, row) {
    if (!checkpoint?.dir || typeof transcriptStore?.recordCheckpointPointer !== 'function') return;
    try { await transcriptStore.recordCheckpointPointer({ fileId: row.id, userId: row.userId, dir: checkpoint.dir }); }
    catch (_) { /* the 14-day sweep still removes it */ }
  }
  async function settleCheckpoint(checkpoint, row, { partial }) {
    if (!checkpoint) return;
    // A partial result keeps everything: a retry re-runs only the gaps.
    if (partial) { await rememberCheckpoint(checkpoint, row); return; }
    if (keepPartsAfterSuccess && checkpoint.dir) {
      // The bulky cut audio and frame thumbnails go; the small segment texts
      // stay for a refine (the 14-day sweep and the file's deletion remove them).
      await Promise.all(['audio', 'onscreen'].map(sub => fs.promises.rm(path.join(checkpoint.dir, sub), { recursive: true, force: true })
        .catch(() => {})));
      await rememberCheckpoint(checkpoint, row);
      return;
    }
    await checkpoint.clear?.().catch(() => {});
  }

  async function parkBusy(job, token) {
    if (token && typeof job.moveToDelayed === 'function') {
      let parked = false;
      try { await job.moveToDelayed(now() + BUSY_PARK_MS, token); parked = true; } catch (_) { /* fall through */ }
      if (parked) {
        const { DelayedError } = require('bullmq');
        throw new DelayedError();
      }
    }
    throw failure('media_busy', 'El archivo se está procesando; se reintentará en unos segundos.');
  }
  const loadOwned = async (fileId, userId) => {
    if (!fileId || !userId) throw failure('media_owner_required', 'Falta el archivo o su propietario.');
    const row = await prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!row || row.userId !== userId || row.deletedAt) throw failure('media_not_found', 'Archivo no disponible.');
    if (!isMediaFile(row)) throw failure('unsupported_media', 'El archivo no es un audio o vídeo.');
    return row;
  };
  const writeOwned = async (fileId, userId, data) => {
    const result = await prisma.file.updateMany({ where: { id: fileId, userId, deletedAt: null }, data });
    if (result.count !== 1) throw failure('media_not_found', 'Archivo no disponible.');
  };
  const stage = (fileId, userId, value, error = null) => writeOwned(fileId, userId, {
    processingStage: value, processingStageAt: new Date(now()), processingError: error,
  });

  // A partial transcript stays readable while its gaps are retried: the text
  // is kept, the job is forced past the cache check, and the checkpoints of
  // the segments that already succeeded make the retry cost only the gaps.
  async function enqueuePartialRetry(row, media = null) {
    const lanes = laneQueues();
    const jobId = jobIdFor(row.id, row.userId);
    const found = await findJob(jobId, lanes);
    const previous = found?.job || null;
    if (previous) {
      const state = await previous.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        // The job already wrote this partial result (an active one is only
        // offloading the binary): a retry must not be swallowed. The marker
        // makes the row the source of truth — a queued job runs the gap retry
        // when it starts, and once an active one completes the recovery sweep
        // re-adds the forced job.
        if (isPartialTranscript(row)) {
          await writeOwned(row.id, row.userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: RETRYING_PARTIAL });
          return { id: row.id, queued: true, stage: 'uploaded' };
        }
        return { id: row.id, queued: true, stage: row.processingStage };
      }
      await previous.remove();
    }
    const previousError = String(row.processingError || '').startsWith(PARTIAL_PREFIX) ? row.processingError : null;
    await writeOwned(row.id, row.userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: RETRYING_PARTIAL });
    const target = await chooseLane(row, lanes);
    await target.queue.add('transcribe', { fileId: row.id, userId: row.userId, force: true, previousError,
      ...mediaJobFields(media), ...(lanes.length > 1 ? { lane: target.lane } : {}) }, jobOptions(jobId));
    return { id: row.id, queued: true, stage: 'uploaded' };
  }

  /**
   * Queue a file's transcription. `language` («en», «inglés») and `hints`
   * ({ terms, speakers, verbatim }) reach the transcriber; they are also kept
   * durably (DocumentAnalysis.metadata.mediaHints) so a re-queued job keeps
   * them. The job goes to the short lane when the recording is estimated at
   * ≤ 15 min.
   */
  async function enqueueMediaTranscription({ fileId, userId, retry = false, timeOffsetSec = null, language = null, hints = null }) {
    if (!fileId || !userId) throw failure('media_owner_required', 'Falta el archivo o su propietario.');
    const row = await loadOwned(fileId, userId);
    const media = requestMedia({ language, hints }, now());
    if (media) await persistHints(row, media);
    if (hasTranscript(row) && retry && isPartialTranscript(row)) return enqueuePartialRetry(row, media);
    if (hasTranscript(row) && !isReprocessingPartial(row)) {
      if (row.processingStage !== 'ready') await stage(fileId, userId, 'ready');
      return { id: fileId, queued: false, stage: 'ready' };
    }
    // A gap retry already in flight; if its job was lost (crash), re-add it.
    if (isReprocessingPartial(row)) return enqueuePartialRetry(row, media);
    if (row.processingStage === 'failed' && !retry) return { id: fileId, queued: false, stage: 'failed' };
    const lanes = laneQueues(); // Must throw honestly if durable Redis is absent.
    const jobId = jobIdFor(fileId, userId);
    const found = await findJob(jobId, lanes);
    const previous = found?.job || null;
    if (previous) {
      const state = await previous.getState();
      if (state === 'failed') {
        if (!retry) {
          await stage(fileId, userId, 'failed', 'La transcripción se interrumpió. Puedes reintentar este archivo.');
          return { id: fileId, queued: false, stage: 'failed' };
        }
        await writeOwned(fileId, userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: null, extractedText: null });
        await previous.retry('failed', { resetAttemptsMade: true });
        return { id: fileId, queued: true, stage: 'uploaded' };
      }
      if (state !== 'completed' && state !== 'unknown') return { id: fileId, queued: true, stage: row.processingStage || 'uploaded' };
      // A completed queue job without persisted text is not a success. This
      // also permits recovery after a deployment of an older, broken worker.
      await previous.remove();
    }
    await writeOwned(fileId, userId, { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: null,
      ...(row.processingStage === 'failed' ? { extractedText: null } : {}) });
    const offset = clipOffset(timeOffsetSec);
    const target = await chooseLane(row, lanes);
    await target.queue.add('transcribe', { fileId, userId, ...(offset ? { timeOffsetSec: offset } : {}), ...mediaJobFields(media),
      ...(lanes.length > 1 ? { lane: target.lane } : {}) }, jobOptions(jobId));
    return { id: fileId, queued: true, stage: 'uploaded', ...(lanes.length > 1 ? { lane: target.lane } : {}) };
  }

  /**
   * Re-transcribe a window of a READY transcript («revisa el minuto 12», «los
   * nombres son…»). The window is on the recording's clock. The transcript
   * stays readable while the refine runs; on completion the window is
   * spliced into the sidecar and File.extractedText and `onTerminal` hears
   * `{ refine: true, range }`. One job per (file, window, hints).
   */
  async function enqueueRefine({ fileId, userId, range, language = null, hints = null, deliveryId = null } = {}) {
    if (!fileId || !userId) throw failure('media_owner_required', 'Falta el archivo o su propietario.');
    const window = normalizeRange(range);
    if (!window) throw failure('invalid_range', 'El tramo indicado no es válido.');
    const row = await loadOwned(fileId, userId);
    if (!hasTranscript(row) || row.processingStage !== 'ready') {
      return { id: fileId, queued: false, refine: true, stage: row.processingStage || 'uploaded', reason: 'not_ready' };
    }
    const media = requestMedia({ language, hints }, now());
    if (media) await persistHints(row, media);
    const lanes = laneQueues();
    const jobId = refineJobIdFor(fileId, userId, window, media);
    const found = await findJob(jobId, lanes);
    if (found) {
      const state = await found.job.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'waiting-children' || state === 'prioritized') {
        return { id: fileId, queued: true, refine: true, range: window, jobId, stage: 'ready' };
      }
      await found.job.remove();
    }
    // The lane follows the whole recording (a refine may re-cut it).
    let durationSec = null;
    if (typeof transcriptStore?.readMediaAnalysisInfo === 'function') {
      try { durationSec = (await transcriptStore.readMediaAnalysisInfo(prisma, { fileId, userId })).durationSec; } catch (_) { durationSec = null; }
    }
    const target = await chooseLane(row, lanes, { durationSec });
    const safeDelivery = deliveryId != null && /^[\w.:-]{1,128}$/.test(String(deliveryId)) ? String(deliveryId) : null;
    await target.queue.add('refine', { fileId, userId, refine: true, range: window, ...mediaJobFields(media),
      ...(safeDelivery ? { deliveryId: safeDelivery } : {}), ...(lanes.length > 1 ? { lane: target.lane } : {}) }, jobOptions(jobId));
    return { id: fileId, queued: true, refine: true, range: window, jobId, stage: 'ready', ...(lanes.length > 1 ? { lane: target.lane } : {}) };
  }

  // One line per job for Admin → Logs: ids and numbers only, never text.
  function logJobOutcome({ fileId: id, outcome, transcription = null, elapsedMs = 0, chars = 0, code = null, lane = null, refine = false }) {
    try {
      const token = value => String(value).replace(/[^\w.:-]+/g, '_').slice(0, 40);
      const providers = transcription?.providers && typeof transcription.providers === 'object'
        ? Object.entries(transcription.providers).map(([name, count]) => `${token(name)}:${Number(count) || 0}`).join(',') : '';
      const fields = [`file=${id}`, `outcome=${outcome}`, `elapsedMs=${Math.round(elapsedMs)}`];
      if (transcription) {
        if (Number.isFinite(Number(transcription.durationSec))) fields.push(`durationSec=${Math.round(Number(transcription.durationSec))}`);
        if (transcription.coverage != null && Number.isFinite(Number(transcription.coverage))) fields.push(`coverage=${Number(transcription.coverage).toFixed(3)}`);
        if (transcription.engine) fields.push(`engine=${token(transcription.engine)}`);
        if (providers) fields.push(`providers=${providers}`);
        if (transcription.language) fields.push(`lang=${token(transcription.language)}`);
        fields.push(`gaps=${Array.isArray(transcription.gaps) ? transcription.gaps.length : 0}`, `chars=${chars}`);
        // Numbers and labels only (never text): where it came from, the
        // engine's quality grade and what the cleanup removed.
        if (transcription.source && transcription.source !== 'asr') fields.push(`source=${token(transcription.source)}`);
        const quality = transcription.quality;
        if (quality && typeof quality === 'object') {
          if (Number.isFinite(Number(quality.score)) && quality.score != null) fields.push(`quality=${Number(quality.score).toFixed(2)}`);
          if (quality.level) fields.push(`level=${token(quality.level)}`);
          if (Array.isArray(quality.lowConfidence)) fields.push(`lowconf=${quality.lowConfidence.length}`);
        }
        const cleanup = transcription.cleanup;
        if (cleanup && typeof cleanup === 'object') {
          fields.push(`cleaned=${Number(cleanup.removed) || 0}`);
          if (Number(cleanup.echoes) > 0) fields.push(`echo=${Number(cleanup.echoes)}`);
        }
      }
      if (lane) fields.push(`lane=${token(lane)}`);
      if (refine) fields.push('refine=1');
      if (code) fields.push(`code=${String(code).slice(0, 40)}`);
      const line = `[media-transcription] ${fields.join(' ')}`;
      if (outcome === 'failed') logger?.warn?.(line); else logger?.info?.(line);
    } catch (_) { /* logging is best-effort */ }
  }

  async function writeTranscriptSidecar(row, transcription) {
    if (!transcriptStore?.writeSidecar || !timedSegments(transcription).length) return null;
    try {
      return await transcriptStore.writeSidecar({ fileId: row.id, userId: row.userId, result: transcription }) || null;
    } catch (err) {
      warn('[media-transcription-queue] transcript sidecar not written', err?.code || 'sidecar_error');
      return null;
    }
  }

  async function upsertTranscriptAnalysis(row, transcription, sidecar) {
    if (!transcriptStore?.upsertMediaTranscriptAnalysis) return;
    try {
      await transcriptStore.upsertMediaTranscriptAnalysis(prisma, { fileId: row.id, userId: row.userId,
        result: transcription, sidecarPath: typeof sidecar === 'string' ? sidecar : sidecar?.path || sidecar?.sidecarPath || null });
    } catch (err) {
      warn('[media-transcription-queue] transcript analysis pointer not stored', err?.code || 'analysis_error');
    }
  }

  // The clip offset: the job's own (handed in at enqueue), else the durable
  // record (a lost job is re-queued with only { fileId, userId }).
  async function clipOffsetFor(job, row) {
    if (job.data?.timeOffsetSec != null && Number.isFinite(Number(job.data.timeOffsetSec))) return clipOffset(job.data.timeOffsetSec);
    if (typeof transcriptStore?.readMediaClipOffset !== 'function') return 0;
    try { return clipOffset(await transcriptStore.readMediaClipOffset({ fileId: row.id, userId: row.userId })); }
    catch (_) { return 0; }
  }

  async function purgeTranscript(fileId) {
    try {
      if (typeof transcriptStore?.purgeMediaTranscript === 'function') {
        const purged = await transcriptStore.purgeMediaTranscript(fileId);
        if (purged?.error) warn('[media-transcription-queue] transcript not purged', purged.error);
      } else await transcriptStore?.deleteSidecar?.(fileId);
    } catch (_) { /* best-effort: the file is gone either way */ }
  }

  // ── transcription, video fallbacks, subtitle cross-check ────────────────

  function errorFromResult(result) {
    const err = failure(result?.code || 'transcription_failed', result?.error || 'No se detectó una transcripción legible en este archivo.');
    if (result?.status) err.status = result.status;
    if (typeof result?.retryable === 'boolean') err.retryable = result.retryable;
    return err;
  }

  // One ffprobe for files that can carry a picture or a subtitle track.
  async function probeFor(local, row, mimeType, signal) {
    if (typeof mediaTools?.probe !== 'function') return null;
    if (!isVideoLike(mimeType, row.originalName) && !SUBTITLE_CONTAINER_RE.test(String(row.originalName || ''))) return null;
    try { return await mediaTools.probe(local.path, { signal }); } catch (_) { return null; }
  }

  // Speech exists and the file also carries a text subtitle track: keep it
  // next to the transcript (a cross-check, never a replacement).
  async function subtitleCrossCheck(local, probe, language, signal) {
    const track = pickSubtitleTrack(probe, language);
    if (!track || typeof mediaTools?.extractSubtitles !== 'function') return null;
    let out = null;
    try {
      out = await mediaTools.extractSubtitles(local.path, track.streamOrdinal, { signal, codec: track.codec, timeoutMs: SUBTITLE_CROSSCHECK_TIMEOUT_MS });
    } catch (_) { out = null; }
    signal.throwIfAborted();
    const segments = out?.ok ? timedTextFrom(out.segments).map(withoutConfidence) : [];
    return segments.length ? { language: track.language || null, codec: out.codec || track.codec || null, segments } : null;
  }

  /**
   * The engine found no audio track or no speech in a video (or in a file
   * with a text subtitle track): the user gets the text the file carries —
   * its subtitle track, else the text read on screen — never «no se detectó
   * voz» while there is text to give. Returns a result or null.
   *
   * Only a reading that actually happened becomes a verdict: the error is
   * marked `videoChecked` (its message says the screen was read) only when
   * the on-screen pass came back ok — frames read, none legible. When the
   * pass could not read the video (OCR or ffmpeg unavailable, no frame
   * decoded, an internal fault, a throw) or a text subtitle track could not
   * be read, nothing was looked at: the error stays retryable
   * (`textUnread`), never a permanent «no tiene texto en pantalla».
   */
  async function videoFallback(engineError, { local, row, mimeType, probe, media, checkpoint, signal }) {
    if (!mediaTools) return null;
    const code = String(engineError?.code || '');
    const noAudioByProbe = Boolean(probe?.ok && !probe.hasAudio);
    const eligible = code === 'no_audio_track' || code === 'no_speech'
      || (noAudioByProbe && /^(audio_decode_failed|local_unavailable)$/.test(code));
    if (!eligible) return null;
    const videoLike = isVideoLike(mimeType, row.originalName) || Boolean(probe?.ok && probe.hasVideo);
    const hasSubtitles = Boolean(probe?.ok && probe.hasTextSubtitles);
    if (!videoLike && !hasSubtitles) return null;
    const reason = code === 'no_audio_track' || noAudioByProbe ? 'no_audio_track' : 'no_speech';
    // A decode failure on a file the probe saw without audio is not damage.
    engineError.code = reason;
    engineError.videoChecked = false;
    const unread = { subtitles: false, screen: false };
    if (hasSubtitles && typeof mediaTools.extractSubtitles === 'function') {
      const track = pickSubtitleTrack(probe, media.language);
      if (track) {
        let out = null;
        try { out = await mediaTools.extractSubtitles(local.path, track.streamOrdinal, { signal, codec: track.codec }); }
        catch (_) { out = null; }
        signal.throwIfAborted();
        if (out?.ok && timedTextFrom(out.segments).length) {
          return subtitleTranscription({ segments: out.segments, track, codec: out.codec, probe, reason, language: media.language });
        }
        if (!out?.ok && !SUBTITLE_VERDICT_ERRORS.has(String(out?.error || ''))) unread.subtitles = true;
      }
    }
    if (videoLike && typeof mediaTools.extractOnScreenText === 'function') {
      let out = null;
      try {
        out = await mediaTools.extractOnScreenText(local.path, { signal, checkpointDir: checkpoint?.dir || undefined,
          ...(probe?.ok ? { probe, durationSec: probe.durationSec || undefined } : {}) });
      } catch (_) { out = null; }
      signal.throwIfAborted();
      const items = Array.isArray(out?.items) ? out.items : [];
      if (items.some(isLegibleScreenItem)) return onScreenTranscription({ items, extraction: out || {}, probe, reason, language: media.language });
      // ok:true is a reading (frames read, none legible); a stream without
      // a picture is a verdict too. Anything else read nothing, and so does
      // a pass that OCR or frame decoding abandoned halfway (a retry resumes
      // from its frame checkpoints).
      const abandoned = out?.ok === true && out.partial === true && SCREEN_READ_ABANDONED.has(String(out.reason || ''));
      if ((out?.ok === true && !abandoned) || out?.reason === 'no_video_stream') engineError.videoChecked = true;
      else unread.screen = true;
    }
    if (unread.screen || unread.subtitles) {
      engineError.videoChecked = false;
      engineError.textUnread = unread.screen && unread.subtitles ? 'both' : (unread.screen ? 'screen' : 'subtitles');
      engineError.retryable = true;
      engineError.message = unread.screen
        ? 'No se pudo leer el texto en pantalla de este video; se reintentará.'
        : 'No se pudieron leer los subtítulos de este video; se reintentará.';
    }
    return null;
  }

  /**
   * Engine (or a fallback) → { transcription, plain } on the FILE's clock,
   * cleaned, with `source` set. Throws the engine's error when nothing usable
   * came back. `extra` carries refine options (range, forceRetranscribe).
   */
  async function linkCaptionsFallback(engineError, { row, offsetSec, probe }) {
    if (typeof readLinkCaptions !== 'function') return null;
    if (!LINK_CAPTION_FALLBACK_CODES.has(String(engineError?.code || ''))) return null;
    let captions = null;
    try { captions = await readLinkCaptions(prisma, { fileId: row.id, userId: row.userId }); }
    catch (_) { captions = null; }
    if (!captions) return null;
    return linkCaptionsTranscription(captions, { offsetSec, reason: engineError.code === 'no_speech' ? 'no_speech' : 'unreadable',
      durationSec: probe?.ok ? probe.durationSec : null });
  }

  async function runTranscription({ row, local, mimeType, media, checkpoint, signal, onProgress, lane, offsetSec = 0, extra = {} }) {
    const keyterms = keytermsFor(row.originalName, media.hints);
    const probe = await probeFor(local, row, mimeType, signal);
    signal.throwIfAborted();
    let engineError = null;
    let result = null;
    // The probe saw no audio stream at all: the engine would only fail its
    // decode (three «transient» attempts on a long file). Straight to text.
    if (probe?.ok && !probe.hasAudio && (probe.hasVideo || probe.hasTextSubtitles)) {
      engineError = failure('no_audio_track', 'El archivo no tiene pista de audio.');
    } else {
      result = await processFile({ path: local.path, mimetype: mimeType, originalname: row.originalName, size: row.size },
        { signal, onProgress, checkpoint, keyterms, ...(lane ? { lane } : {}),
          ...(media.language ? { language: media.language } : {}), ...(media.hints ? { hints: media.hints } : {}), ...extra });
      signal.throwIfAborted();
    }
    let transcription = null;
    let plain = null;
    if (!engineError) {
      transcription = result?.transcription || null;
      plain = transcription?.transcript ?? result?.extractedText;
      if (!result?.success) engineError = errorFromResult(result);
      else {
        const cleaned = cleanTranscription(transcription, plain, { promptTerms: keyterms });
        transcription = cleaned.transcription;
        plain = cleaned.plain;
        if (!hasTranscript({ extractedText: plain })) {
          const gaps = Array.isArray(transcription?.gaps) && transcription.gaps.length > 0;
          engineError = cleaned.removedAll
            ? failure(gaps ? 'low_coverage' : 'no_speech', gaps ? 'Demasiados tramos no se pudieron transcribir.' : 'No se detectó voz en este archivo.')
            : errorFromResult(result);
        }
      }
    }
    if (engineError) {
      const fallback = await videoFallback(engineError, { local, row, mimeType, probe, media, checkpoint, signal })
        || (extra.range ? null : await linkCaptionsFallback(engineError, { row, offsetSec, probe }));
      if (!fallback) throw engineError;
      return { transcription: fallback, plain: fallback.transcript };
    }
    if (transcription && typeof transcription === 'object') {
      // A refine keeps the track the first run stored (spliceRefinedRange).
      if (probe?.ok && probe.hasTextSubtitles && !extra.range) {
        const embedded = await subtitleCrossCheck(local, probe, transcription.language || media.language, signal);
        if (embedded) transcription = { ...transcription, embeddedSubtitles: embedded };
      }
      const hints = storedHints(media);
      transcription = { ...transcription, source: transcription.source || 'asr', ...(hints ? { hints } : {}) };
    }
    return { transcription, plain };
  }

  function laneOf(job) {
    if (job?.data?.lane === 'short' || job?.data?.lane === 'long') return job.data.lane;
    if (job?.queueName === SHORT_QUEUE_NAME) return 'short';
    if (job?.queueName === QUEUE_NAME) return 'long';
    return null;
  }

  // Abort controller, 12 h budget and the deleted-file watch of one job.
  function openJobContext(fileId, userId) {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(failure('media_timeout', 'La transcripción superó el tiempo permitido.')), timeoutMs);
    timer.unref?.();
    let ownershipTimer = null;
    if (ownershipCheckMs > 0 && fileId && userId) {
      ownershipTimer = setInterval(() => {
        void prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null }, select: { id: true } })
          .then(found => { if (!found && !controller.signal.aborted) controller.abort(failure('media_not_found', 'El archivo se eliminó durante la transcripción.')); })
          .catch(() => { /* a DB blip never aborts a transcription */ });
      }, ownershipCheckMs);
      ownershipTimer.unref?.();
    }
    return {
      controller,
      close() {
        clearTimeout(timer);
        if (ownershipTimer) clearInterval(ownershipTimer);
        activeControllers.delete(controller);
      },
    };
  }

  async function processMediaJob(job, token) {
    if (job?.data?.refine) return processRefineJob(job, token);
    const { fileId, userId } = job.data || {};
    let local;
    let checkpoint = null;
    let forced = false;
    let claimed = false;
    let sidecarWritten = false;
    let previousRow = null;
    let holdsFile = false;
    const lane = laneOf(job);
    const context = openJobContext(fileId, userId);
    const { controller } = context;
    const jobStartedAt = now();
    try {
      const row = await loadOwned(fileId, userId);
      // The row, not the job, says whether gaps are being retried: a replayed
      // gap retry of a file that is already ready is a cache hit, and any job
      // that meets the retry marker runs the gap retry.
      forced = hasTranscript(row) && isReprocessingPartial(row);
      if (hasTranscript(row) && !forced) {
        // A ready row keeps its note (a partial stays labelled partial).
        if (row.processingStage !== 'ready') await stage(fileId, userId, 'ready');
        return { id: fileId, cached: true, stage: 'ready' };
      }
      // A refine of this recording is running here: wait without claiming.
      if (busyFiles.has(fileId)) await parkBusy(job, token);
      busyFiles.add(fileId);
      holdsFile = true;
      previousRow = row;
      if (forced) await writeOwned(fileId, userId, { processingStage: 'extracting', processingStageAt: new Date(now()), processingError: RETRYING_PARTIAL });
      else await stage(fileId, userId, 'extracting');
      claimed = true;
      const offset = await clipOffsetFor(job, row);
      const media = await mediaOptionsFor(job, row);
      checkpoint = createCheckpoint(row);
      local = await materialize(row.path, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const mimeType = await validate(local, row);
      const onProgress = createProgressTracker({ publish: progress => job.updateProgress?.(progress) });
      const run = await runTranscription({ row, local, mimeType, media, checkpoint, signal: controller.signal, onProgress, lane, offsetSec: offset });
      controller.signal.throwIfAborted();
      // Shifted from the engine's fresh result every run (a gap retry
      // re-transcribes on the clip's clock), so the offset is never applied twice.
      const transcription = onRecordingClock(run.transcription, offset);
      const plain = run.plain;
      const partial = transcription?.partial === true;
      const transcript = withSourceNote(transcriptTextFor(transcription, plain, { fileName: row.originalName, formatter }), transcription);
      // The segments sidecar is written BEFORE the terminal stage, so any
      // reader that sees `ready` (the chat delivery, a follow-up turn) can
      // build SRT/VTT/Word from it. A sidecar failure never fails the job:
      // the timestamped text above is still durable.
      const sidecar = await writeTranscriptSidecar(row, transcription);
      sidecarWritten = Boolean(sidecar);
      // Text + terminal stage are one DB write. A crash before this write
      // leaves the job recoverable; after it, a replay is a cache hit.
      await writeOwned(fileId, userId, { extractedText: transcript, processingStage: 'ready',
        processingStageAt: new Date(now()), processingError: partial ? partialFailureMessage(transcription) : null });
      if (sidecar) await upsertTranscriptAnalysis(row, transcription, sidecar);
      // A partial result keeps its checkpoints: a retry then re-runs only
      // the missing segments (the 14-day sweep removes them otherwise).
      await settleCheckpoint(checkpoint, row, { partial });
      notifyTerminal(fileId, userId, partial ? 'partial' : 'ready');
      logJobOutcome({ fileId, outcome: partial ? 'partial' : 'ready', transcription, elapsedMs: now() - jobStartedAt, chars: transcript.length, lane });
      // Offload is optional enrichment after durable text is ready. Local
      // uploads live on the existing persistent volume if R2 is unavailable.
      // Never erase the local copy before updating the owner-scoped DB ref.
      try {
        const ref = await offload(row, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
        if (ref && ref !== row.path) await writeOwned(fileId, userId, { path: ref });
      } catch (_) { /* completed transcript and original local binary remain valid */ }
      return { id: fileId, stage: 'ready', characters: transcript.length };
    } catch (caught) {
      if (caught?.name === 'DelayedError') throw caught;
      const err = controller.signal.aborted ? controller.signal.reason : caught;
      // A deploy/restart is not a failed attempt: park the job for a few
      // seconds without spending one of its retries. It resumes from its
      // checkpoints on the next worker, however many deploys happen.
      if (err?.code === 'media_shutdown' && token && typeof job.moveToDelayed === 'function') {
        let parked = false;
        try {
          await job.moveToDelayed(now() + 5000, token);
          parked = true;
        } catch (_) { /* connection already gone: the stalled checker recovers it */ }
        if (parked) {
          // Only a row this run moved to `extracting` goes back; a gap retry
          // keeps its marker, or recovery and delivery would take the old
          // partial text for a complete transcript.
          if (claimed) {
            await writeOwned(fileId, userId, { processingStage: 'uploaded', processingStageAt: new Date(now()),
              processingError: forced ? RETRYING_PARTIAL : null }).catch(() => {});
          }
          const { DelayedError } = require('bullmq');
          throw new DelayedError();
        }
      }
      const transient = isTransientMediaError(err);
      const willRetry = transient && Number(job.attemptsMade || 0) + 1 < Number(job.opts?.attempts || ATTEMPTS);
      logJobOutcome({ fileId, outcome: willRetry ? 'retry' : 'failed', code: err?.code || null, elapsedMs: now() - jobStartedAt, lane });
      if (!transient) job.discard?.();
      // A deleted file's partial work (segment audio + text) goes with it,
      // and so does a sidecar this run wrote just before the delete won.
      if (err?.code === 'media_not_found') {
        await checkpoint?.clear?.().catch(() => {});
        if (sidecarWritten) await purgeTranscript(fileId);
      }
      // A deleted/foreign file must never be resurrected or mutated. A job
      // that never claimed the row has nothing to undo before its next
      // attempt (writing `uploaded` would wipe a gap retry's marker).
      if (err.code !== 'media_not_found' && err.code !== 'media_owner_required' && (claimed || !willRetry)) {
        if (forced && previousRow) {
          // A failed retry of a partial transcript never loses the partial
          // text: it goes back to `ready` with its original note.
          await writeOwned(fileId, userId, willRetry
            ? { processingStage: 'uploaded', processingStageAt: new Date(now()), processingError: RETRYING_PARTIAL }
            : { processingStage: 'ready', processingStageAt: new Date(now()),
              processingError: job.data?.previousError || `${PARTIAL_PREFIX} la transcripción quedó incompleta. Reintentar recupera solo esos tramos.` }).catch(() => {});
          if (!willRetry) notifyTerminal(fileId, userId, 'partial');
        } else {
          await stage(fileId, userId, willRetry ? 'uploaded' : 'failed',
            willRetry ? null : publicFailureMessage(err));
          if (!willRetry) notifyTerminal(fileId, userId, 'failed');
        }
      }
      throw err;
    } finally {
      context.close();
      if (holdsFile) busyFiles.delete(fileId);
      await local?.cleanup().catch(() => {});
    }
  }

  /**
   * A refine job: re-transcribe one window of a READY transcript and splice
   * it in. The row never leaves `ready` and its text is never lost: a
   * failure only tells the delivery (`{ refine: true, ok: false }`).
   */
  async function processRefineJob(job, token) {
    const { fileId, userId, deliveryId = null } = job.data || {};
    const range = normalizeRange(job.data?.range);
    const lane = laneOf(job);
    const extraTerminal = { refine: true, range, ...(deliveryId ? { deliveryId } : {}) };
    let local;
    let checkpoint = null;
    let holdsFile = false;
    let sidecarWritten = false;
    const context = openJobContext(fileId, userId);
    const { controller } = context;
    const jobStartedAt = now();
    try {
      if (!range) throw failure('invalid_range', 'El tramo indicado no es válido.');
      const row = await loadOwned(fileId, userId);
      if (!hasTranscript(row) || row.processingStage !== 'ready') {
        // A gap retry (or the first run) of this file is still going: wait.
        if (PENDING_STAGES.includes(row.processingStage)) await parkBusy(job, token);
        throw failure('refine_not_ready', 'La transcripción de este archivo no está lista.');
      }
      if (busyFiles.has(fileId)) await parkBusy(job, token);
      busyFiles.add(fileId);
      holdsFile = true;
      const offset = await clipOffsetFor(job, row);
      const media = await mediaOptionsFor(job, row);
      // The window is on the recording's clock; the engine works on the file's.
      const engineRange = { start: Math.max(0, range.start - offset), end: Math.max(0, range.end - offset) };
      if (!(engineRange.end > engineRange.start)) throw failure('invalid_range', 'El tramo está fuera de esta grabación.');
      let previous = null;
      if (typeof transcriptStore?.loadMediaTranscript === 'function') {
        try { previous = await transcriptStore.loadMediaTranscript(prisma, { userId, fileId }); } catch (_) { previous = null; }
      }
      checkpoint = createCheckpoint(row);
      local = await materialize(row.path, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const mimeType = await validate(local, row);
      const run = await runTranscription({ row, local, mimeType, media, checkpoint, signal: controller.signal, lane,
        onProgress: createProgressTracker({ publish: progress => job.updateProgress?.(progress) }),
        extra: { range: engineRange, forceRetranscribe: true } });
      controller.signal.throwIfAborted();
      const refined = onRecordingClock(run.transcription, offset);
      if (!refined || typeof refined !== 'object' || !timedSegments(refined).length) {
        throw failure('refine_untimed', 'El motor no devolvió marcas de tiempo para corregir el tramo.');
      }
      const merged = previous && (!previous.source || previous.source === 'asr') ? spliceRefinedRange(previous, refined, range) : refined;
      const plain = merged.transcript || run.plain;
      if (!hasTranscript({ extractedText: plain })) throw failure('no_speech', 'No se detectó voz en el tramo.');
      const partial = merged.partial === true;
      const transcript = withSourceNote(transcriptTextFor(merged, plain, { fileName: row.originalName, formatter }), merged);
      const sidecar = await writeTranscriptSidecar(row, merged);
      sidecarWritten = Boolean(sidecar);
      // A gap retry asked for while this refine ran keeps its marker: only the
      // text changes, the retry job rewrites the rest when it runs.
      const current = await prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
      if (!current) throw failure('media_not_found', 'Archivo no disponible.');
      await writeOwned(fileId, userId, isReprocessingPartial(current) ? { extractedText: transcript }
        : { extractedText: transcript, processingStage: 'ready', processingStageAt: new Date(now()),
          processingError: partial ? partialFailureMessage(merged) : null });
      if (sidecar) await upsertTranscriptAnalysis(row, merged, sidecar);
      await settleCheckpoint(checkpoint, row, { partial });
      // «unchanged»: the new attempt read the window exactly as before.
      const unchanged = Boolean(previous) && windowText(previous, range) === windowText(merged, range);
      notifyTerminal(fileId, userId, partial ? 'partial' : 'ready', { ...extraTerminal, ok: true, ...(unchanged ? { unchanged: true } : {}) });
      logJobOutcome({ fileId, outcome: 'refined', transcription: merged, elapsedMs: now() - jobStartedAt, chars: transcript.length, lane, refine: true });
      return { id: fileId, stage: 'ready', refine: true, range, characters: transcript.length };
    } catch (caught) {
      if (caught?.name === 'DelayedError') throw caught;
      const err = controller.signal.aborted ? controller.signal.reason : caught;
      if (err?.code === 'media_shutdown' && token && typeof job.moveToDelayed === 'function') {
        let parked = false;
        try { await job.moveToDelayed(now() + 5000, token); parked = true; } catch (_) { /* stalled checker recovers it */ }
        if (parked) {
          const { DelayedError } = require('bullmq');
          throw new DelayedError();
        }
      }
      const transient = isTransientMediaError(err);
      const willRetry = transient && Number(job.attemptsMade || 0) + 1 < Number(job.opts?.attempts || ATTEMPTS);
      logJobOutcome({ fileId, outcome: willRetry ? 'refine_retry' : 'refine_failed', code: err?.code || null,
        elapsedMs: now() - jobStartedAt, lane, refine: true });
      if (!transient) job.discard?.();
      // A file deleted while its window was re-done takes its work with it.
      if (err?.code === 'media_not_found') {
        await checkpoint?.clear?.().catch(() => {});
        if (sidecarWritten) await purgeTranscript(fileId);
      }
      // The transcript stays as it was; only the delivery hears about it.
      if (!willRetry && err?.code !== 'media_not_found' && err?.code !== 'media_owner_required') {
        notifyTerminal(fileId, userId, 'failed', { ...extraTerminal, ok: false, code: String(err?.code || 'refine_failed').slice(0, 40) });
      }
      throw err;
    } finally {
      context.close();
      if (holdsFile) busyFiles.delete(fileId);
      await local?.cleanup().catch(() => {});
    }
  }

  // Keyset position carried across passes: a backlog larger than one pass is
  // walked round-robin instead of re-reading its head every minute while the
  // tail starves. Reset once a pass reaches the end.
  let sweepCursor = null;
  async function reconcilePendingMedia() {
    // Keyset pagination visits pending MEDIA rows without holding whole files
    // in RAM: the database applies the media filter and returns narrow
    // columns (never `extractedText`). The grace period avoids racing an HTTP
    // validation write. A pass is bounded; a larger backlog continues on the
    // next pass instead of stalling the event loop for seconds.
    let cursor = sweepCursor;
    let recovered = 0;
    let visited = 0;
    let truncated = false;
    const maxRows = Math.max(RECONCILE_PAGE_SIZE, Number(reconcileMaxRows) || RECONCILE_MAX_ROWS);
    do {
      const take = Math.min(RECONCILE_PAGE_SIZE, maxRows - visited);
      const rows = await prisma.file.findMany({ where: pendingMediaWhere(now()), select: RECONCILE_SELECT,
        orderBy: { id: 'asc' }, take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) break;
      visited += rows.length;
      for (const row of rows) {
        if (!isMediaFile(row)) continue;
        await enqueueMediaTranscription({ fileId: row.id, userId: row.userId });
        recovered++;
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < take) break;
      if (visited >= maxRows) { truncated = true; break; }
    } while (true);
    sweepCursor = truncated ? cursor : null;
    return truncated ? { recovered, truncated: true } : { recovered };
  }

  // Live progress of the durable job, for the composer chip. Owner-scoped by
  // construction (job id hashes userId + fileId). Never throws: a missing
  // Redis simply means "no progress to show", not a failed status read.
  async function readMediaProgress({ fileIds = [], userId, timeoutMs: readTimeoutMs = 1500 } = {}) {
    const out = {};
    if (!userId || !fileIds.length) return out;
    let lanes;
    try { lanes = laneQueues(); } catch { return out; }
    const read = Promise.all(fileIds.map(async (fileId) => {
      for (const { queue } of lanes) {
        try {
          const job = await queue.getJob(jobIdFor(fileId, userId));
          const progress = job?.progress;
          if (progress && typeof progress === 'object' && !Array.isArray(progress)) { out[fileId] = progress; return; }
          if (job) return;
        } catch { /* progress is optional */ }
      }
    }));
    await Promise.race([read, new Promise(resolve => { const t = setTimeout(resolve, readTimeoutMs); t.unref?.(); })]);
    return out;
  }

  return { enqueueMediaTranscription, enqueueRefine, processMediaJob, reconcilePendingMedia, readMediaProgress,
    abortActive: () => {
      const count = activeControllers.size;
      for (const controller of activeControllers) controller.abort(failure('media_shutdown', 'La transcripción se reanudará después del reinicio.'));
      return count;
    },
  };
}

/**
 * One recovery tick: re-queue stuck media, then sweep the chat deliveries.
 * The sweep is started detached (it has its own busy guard): a long analysis
 * or translation delivery must never hold media recovery behind it.
 */
function createRecoveryTick({ reconcileMedia, sweepDeliveries, warn = (...args) => console.warn(...args) }) {
  let recovering = false;
  return async function reconcile() {
    if (recovering) return;
    recovering = true;
    try { await reconcileMedia(); }
    catch (err) { warn('[media-transcription-queue] reconciliation unavailable', err?.code || 'recovery_error'); }
    finally { recovering = false; }
    // Deliveries whose hook was missed (crash, deploy between the terminal
    // write and the hook) are picked up here, once their files are terminal.
    void Promise.resolve().then(() => sweepDeliveries())
      .catch(err => warn('[media-transcription-queue] delivery sweep unavailable', err?.code || 'delivery_sweep_error'));
  };
}

let queue, shortQueue, queueConnection, worker, shortWorker, workerConnection, shortWorkerConnection, service, recoveryTimer;
function mediaQueueUnavailable() {
  return failure('media_queue_unavailable', 'La cola de transcripción no está disponible. El archivo permanece guardado.');
}
function producerConnection(redis) {
  if (!queueConnection) {
    queueConnection = redis.createRedisConnection({ label: 'media-transcription-producer', maxRetriesPerRequest: 1,
      enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000 });
  }
  return queueConnection;
}
function getMediaQueue() {
  if (queue) return queue;
  const { Queue } = require('bullmq');
  const redis = require('./agents/agent-task-queue');
  if (!process.env.REDIS_URL) throw mediaQueueUnavailable();
  queue = new Queue(QUEUE_NAME, { connection: producerConnection(redis), ...redis.getBullMQRuntimeOptions() });
  queue.on('error', err => console.warn('[media-transcription-queue]', err?.code || 'queue_error'));
  return queue;
}
/** The short lane's queue (shares the producer connection), or null when the lane is off. */
function getShortMediaQueue() {
  if (!shortLaneEnabled()) return null;
  if (shortQueue) return shortQueue;
  const { Queue } = require('bullmq');
  const redis = require('./agents/agent-task-queue');
  if (!process.env.REDIS_URL) throw mediaQueueUnavailable();
  shortQueue = new Queue(SHORT_QUEUE_NAME, { connection: producerConnection(redis), ...redis.getBullMQRuntimeOptions() });
  shortQueue.on('error', err => console.warn('[media-transcription-queue] short lane', err?.code || 'queue_error'));
  return shortQueue;
}
function lazyModule(name) {
  try { return require(name); } catch (err) {
    console.warn(`[media-transcription-queue] optional module unavailable: ${name}`, err?.code || 'module_error');
    return null;
  }
}
function getService() {
  if (!service) {
    const store = lazyModule('./media-transcript-store');
    const formatter = lazyModule('./media-transcript-format');
    const probeModule = lazyModule('./media-probe');
    const onScreenModule = lazyModule('./video-onscreen-text');
    const mediaTools = probeModule ? {
      probe: (file, opts) => probeModule.probeMediaStreams(file, opts),
      extractSubtitles: (file, ordinal, opts) => probeModule.extractSubtitleSegments(file, ordinal, opts),
      extractOnScreenText: onScreenModule ? (file, opts) => onScreenModule.extractOnScreenText(file, opts) : null,
    } : null;
    const storage = lazyModule('./object-storage');
    service = createMediaTranscriptionService({ prisma: require('../config/database'), getQueue: getMediaQueue,
      getShortQueue: shortLaneEnabled() ? getShortMediaQueue : null,
      estimateDurationSec: probeModule ? createEnqueueDurationProbe({
        probe: (file, opts) => probeModule.probeMediaStreams(file, opts),
        isRemote: ref => Boolean(storage?.isRemote?.(ref)),
      }) : null,
      mediaTools,
      readLinkCaptions: (db, ref) => require('./agent-harness/tools/transcribe-url-tool').readLinkCaptions(db, ref),
      keepPartsAfterSuccess: envFlagOn(process.env.SIRAGPT_MEDIA_KEEP_REFINE_PARTS, true),
      processFile: (...args) => require('./fileProcessor').processFile(...args),
      transcriptStore: store, formatter,
      onTerminal: payload => require('./media-delivery').onMediaTerminal(payload) });
  }
  return service;
}

// A worker killed repeatedly can exhaust BullMQ's stalled limit without
// entering our catch block. Persist that terminal state, never leave a chip
// displaying "extracting" forever. Ownership/deletion are still checked.
function onWorkerFailed(job, err) {
  if (!job) return;
  void job.getState().then(async state => {
    if (state !== 'failed') return;
    const prisma = require('../config/database');
    if (job.data?.refine) {
      // A refine never touches the row: its transcript stays as it was.
      await Promise.resolve(require('./media-delivery').onMediaTerminal({ fileId: job.data.fileId, userId: job.data.userId,
        stage: 'failed', refine: true, range: normalizeRange(job.data.range), ok: false, code: 'refine_failed',
        ...(job.data.deliveryId ? { deliveryId: job.data.deliveryId } : {}) }))
        .catch(() => console.warn('[media-transcription-worker] delivery hook pending recovery'));
      return;
    }
    const row = await prisma.file.findFirst({ where: { id: job.data.fileId, userId: job.data.userId, deletedAt: null } });
    if (row && isReprocessingPartial(row)) {
      // A gap retry that exhausted the worker keeps its partial text.
      await prisma.file.updateMany({ where: { id: row.id, userId: row.userId, deletedAt: null }, data: {
        processingStage: 'ready', processingStageAt: new Date(),
        processingError: job.data.previousError || `${PARTIAL_PREFIX} la transcripción quedó incompleta. Reintentar recupera solo esos tramos.`,
      } });
      await Promise.resolve(require('./media-delivery').onMediaTerminal({ fileId: row.id, userId: row.userId, stage: 'partial' }))
        .catch(() => console.warn('[media-transcription-worker] delivery hook pending recovery'));
      return;
    }
    if (!row || hasTranscript(row)) return;
    await prisma.file.updateMany({ where: { id: row.id, userId: row.userId, deletedAt: null }, data: {
      processingStage: 'failed', processingStageAt: new Date(), processingError: publicFailureMessage(err),
    } });
    // The chat that waits for this file learns about it through delivery.
    await Promise.resolve(require('./media-delivery').onMediaTerminal({ fileId: row.id, userId: row.userId, stage: 'failed' }))
      .catch(() => console.warn('[media-transcription-worker] delivery hook pending recovery'));
  }).catch(() => console.warn('[media-transcription-worker] failed state persistence pending recovery'));
}

function startMediaTranscriptionWorker() {
  if (worker) return worker;
  if (!process.env.REDIS_URL) {
    console.warn('[media-transcription-queue] worker unavailable: Redis not configured');
    return null;
  }
  const { Worker } = require('bullmq');
  const redis = require('./agents/agent-task-queue');
  const workerOptions = concurrency => ({ ...redis.getBullMQRuntimeOptions(), concurrency,
    lockDuration: 300000, stalledInterval: 60000, maxStalledCount: MAX_STALLED_COUNT, autorun: false });
  workerConnection = redis.createRedisConnection({ label: 'media-transcription-worker' });
  worker = new Worker(QUEUE_NAME, (job, token) => getService().processMediaJob(job, token), {
    connection: workerConnection, ...workerOptions(CONCURRENCY),
  });
  // The short lane: its own worker and connection, so two long lectures in
  // the long lane never hold a voice note.
  if (shortLaneEnabled()) {
    shortWorkerConnection = redis.createRedisConnection({ label: 'media-transcription-short-worker' });
    shortWorker = new Worker(SHORT_QUEUE_NAME, (job, token) => getService().processMediaJob(job, token), {
      connection: shortWorkerConnection, ...workerOptions(SHORT_CONCURRENCY),
    });
  }
  const lanes = () => [
    { current: worker, getQueue: getMediaQueue, concurrency: CONCURRENCY },
    ...(shortWorker ? [{ current: shortWorker, getQueue: getShortMediaQueue, concurrency: SHORT_CONCURRENCY }] : []),
  ];
  let starting = false;
  const ensureRunning = async () => {
    if (starting || !worker) return;
    starting = true;
    try {
      for (const lane of lanes()) {
        const currentWorker = lane.current;
        if (!currentWorker || currentWorker.isRunning()) continue;
        try {
          const laneQueue = lane.getQueue();
          if (laneQueue) await configureMediaQueue(laneQueue, lane.concurrency);
          if (currentWorker === worker || currentWorker === shortWorker) {
            void currentWorker.run().catch(err => console.warn('[media-transcription-worker] run interrupted', err?.code || 'worker_error'));
          }
        } catch (err) { console.warn('[media-transcription-worker] waiting for durable queue', err?.code || 'queue_error'); }
      }
    } finally { starting = false; }
  };
  for (const current of [worker, shortWorker].filter(Boolean)) {
    current.on('error', err => console.warn('[media-transcription-worker]', err?.code || 'worker_error'));
    current.on('failed', onWorkerFailed);
  }
  const reconcile = createRecoveryTick({
    reconcileMedia: () => getService().reconcilePendingMedia(),
    sweepDeliveries: () => require('./media-delivery').sweepPendingDeliveries(),
  });
  worker.on('ready', () => { void ensureRunning(); void reconcile(); void sweepStaleCheckpoints().catch(() => {}); });
  if (shortWorker) shortWorker.on('ready', () => { void ensureRunning(); });
  recoveryTimer = setInterval(() => { void ensureRunning(); void reconcile(); }, RECONCILE_INTERVAL_MS);
  recoveryTimer.unref?.();
  return worker;
}

async function closeMediaTranscriptionQueue() {
  clearInterval(recoveryTimer);
  recoveryTimer = null;
  // Give aborted jobs a moment to park themselves (moveToDelayed) before
  // the connection is force-closed; they resume from checkpoints.
  if (service?.abortActive()) await new Promise(resolve => setTimeout(resolve, 1500));
  // Deliveries in flight go back to pending (no attempt spent); the next
  // process's sweep posts them.
  try { await require('./media-delivery').closeMediaDelivery({ graceMs: 1500 }); }
  catch (err) { console.warn('[media-transcription-queue] delivery shutdown incomplete', err?.code || 'delivery_close_error'); }
  const previous = { worker, shortWorker, queue, shortQueue, workerConnection, shortWorkerConnection, queueConnection };
  worker = shortWorker = queue = shortQueue = workerConnection = shortWorkerConnection = queueConnection = null;
  // Force-close the worker connection at shutdown. Its active jobs become
  // stalled and are recovered, rather than blocking deploy for two hours.
  await previous.worker?.close(true);
  await previous.shortWorker?.close(true);
  await previous.queue?.close();
  await previous.shortQueue?.close();
  previous.workerConnection?.disconnect();
  previous.shortWorkerConnection?.disconnect();
  previous.queueConnection?.disconnect();
}

module.exports = {
  isMediaFile, hasTranscript, isPartialTranscript, isReprocessingPartial, partialFailureMessage, transcriptTextFor, onRecordingClock, createRecoveryTick,
  keytermsFromFileName, linkCaptionsTranscription, PARTIAL_PREFIX, RETRYING_PARTIAL, TIMESTAMPED_TEXT_MIN_SECONDS, jobIdFor, isTransientMediaError, materializeMedia, configureMediaQueue, createMediaTranscriptionService,
  createDiskCheckpoint, checkpointFor, checkpointRoot, sweepStaleCheckpoints, createProgressTracker,
  readMediaProgress: payload => getService().readMediaProgress(payload),
  enqueueMediaTranscription: payload => getService().enqueueMediaTranscription(payload),
  enqueueRefine: payload => getService().enqueueRefine(payload),
  reconcilePendingMedia: () => getService().reconcilePendingMedia(),
  startMediaTranscriptionWorker, closeMediaTranscriptionQueue, pendingMediaWhere,
  // lanes, hints, refine and video fallbacks (contract C5)
  keytermsFor, cleanTranscription, spliceRefinedRange, normalizeRange, refineJobIdFor, requestMedia, pickSubtitleTrack,
  subtitleTranscription, onScreenTranscription, estimateDurationFromSize, laneForDuration, shortLaneEnabled,
  createEnqueueDurationProbe, isVideoLike, getShortMediaQueue,
  QUEUE_NAME, SHORT_QUEUE_NAME, CONCURRENCY, SHORT_CONCURRENCY, SHORT_LANE_MAX_SEC, ATTEMPTS, PROCESS_TIMEOUT_MS, MAX_STALLED_COUNT, OWNERSHIP_CHECK_MS,
  RECONCILE_INTERVAL_MS, RECONCILE_MAX_ROWS, RECONCILE_PAGE_SIZE, RECONCILE_SELECT, MEDIA_MIME_FILTER,
};
