'use strict';

/**
 * media-handoff — when a media chat turn stops waiting and hands the job to
 * the durable delivery, and what the turn says when it does.
 *
 * A chat turn used to wait up to 12 h for a long recording while a deploy
 * (or the runtime watchdog) could end it at any moment, so the finished
 * transcript was never posted. Now the turn waits only while the job can
 * plausibly finish within TRANSCRIBE_CHAT_INLINE_WAIT_MS (240 s by default);
 * as soon as the job's ETA says otherwise it creates a delivery record and
 * ends with «te aviso aquí». An unknown ETA keeps waiting (a short clip is
 * often done before its first progress tick); the inline ceiling still
 * applies, so nothing waits for hours.
 *
 * Pure apart from the lazy media-delivery lookup.
 */

const DEFAULT_INLINE_WAIT_MS = 240_000;
const MAX_INLINE_WAIT_MS = 30 * 60_000;
// Mirrors the media queue's global concurrency: pending files are worked on
// two at a time, so their remaining work overlaps.
const MEDIA_PARALLEL_JOBS = 2;
const HANDOFF_GRACE_MS = 30_000;

function mediaInlineWaitMs(env = process.env) {
  const raw = env?.TRANSCRIBE_CHAT_INLINE_WAIT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_INLINE_WAIT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_INLINE_WAIT_MS;
  return Math.min(MAX_INLINE_WAIT_MS, Math.floor(value));
}

function loadMediaDeliveryService() {
  try {
    return require('./media-delivery');
  } catch (err) {
    console.warn('[media-handoff] media delivery unavailable', err?.code || err?.message || 'module_error');
    return null;
  }
}

/** Remaining seconds for one pending file, or null when nothing is known yet. */
function fileEtaSeconds(progress, delivery) {
  if (!progress || typeof progress !== 'object') return null;
  const eta = progress.etaSeconds == null || progress.etaSeconds === '' ? NaN : Number(progress.etaSeconds);
  if (Number.isFinite(eta) && eta >= 0) return eta;
  const duration = Number(progress.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || typeof delivery?.estimateTranscriptionSeconds !== 'function') return null;
  const total = Number(progress.total) || 0;
  const done = Math.min(total, Math.max(0, Number(progress.completed) || 0));
  const remainingFraction = total ? Math.max(0, (total - done) / total) : 1;
  let estimate = null;
  try { estimate = delivery.estimateTranscriptionSeconds({ durationSec: duration }); } catch (_) { estimate = null; }
  return Number.isFinite(Number(estimate)) && estimate !== null ? Math.round(Number(estimate) * remainingFraction) : null;
}

/**
 * Combined remaining seconds for the pending files of a batch, or null when
 * any pending file has no estimate yet.
 * @param {{files?: Array, pending?: number}|{rows: Array, progress?: object}} source
 */
function combinedEta(entries, delivery) {
  if (!entries.length) return 0;
  const etas = entries.map((entry) => fileEtaSeconds(entry, delivery));
  if (etas.some((eta) => eta === null)) return null;
  const sum = etas.reduce((total, eta) => total + eta, 0);
  return Math.round(sum / Math.min(entries.length, MEDIA_PARALLEL_JOBS));
}

/** waitForMediaBatch `shouldStop` predicate. */
function shouldHandOffMediaWait(progress = {}, { inlineWaitMs = DEFAULT_INLINE_WAIT_MS, delivery = null } = {}) {
  const pending = (progress.files || []).filter((file) => file.stage === 'pending');
  if (!pending.length) return false;
  const eta = combinedEta(pending.map((file) => file.progress || null), delivery);
  if (eta === null) return false;
  const remainingMs = Math.max(0, inlineWaitMs - (Number(progress.elapsedMs) || 0));
  return eta * 1000 > remainingMs + HANDOFF_GRACE_MS;
}

/** ETA (seconds) of a batch result returned by waitForMediaBatch, or null. */
function estimateMediaBatchEta(batch = {}, delivery = null) {
  const progress = batch.progress || {};
  const pending = (batch.rows || []).filter((row) => row?.processingStage !== 'failed'
    && (!String(row?.extractedText || '').trim() || ['uploaded', 'validating', 'extracting'].includes(row?.processingStage)));
  if (!pending.length) return null;
  return combinedEta(pending.map((row) => progress[row.id] || null), delivery);
}

function totalProgressDuration(batch = {}) {
  const progress = batch.progress || {};
  const total = Object.values(progress).reduce((sum, item) => sum + (Number(item?.durationSeconds) || 0), 0);
  return total > 0 ? total : null;
}

/**
 * Rows for the analysis step. With a time range the model reads only that
 * window (timestamped), never the whole recording.
 */
function mediaRowsForAnalysis(rows = [], transcripts = new Map(), range = null, { formatter = null } = {}) {
  if (!range) return rows;
  let fmt = formatter;
  try { fmt = fmt || require('./media-transcript-format'); } catch (_) { return rows; }
  const { transcriptResultFor } = require('./media-transcript-artifacts');
  return rows.map((row) => {
    const result = transcriptResultFor(row, transcripts.get(row.id));
    if (!result.segments.length) return row;
    try {
      const segments = fmt.sliceSegments(result.segments, { start: range.start, end: range.end ?? null });
      if (!segments?.length) return row;
      const text = fmt.renderText({ ...result, segments }, { fileName: row.originalName || row.filename, header: false });
      return String(text || '').trim() ? { ...row, extractedText: text } : row;
    } catch (_) {
      return row;
    }
  });
}

const FORMAT_LABELS = Object.freeze({ txt: 'TXT', docx: 'Word', pdf: 'PDF', srt: 'SRT', vtt: 'VTT' });

/** «Descarga la transcripción completa en TXT, Word, SRT y VTT (adjuntos).» */
function describeTranscriptDownloads(artifacts = []) {
  const formats = [];
  for (const artifact of artifacts) {
    const ext = String(artifact?.format || artifact?.filename || '').toLowerCase().split('.').pop();
    const label = FORMAT_LABELS[ext];
    if (label && !formats.includes(label)) formats.push(label);
  }
  if (!formats.length) return 'La descarga adjunta conserva las transcripciones completas, separadas por archivo.';
  const list = formats.length === 1 ? formats[0] : `${formats.slice(0, -1).join(', ')} y ${formats[formats.length - 1]}`;
  const subtitles = formats.includes('SRT') || formats.includes('VTT') ? ' Los archivos SRT y VTT sirven como subtítulos.' : '';
  return `La transcripción completa está en los adjuntos (${list}), con marcas de tiempo.${subtitles}`;
}

module.exports = {
  DEFAULT_INLINE_WAIT_MS,
  MEDIA_PARALLEL_JOBS,
  mediaInlineWaitMs,
  loadMediaDeliveryService,
  fileEtaSeconds,
  shouldHandOffMediaWait,
  estimateMediaBatchEta,
  totalProgressDuration,
  mediaRowsForAnalysis,
  describeTranscriptDownloads,
};
