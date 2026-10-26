'use strict';

// Durable delivery of long transcriptions into the chat that asked for them.
//
// A 5-hour recording takes longer than any chat turn can safely wait (every
// deploy reaps a turn that has been waiting for ~2 min). Instead, the turn
// leaves a delivery record (media-delivery-store) and finishes with «te aviso
// aquí». When every file of the record is terminal — ready, partial or failed
// — the media worker hook (onMediaTerminal) or the reconcile sweep posts the
// transcript, its downloads and any requested analysis into the origin chat,
// and sends an in-app + web-push notification.
//
// The message carries the honest report of each file (contract C6): its
// quality level, coverage and engines, the doubtful stretches, where the
// text came from (voice, the video's subtitles, the text on screen) and the
// notes the engine left, on the recording's clock and cut to the requested
// window like the downloads.
//
// A record of kind 'refine' («revisa del minuto 12 al 15, se escuchó mal»)
// posts one file's corrected window, «Corregí el tramo 00:12:00–00:15:00»,
// with the updated files. Its file is already ready, so it waits for the
// refine job's outcome (onMediaTerminal with `refine: true`), not for the
// file; a missed report is covered by the file's own state after a grace
// period, and the 24 h ceiling answers honestly.
//
// Every side effect is injected (tests use fakes only); the defaults lazily
// require the real modules so this file can be required from the media queue
// and the agent-task runner without load-order cycles.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const {
  createMediaDeliveryStore,
  isValidDeliveryId,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
} = require('./media-delivery-store');

const PARTIAL_RE = /^\s*parcial\b/i;
// metadata.source of every message this service posts. The duplicate check
// matches only these: the turn's «te aviso aquí» message also names the
// delivery and must never count as the delivered transcript.
const DELIVERY_SOURCE = 'media-delivery';
const DEFAULT_INLINE_WAIT_MS = 240000;
// Only orphaned files may expire here. A queued/active job can legitimately
// outlive a day (a batch, or up to 3 attempts × 12 h) and must still deliver.
const PENDING_CEILING_MS = 24 * 60 * 60 * 1000;
const SWEEP_OLD_INTERVAL_MS = 60 * 60 * 1000;
// A refine whose outcome report never arrived (a crash between the sidecar
// write and the hook) is posted from the file's state once the file was
// rewritten after the request and this long has passed.
const REFINE_HOOK_GRACE_MS = 30 * 60 * 1000;
// Two windows within half a second are the same window (the queue rounds to ms).
const RANGE_MATCH_TOLERANCE_SEC = 0.5;
const MAX_PER_SWEEP = 20;
const PREVIEW_CHARS = 4000;
const PREVIEW_FILES = 3;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Real-time factor (processing seconds per audio second) per engine family.
 * - local: whisper.cpp ggml-base WITH timestamps (no `-nt`), per worker
 *   thread pool; ≈ 0.15 measured class for base on the production CPU.
 * - local-turbo: whisper.cpp large-v3-turbo q5, per worker (≈ 1.5-2 h per
 *   5 h of audio with 2-3 workers).
 * - cloud: OpenAI / Groq / xAI / ElevenLabs including upload; providers
 *   already parallelise, so `parallel` does not divide it.
 * Preparation (probe + one segmentation pass) adds ≈ 30 s + 21 s per audio
 * hour (PREP_RTF 0.006).
 */
const TRANSCRIPTION_RTF = Object.freeze({ local: 0.15, 'local-turbo': 0.9, cloud: 0.02 });
const PREP_BASE_SECONDS = 30;
const PREP_RTF = 0.006;

const LANGUAGE_LABELS = Object.freeze({
  es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán',
  ca: 'catalán', gl: 'gallego', eu: 'euskera', nl: 'neerlandés', ru: 'ruso', ja: 'japonés',
  zh: 'chino', ko: 'coreano', ar: 'árabe',
});
const FORMAT_LABELS = Object.freeze({ docx: 'Word (DOCX)', srt: 'subtítulos SRT', vtt: 'subtítulos VTT', txt: 'TXT' });

// ── configuration ──────────────────────────────────────────────────────

/**
 * Kill switch. `SIRAGPT_MEDIA_DELIVERY=0` restores the inline wait. Default
 * ON, except under NODE_ENV=test where a suite must opt in with `=1` (so
 * existing media-turn tests keep their inline wait).
 */
function isMediaDeliveryEnabled(env = process.env) {
  const raw = String(env?.SIRAGPT_MEDIA_DELIVERY ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return env?.NODE_ENV !== 'test';
}

/** How long a chat turn may still wait inline (TRANSCRIBE_CHAT_INLINE_WAIT_MS, default 4 min). */
function inlineWaitMs(env = process.env) {
  const raw = String(env?.TRANSCRIBE_CHAT_INLINE_WAIT_MS ?? '').trim();
  if (!raw) return DEFAULT_INLINE_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INLINE_WAIT_MS;
}

// ── estimates and hand-off (pure) ──────────────────────────────────────

function engineFamily(engine) {
  const name = String(engine || 'local').trim().toLowerCase();
  if (/^(cloud|openai|groq|xai|grok|elevenlabs|scribe|deepgram|assembly|meta|gemini|voicestudio)/.test(name)) return 'cloud';
  if (/turbo|large/.test(name)) return 'local-turbo';
  return 'local';
}

/**
 * Seconds a transcription of `durationSec` audio should take on `engine`
 * (see TRANSCRIPTION_RTF). `parallel` = local workers. Unknown or
 * non-positive duration → null (the caller treats null as "long").
 */
function estimateTranscriptionSeconds({ durationSec, engine = 'local', parallel = 1 } = {}) {
  const duration = Number(durationSec);
  if (durationSec == null || !Number.isFinite(duration) || duration <= 0) return null;
  const family = engineFamily(engine);
  const workers = family === 'cloud' ? 1 : Math.min(16, Math.max(1, Math.floor(Number(parallel) || 1)));
  return Math.ceil(PREP_BASE_SECONDS + duration * PREP_RTF + duration * TRANSCRIPTION_RTF[family] / workers);
}

/**
 * Remaining seconds for a batch. Each pending file uses its live job ETA
 * (progress.etaSeconds), else its estimate scaled by progress.percent, else
 * the estimate from its duration (`durationSec`, or the job's
 * progress.durationSeconds). Files are { state?, durationSec?, progress? }. Any pending file without a duration or
 * ETA makes the whole batch unknown (null). Files are transcribed
 * `queueConcurrency` at a time.
 */
function estimateBatchEtaSeconds({ files = [], engine = 'local', parallel = 1, queueConcurrency = 2 } = {}) {
  const pending = (Array.isArray(files) ? files : []).filter(file => file && file.state !== 'ready'
    && file.state !== 'partial' && file.state !== 'failed');
  if (!pending.length) return 0;
  const etas = [];
  for (const file of pending) {
    const live = Number(file.progress?.etaSeconds);
    if (file.progress?.etaSeconds != null && Number.isFinite(live) && live > 0) { etas.push(live); continue; }
    const durationSec = file.durationSec ?? file.progress?.durationSeconds;
    const estimate = estimateTranscriptionSeconds({ durationSec, engine, parallel });
    if (estimate == null) return null;
    const percent = Number(file.progress?.percent);
    const left = Number.isFinite(percent) && percent > 0 && percent < 100 ? estimate * (1 - percent / 100) : estimate;
    etas.push(left);
  }
  const lanes = Math.max(1, Math.floor(Number(queueConcurrency) || 1));
  return Math.ceil(Math.max(Math.max(...etas), etas.reduce((sum, value) => sum + value, 0) / lanes));
}

/**
 * Whether the chat turn should finish now and deliver later. Nothing
 * pending → keep the inline path. Unknown ETA with pending media → hand off.
 * Disabled delivery → never hand off.
 */
function shouldHandOff({ etaSeconds = null, pendingCount = 0, env = process.env } = {}) {
  if (!(Number(pendingCount) > 0)) return false;
  if (!isMediaDeliveryEnabled(env)) return false;
  if (etaSeconds == null) return true;
  const eta = Number(etaSeconds);
  if (!Number.isFinite(eta) || eta < 0) return true;
  return eta * 1000 > inlineWaitMs(env);
}

function formatRemaining(seconds) {
  return require('./media-batch').formatRemaining(seconds);
}

function quoteName(name) {
  const text = String(name || 'archivo').replace(/[\r\n«»]+/g, ' ').trim() || 'archivo';
  return `«${text.length > 80 ? `${text.slice(0, 79)}…` : text}»`;
}

function listNames(names, max = 3) {
  const quoted = names.map(quoteName);
  if (quoted.length <= 1) return quoted.join('');
  if (quoted.length <= max) return `${quoted.slice(0, -1).join(', ')} y ${quoted[quoted.length - 1]}`;
  return `${quoted.slice(0, max).join(', ')} y ${quoted.length - max} más`;
}

/** «≈5 h», «≈1 h 30 min», «≈45 min». */
function formatApproxDuration(seconds) {
  const s = Number(seconds);
  if (seconds == null || !Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return 'menos de 1 min';
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `≈${minutes} min`;
  const rounded = Math.round(minutes / 5) * 5;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m ? `≈${h} h ${m} min` : `≈${h} h`;
}

/** «5 h 2 min», «12 min», «40 s». */
function formatDuration(seconds) {
  const s = Number(seconds);
  if (seconds == null || !Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const minutes = Math.round(s / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 01:20:00 (or 04:05 when the recording is under an hour). */
function formatClock(seconds, withHours = true) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return withHours || h ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function formatCount(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  if (value < 10000) return String(value);
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Chat copy when the turn hands off: «Recibí «clase.mp4» (≈5 h). La
 * transcripción tarda ~47 min; te aviso aquí y en notificaciones cuando
 * termine. Puedes seguir usando el chat.»
 */
function handOffMessage({ fileNames = [], durationSec = null, etaSeconds = null } = {}) {
  const names = (Array.isArray(fileNames) ? fileNames : []).filter(name => typeof name === 'string' && name.trim());
  const many = names.length > 1;
  const approx = formatApproxDuration(durationSec);
  let received;
  if (!names.length) received = approx ? `Recibí tu archivo (${approx}).` : 'Recibí tu archivo.';
  else if (!many) received = `Recibí ${quoteName(names[0])}${approx ? ` (${approx})` : ''}.`;
  else received = `Recibí ${names.length} archivos (${listNames(names)}${approx ? `; ${approx} en total` : ''}).`;
  const subject = many ? 'Las transcripciones' : 'La transcripción';
  const eta = Number(etaSeconds);
  let timing;
  if (etaSeconds == null || !Number.isFinite(eta) || eta < 0) {
    timing = `Todavía no sé cuánto ${many ? 'tardarán las transcripciones' : 'tardará la transcripción'}`;
  } else if (eta < 90) {
    timing = `${subject} ${many ? 'tardarán' : 'tardará'} menos de 2 min`;
  } else {
    timing = `${subject} ${many ? 'tardan' : 'tarda'} ~${formatRemaining(eta)}`;
  }
  return `${received} ${timing}; te aviso aquí y en notificaciones cuando ${many ? 'terminen' : 'termine'}. Puedes seguir usando el chat.`;
}

// ── file states ────────────────────────────────────────────────────────

function hasUsableTranscript(row) {
  return require('./media-transcription-queue').hasTranscript(row);
}

/** 'ready' | 'partial' | 'failed' | 'pending' for a File row (text loaded). */
function classifyFileRow(row) {
  if (!row || row.missing || row.deletedAt) return 'failed';
  if (row.processingStage === 'failed') return 'failed';
  if (hasUsableTranscript(row)) return PARTIAL_RE.test(String(row.processingError || '')) ? 'partial' : 'ready';
  // A terminal stage without usable text (placeholder) is not deliverable.
  if (row.processingStage === 'ready') return 'failed';
  return 'pending';
}

/** Terminal check that does not need extractedText (stage only). */
function isTerminalRow(row) {
  if (!row || row.missing || row.deletedAt) return true;
  if (row.processingStage === 'ready' || row.processingStage === 'failed') return true;
  return row.extractedText != null && hasUsableTranscript(row);
}

function stateOf(row) {
  return row?.deliveryState || classifyFileRow(row);
}

function isUsableRow(row) {
  const state = stateOf(row);
  return state === 'ready' || state === 'partial';
}

function summarizeStates(rows = []) {
  const counts = { total: rows.length, ready: 0, partial: 0, failed: 0, pending: 0 };
  for (const row of rows) counts[stateOf(row)]++;
  return counts;
}

function stoppedReasonFor(counts) {
  if (counts.total && counts.failed === counts.total) return 'media_batch_failed';
  if (counts.partial || counts.failed || counts.pending) return 'media_batch_partial';
  return 'transcription_finalize';
}

function displayName(row, delivery = {}, index = 0) {
  return row?.originalName || row?.filename || delivery?.fileNames?.[index] || 'archivo';
}

function cleanReason(text, max = 200) {
  const value = String(text || '').replace(/[\r\n\t]+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** «1 de 30 tramos fallaron» from «Parcial: 1 de 30 tramos fallaron. Reintentar…». */
function partialDetail(row) {
  const text = cleanReason(String(row?.processingError || '').replace(PARTIAL_RE, '').replace(/^[\s:.-]+/, ''));
  return text.split(/\.\s/)[0].replace(/\.$/, '').trim();
}

function gapsOf(transcript) {
  return (Array.isArray(transcript?.gaps) ? transcript.gaps : [])
    .map(gap => ({ start: Number(gap?.start), end: Number(gap?.end) }))
    .filter(gap => Number.isFinite(gap.start) && Number.isFinite(gap.end) && gap.end > gap.start);
}

function formatGaps(gaps, max = 8) {
  const withHours = gaps.some(gap => gap.end >= 3600);
  const parts = gaps.map(gap => `${formatClock(gap.start, withHours)}–${formatClock(gap.end, withHours)}`);
  if (parts.length <= 1) return parts.join('');
  if (parts.length <= max) return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
  return `${parts.slice(0, max).join(', ')} y ${parts.length - max} más`;
}

function languageLabel(code) {
  const key = String(code || '').toLowerCase().split('-')[0];
  return LANGUAGE_LABELS[key] || (key || '');
}

function wordCount(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function escapeChatMarkdown(value) {
  return String(value || '')
    .replace(/[\\`*_[\]<>|~]/g, ch => `\\${ch}`)
    .replace(/^(\s*)(\d+)([.)]\s)/gm, (_m, lead, num, rest) => `${lead}${num}\\${rest}`)
    .replace(/^(\s*)(#{1,6}\s|[-+]\s|={3,}|-{3,})/gm, (_m, lead, marker) => `${lead}\\${marker}`);
}

/** Cut at a paragraph (or sentence) boundary so a preview never ends mid-word. */
function cutAtParagraph(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return { text: value, truncated: false };
  const floor = Math.floor(max * 0.5);
  let cut = value.lastIndexOf('\n\n', max);
  if (cut < floor) {
    const sentence = value.lastIndexOf('. ', max);
    cut = sentence >= floor ? sentence + 1 : value.lastIndexOf(' ', max);
  }
  if (cut < floor) cut = max;
  return { text: value.slice(0, cut).trim(), truncated: true };
}

function rangeOf(delivery) {
  const range = delivery?.range;
  if (!range || !Number.isFinite(Number(range.start))) return null;
  const end = range.end == null ? null : Number(range.end);
  return { start: Number(range.start), end: Number.isFinite(end) ? end : null };
}

/** The window and clock the attachments use (media-transcript-artifacts output). */
function viewOutput(delivery) {
  const offset = Number(delivery?.output?.timeOffsetSec);
  return { range: rangeOf(delivery), timeOffsetSec: Number.isFinite(offset) && offset > 0 ? offset : 0 };
}

/**
 * One file as its attachments show it: on the recording's clock and cut to
 * the requested range, so the chat never contradicts the downloads. null
 * when the delivery has neither (the stored text is shown as is).
 */
function viewOf(row, transcript, delivery) {
  const output = viewOutput(delivery);
  if (!output.range && !output.timeOffsetSec) return null;
  try {
    return require('./media-transcript-artifacts').transcriptView(row, transcript, output);
  } catch (_) { return null; }
}

/** Gaps on the recording's clock, clipped to the requested range. */
function visibleGaps(transcript, delivery) {
  const output = viewOutput(delivery);
  let shift = 0;
  try { shift = require('./media-transcript-artifacts').clockOffsetFor(transcript, output); } catch (_) { shift = 0; }
  const { range } = output;
  return gapsOf(transcript)
    .map(gap => ({ start: gap.start + shift, end: gap.end + shift }))
    .map(gap => (range ? { start: Math.max(gap.start, range.start), end: range.end == null ? gap.end : Math.min(gap.end, range.end) } : gap))
    .filter(gap => gap.end > gap.start);
}

/** The text a preview cuts: the window or shifted clock when the delivery has one. */
function previewSource(row, view) {
  if (!view || !(view.sliced || view.shifted)) return row?.extractedText;
  try {
    const text = require('./media-transcript-format').renderText(view.result, { fileName: displayName(row), header: false });
    if (String(text || '').trim()) return text;
  } catch (_) { return row?.extractedText; }
  return view.sliced ? '(Sin voz transcrita en este tramo.)' : row?.extractedText;
}

/**
 * The stored text of a transcript that does not come from the voice opens
 * with its source note in parentheses («(El video no tiene audio; …)»);
 * the report above the preview already says it, so the preview drops it.
 */
function stripLeadingSourceNote(text, transcript) {
  const value = String(text || '');
  for (const note of Array.isArray(transcript?.quality?.notes) ? transcript.quality.notes : []) {
    const prefix = `(${note})`;
    if (note && value.startsWith(prefix)) return value.slice(prefix.length).replace(/^\s+/, '');
  }
  return value;
}

function fileDetails(row, transcript, delivery, view = null) {
  const parts = [];
  const duration = formatDuration(transcript?.durationSec);
  if (duration) parts.push(duration);
  const language = languageLabel(transcript?.language || delivery?.language);
  if (language) parts.push(language);
  // A requested range counts its own words and coverage.
  const words = wordCount(view?.sliced ? view.result.text : row?.extractedText);
  if (words) parts.push(`${formatCount(words)} palabras`);
  const coverage = Number(view?.sliced ? view.result.coverage : transcript?.coverage);
  // A window with neither speech nor gaps has no coverage of its own (the
  // formatter keeps the whole recording's figure); none is shown.
  const emptyWindow = Boolean(view?.sliced) && !view.result.segments.length && !view.result.gaps.length;
  if (stateOf(row) === 'partial' && !emptyWindow && Number.isFinite(coverage) && coverage > 0 && coverage < 1) {
    parts.push(`cobertura ${Math.floor(coverage * 100)} %`);
  }
  return parts;
}

/**
 * The audio the file holds when the requested window misses it entirely
 * («del minuto 333 al 350» of a 5 h recording, or a window before a clip's
 * offset); null when the window overlaps it or the span is unknown.
 */
function spanOutsideRange(delivery, view) {
  const range = rangeOf(delivery);
  const span = view?.span;
  if (!range || !span || span.end == null) return null;
  const overlaps = range.start < span.end && (range.end == null || range.end > span.start);
  return overlaps ? null : span;
}

/** «05:33:20–05:50:00» and «queda fuera de la grabación, que dura 5 h». */
function outsideRecordingDetail(delivery, span) {
  const range = rangeOf(delivery);
  const withHours = Math.max(range.end ?? range.start, span.end) >= 3600;
  const asked = range.end != null
    ? `${formatClock(range.start, withHours)}–${formatClock(range.end, withHours)}`
    : `desde ${formatClock(range.start, withHours)}`;
  const where = span.start > 0
    ? `queda fuera del tramo transcrito de la grabación (${formatClock(span.start, withHours)}–${formatClock(span.end, withHours)})`
    : `queda fuera de la grabación, que dura ${formatDuration(span.end)}`;
  return { asked, where };
}

function outsideRecordingSentence(delivery, span) {
  const { asked, where } = outsideRecordingDetail(delivery, span);
  return `El tramo que pediste (${asked}) ${where}.`;
}

function missingPartsSentence(row, transcript, delivery, view = null) {
  const gaps = visibleGaps(transcript, delivery);
  if (gaps.length) return `Faltan ${gaps.length === 1 ? 'este tramo' : 'estos tramos'}: ${formatGaps(gaps)}.`;
  const outside = spanOutsideRange(delivery, view);
  if (outside) return outsideRecordingSentence(delivery, outside);
  if (rangeOf(delivery) && gapsOf(transcript).length) return 'El tramo que pediste está completo; faltan otros tramos de la grabación.';
  const detail = partialDetail(row);
  return detail ? `No se pudieron transcribir algunos tramos (${detail}).` : 'No se pudieron transcribir algunos tramos.';
}

// ── honest quality report (contract C6) ──────────────────────────────

function artifactsModule() {
  try { return require('./media-transcript-artifacts'); } catch (_) { return null; }
}

/**
 * The file as the delivery shows it (recording clock, requested window),
 * whether or not the delivery has a range or an offset: the report needs
 * the transcript's quality, source and side texts in every case.
 */
function reportViewOf(row, transcript, delivery) {
  if (!transcript) return null;
  const pack = artifactsModule();
  if (!pack?.transcriptView) return null;
  try { return pack.transcriptView(row, transcript, viewOutput(delivery)); } catch (_) { return null; }
}

// ── what the downloads are (roles survive the artifact store's renaming) ──

const TRANSCRIPT_FILE_FORMATS = new Set(['txt', 'docx', 'pdf']);
const SUBTITLE_FILE_FORMATS = new Set(['srt', 'vtt']);

function artifactFormatOf(artifact) {
  const name = String(artifact?.filename || '');
  return String(artifact?.format || (name.includes('.') ? name.split('.').pop() : '') || '').toLowerCase();
}

/**
 * The role of a file the transcript builder produced: its own tag
 * (media-transcript-artifacts tags every deliverable), else read from its
 * format (a builder that tags nothing): TXT/Word/PDF are the transcript.
 */
function transcriptSpecRole(spec) {
  if (typeof spec?.role === 'string' && spec.role) return spec.role;
  const format = artifactFormatOf(spec);
  if (TRANSCRIPT_FILE_FORMATS.has(format)) return 'transcript';
  if (SUBTITLE_FILE_FORMATS.has(format)) return 'subtitles';
  return null;
}

function withRole(spec, role) {
  return role && spec && typeof spec === 'object' && spec.role !== role ? { ...spec, role } : spec;
}

/**
 * Whether the message carries the transcript TXT/Word/PDF (not only a
 * translation or nothing). Untagged lists (direct callers) are read by format.
 */
function transcriptFilesIn(artifacts) {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter(artifact => artifact?.filename);
  if (list.some(artifact => typeof artifact.role === 'string')) return list.some(artifact => artifact.role === 'transcript');
  return list.some(artifact => TRANSCRIPT_FILE_FORMATS.has(artifactFormatOf(artifact)));
}

/** «clase (subtítulos).srt» as the artifact store saves it (task-tools.sanitizeArtifactFilename). */
function storedArtifactName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Whether the downloads carry the file's embedded subtitle track as its own SRT. */
function embeddedTrackAttached(row, delivery, artifacts) {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter(artifact => artifact?.filename);
  if (list.some(artifact => artifact.role === 'embedded_subtitles' && (!artifact.sourceFileId || artifact.sourceFileId === row?.id))) return true;
  const pack = artifactsModule();
  if (!pack?.embeddedSubtitlesName) return false;
  let name;
  try { name = pack.embeddedSubtitlesName(row, rangeOf(delivery)); } catch (_) { return false; }
  const stored = storedArtifactName(name);
  return list.some(artifact => artifact.filename === name || artifact.filename === stored);
}

/**
 * The quality report of one usable file, or null for a transcript without
 * one (an older sidecar keeps today's message exactly). `coverageShown`:
 * the details line already printed the coverage (partial files).
 * `transcriptFilesAttached`: the message carries the transcript files
 * (default: read from `artifacts`).
 */
function qualityReportFor(row, transcript, delivery, { artifacts = [], coverageShown = false, transcriptFilesAttached = null } = {}) {
  const view = reportViewOf(row, transcript, delivery);
  if (!view?.result) return null;
  const outside = spanOutsideRange(delivery, view);
  const emptyWindow = Boolean(view.sliced) && !view.result.segments.length && !view.result.gaps.length;
  const pack = artifactsModule();
  let report = null;
  try {
    report = pack.transcriptQualityReport(view.result, { includeCoverage: !coverageShown && !outside && !emptyWindow,
      embeddedAttached: embeddedTrackAttached(row, delivery, artifacts),
      transcriptFilesAttached: typeof transcriptFilesAttached === 'boolean' ? transcriptFilesAttached : transcriptFilesIn(artifacts) });
  } catch (_) { report = null; }
  if (!report?.hasReport) return null;
  return { ...report, view };
}

/** «revisa del minuto 12 al 14»: an example built from the first doubtful stretch. */
function refineExample(report) {
  const first = report?.view?.result?.quality?.lowConfidence?.[0];
  const start = Number(first?.start);
  const end = Number(first?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'revisa del minuto 12 al 15';
  const from = Math.floor(start / 60);
  const to = Math.max(from + 1, Math.ceil(end / 60));
  return `revisa del minuto ${from} al ${to}`;
}

/** The report as chat blocks: the line, the doubtful stretches, the notes and the repair hint. */
function qualityBlocks(report) {
  if (!report) return [];
  const blocks = [];
  if (report.line) blocks.push(escapeChatMarkdown(report.line));
  if (report.doubtful) blocks.push(`Tramos dudosos: ${escapeChatMarkdown(report.doubtful)}`);
  if (report.notes.length) blocks.push(report.notes.map(note => escapeChatMarkdown(cleanReason(note, 300))).join(' '));
  if (report.doubtfulCount && !report.authored) {
    blocks.push(`Si algún tramo se escuchó mal, dime «${refineExample(report)}» (y los nombres que esperas) y lo vuelvo a transcribir.`);
  }
  return blocks;
}

/** « · calidad media · 2 tramos dudosos · desde el texto en pantalla» for a batch line, or ''. */
function qualitySuffix(report) {
  if (!report) return '';
  const parts = [];
  if (report.level) parts.push(`calidad ${report.level}`);
  if (report.doubtfulCount) parts.push(`${report.doubtfulCount} ${report.doubtfulCount === 1 ? 'tramo dudoso' : 'tramos dudosos'}`);
  if (report.sourceShort) parts.push(report.sourceShort);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/**
 * Spanish chat message for a finished delivery: headline, per-file status
 * (gaps for partial files, reasons for failures), the quality report, the
 * analysis or a preview, the downloads and the retry hint.
 */
function deliveryMessage({ delivery = {}, rows = [], transcripts = {}, artifacts = [], analysisText = '', analysisFailed = false,
  analysisNotes = [], translationFailed = [], summaryText = '', summaryFailed = false, transcriptFilesAttached = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // The report may point at a section of the transcript files only when they are attached.
  const filesAttached = typeof transcriptFilesAttached === 'boolean' ? transcriptFilesAttached : transcriptFilesIn(artifacts);
  const counts = summarizeStates(list);
  const single = list.length === 1;
  const blocks = [];
  const transcriptOf = row => transcripts?.[row?.id] || null;
  const views = new Map();
  const viewFor = row => {
    if (!views.has(row)) views.set(row, isUsableRow(row) ? viewOf(row, transcriptOf(row), delivery) : null);
    return views.get(row);
  };

  if (single) {
    const row = list[0];
    const name = quoteName(displayName(row, delivery, 0));
    const state = stateOf(row);
    blocks.push({
      ready: `**Tu transcripción de ${name} está lista.**`,
      partial: `**La transcripción de ${name} terminó parcialmente.**`,
      failed: `**No pude transcribir ${name}.**`,
      pending: `**${name} sigue en la cola de transcripción.**`,
    }[state]);
    const details = fileDetails(row, transcriptOf(row), delivery, viewFor(row));
    if (details.length && (state === 'ready' || state === 'partial')) blocks.push(details.join(' · '));
    if (state === 'ready' || state === 'partial') {
      const coverageShown = details.some(part => part.startsWith('cobertura '));
      blocks.push(...qualityBlocks(qualityReportFor(row, transcriptOf(row), delivery, { artifacts, coverageShown,
        transcriptFilesAttached: filesAttached })));
    }
    const outside = spanOutsideRange(delivery, viewFor(row));
    if (state === 'partial') blocks.push(missingPartsSentence(row, transcriptOf(row), delivery, viewFor(row)));
    else if (state === 'ready' && outside) blocks.push(outsideRecordingSentence(delivery, outside));
    if (state === 'failed' && row?.processingError) blocks.push(`Motivo: ${cleanReason(row.processingError)}`);
  } else {
    const n = counts.total;
    if (counts.ready === n) blocks.push(`**Las transcripciones de tus ${n} archivos están listas.**`);
    else if (counts.failed === n) blocks.push(`**No pude transcribir ninguno de tus ${n} archivos.**`);
    else {
      const parts = [
        counts.ready ? `${counts.ready} ${counts.ready === 1 ? 'completo' : 'completos'}` : '',
        counts.partial ? `${counts.partial} ${counts.partial === 1 ? 'parcial' : 'parciales'}` : '',
        counts.failed ? `${counts.failed} con error` : '',
        counts.pending ? `${counts.pending} ${counts.pending === 1 ? 'pendiente' : 'pendientes'}` : '',
      ].filter(Boolean);
      blocks.push(`**Terminé con tus ${n} archivos: ${parts.join(', ')}.**`);
    }
    blocks.push(list.map((row, index) => {
      const name = quoteName(displayName(row, delivery, index));
      const state = stateOf(row);
      const transcript = transcriptOf(row);
      const outside = spanOutsideRange(delivery, viewFor(row));
      if (state === 'ready') {
        const details = fileDetails(row, transcript, delivery, viewFor(row));
        const where = outside ? ` · el tramo pedido ${outsideRecordingDetail(delivery, outside).where}` : '';
        const quality = qualitySuffix(qualityReportFor(row, transcript, delivery, { artifacts, coverageShown: true,
          transcriptFilesAttached: filesAttached }));
        return `- ${name}: lista${details.length ? ` · ${details.join(' · ')}` : ''}${quality}${where}`;
      }
      if (state === 'partial') {
        const gaps = visibleGaps(transcript, delivery);
        if (!gaps.length && outside) return `- ${name}: el tramo pedido ${outsideRecordingDetail(delivery, outside).where}`;
        if (!gaps.length && rangeOf(delivery) && gapsOf(transcript).length) {
          return `- ${name}: tramo pedido completo (faltan otros tramos de la grabación)`;
        }
        const detail = gaps.length ? `faltan ${formatGaps(gaps, 4)}` : (partialDetail(row) || 'faltan algunos tramos');
        const quality = qualitySuffix(qualityReportFor(row, transcript, delivery, { artifacts, coverageShown: true,
          transcriptFilesAttached: filesAttached }));
        return `- ${name}: parcial (${detail})${quality}`;
      }
      if (state === 'failed') return `- ${name}: no se pudo transcribir${row?.processingError ? ` (${cleanReason(row.processingError, 120)})` : ''}`;
      return `- ${name}: sigue en la cola`;
    }).join('\n'));
  }

  const range = delivery?.range;
  if (range && Number.isFinite(Number(range.start))) {
    const withHours = Number(range.end || range.start) >= 3600;
    blocks.push(range.end != null
      ? `Tramo pedido: ${formatClock(range.start, withHours)}–${formatClock(range.end, withHours)}.`
      : `Tramo pedido: desde ${formatClock(range.start, withHours)}.`);
  }

  const usable = list.filter(isUsableRow);
  const translating = delivery?.mode === 'translation';
  const hasAnalysis = Boolean(analysisText && String(analysisText).trim());
  const analysisFailedCopy = 'No pude terminar el análisis que pediste. La transcripción está guardada; vuelve a pedírmelo en este chat cuando quieras.';
  // «resume y tradúcelo»: the summary leads, the translation follows.
  if (summaryText && String(summaryText).trim()) blocks.push(`### Análisis\n\n${String(summaryText).trim()}`);
  else if (summaryFailed && usable.length) blocks.push(analysisFailedCopy);
  if (hasAnalysis) {
    blocks.push(`### ${translating ? 'Traducción' : 'Análisis'}\n\n${String(analysisText).trim()}`);
  } else if (analysisFailed && usable.length) {
    blocks.push(translating
      ? 'No pude terminar la traducción que pediste. La transcripción está guardada; vuelve a pedírmela en este chat cuando quieras.'
      : analysisFailedCopy);
  }
  const untranslated = (Array.isArray(translationFailed) ? translationFailed : [])
    .map(file => (typeof file === 'string' ? file : file?.name || file?.id)).filter(Boolean);
  if (translating && hasAnalysis && untranslated.length) {
    blocks.push(`No pude traducir ${listNames(untranslated)}. ${untranslated.length === 1 ? 'Su transcripción sigue guardada' : 'Sus transcripciones siguen guardadas'}; vuelve a pedirme la traducción en este chat cuando quieras.`);
  }
  for (const note of Array.isArray(analysisNotes) ? analysisNotes : []) {
    if (typeof note === 'string' && note.trim()) blocks.push(cleanReason(note, 300));
  }

  if (usable.length && !hasAnalysis) {
    const shown = usable.slice(0, PREVIEW_FILES);
    const budget = Math.floor(PREVIEW_CHARS / shown.length);
    let truncated = usable.length > shown.length;
    const pieces = shown.map(row => {
      const cut = cutAtParagraph(stripLeadingSourceNote(previewSource(row, viewFor(row)), transcriptOf(row)), budget);
      truncated = truncated || cut.truncated;
      const body = escapeChatMarkdown(cut.text);
      return single ? body : `#### ${escapeChatMarkdown(quoteName(displayName(row, delivery, list.indexOf(row))))}\n\n${body}`;
    });
    blocks.push(`### ${truncated ? 'Vista previa' : 'Transcripción'}\n\n${pieces.join('\n\n')}`);
    if (truncated) blocks.push('_Vista previa. Descarga el archivo adjunto para leer la transcripción completa._');
  }

  const files = (Array.isArray(artifacts) ? artifacts : []).filter(artifact => artifact?.filename);
  if (usable.length) {
    const produced = new Set(files.map(artifact => String(artifact.format || artifact.filename.split('.').pop() || '').toLowerCase()));
    const missing = (Array.isArray(delivery?.formats) ? delivery.formats : []).filter(format => !produced.has(format));
    if (files.length && missing.length) {
      blocks.push(`No pude generar ${missing.map(format => FORMAT_LABELS[format] || format.toUpperCase()).join(' ni ')}; te dejo la transcripción en ${produced.has('txt') ? 'TXT' : 'los archivos adjuntos'}.`);
    }
    if (files.length) blocks.push(`**Descargas:** ${files.map(artifact => escapeChatMarkdown(artifact.filename)).join(' · ')}`);
  }

  if (counts.partial || counts.failed) {
    blocks.push(usable.length
      ? 'Escribe «reintenta» en este chat para recuperar solo lo que falta; lo demás sigue guardado.'
      : `Escribe «reintenta» en este chat para intentarlo de nuevo sin volver a subir ${single ? 'el archivo' : 'los archivos'}.`);
  }
  if (counts.pending) blocks.push('Lo que sigue en la cola continúa transcribiéndose; pídeme su estado más tarde en este chat.');
  if (usable.length) blocks.push(`Puedes seguir preguntándome sobre ${single ? 'esta grabación' : 'estas grabaciones'} en este chat.`);
  return blocks.filter(Boolean).join('\n\n');
}

// ── refine (contract C6) ───────────────────────────────────────────────

function isRefineRecord(record) {
  return record?.kind === 'refine';
}

/** «00:12:00–00:15:00»: a refined window always prints hh:mm:ss. */
function refineRangeLabel(range) {
  if (!range || !Number.isFinite(Number(range.start))) return '';
  const end = range.end == null ? null : Number(range.end);
  return end == null ? `desde ${formatClock(range.start, true)}` : `${formatClock(range.start, true)}–${formatClock(end, true)}`;
}

function sameRange(a, b) {
  if (!a || !b) return false;
  const end = value => (value == null ? null : Number(value));
  const close = (x, y) => (x == null || y == null ? x === y : Math.abs(x - y) <= RANGE_MATCH_TOLERANCE_SEC);
  return close(Number(a.start), Number(b.start)) && close(end(a.end), end(b.end));
}

/**
 * The media queue's dedup key of a refine request (refineJobIdFor): the
 * window to the millisecond, the language and the normalized hints. Two
 * records with the same key were served by the same job.
 */
function refineJobKeyOf(record) {
  const ms = value => (value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 1000) / 1000);
  const hints = record?.hints && typeof record.hints === 'object' && !Array.isArray(record.hints) ? record.hints : null;
  let language = null;
  let normalized = null;
  try {
    const fmt = require('./media-transcript-format');
    language = fmt.normalizeHintLanguage(record?.language) || (hints ? fmt.normalizeHintLanguage(hints.language) : null) || null;
    normalized = fmt.normalizeMediaHints(hints) || null;
  } catch (_) {
    language = typeof record?.language === 'string' ? record.language.toLowerCase() : null;
    normalized = hints;
  }
  return JSON.stringify([ms(record?.range?.start), ms(record?.range?.end), language, normalized]);
}

function rangesOverlap(a, b) {
  if (!a || !b) return false;
  const aEnd = a.end == null ? Infinity : Number(a.end);
  const bEnd = b.end == null ? Infinity : Number(b.end);
  return Number(a.start) < bEnd && Number(b.start) < aEnd;
}

function toMs(value) {
  if (value == null || value === '') return NaN;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/** The file row was rewritten (a job finished) after the refine was requested. */
function rewrittenSince(row, record) {
  const stageAt = toMs(row?.processingStageAt);
  const createdAt = toMs(record?.createdAt);
  return Number.isFinite(stageAt) && Number.isFinite(createdAt) && stageAt > createdAt;
}

/**
 * A refine record still waiting for its job's outcome. It stops waiting
 * when the worker reported one, when its file is gone or failed (nothing
 * to wait for), or when the outcome report was evidently missed: the file
 * was rewritten after the request and REFINE_HOOK_GRACE_MS have passed.
 */
function awaitingRefineOutcome(record, row, nowMs, graceMs = REFINE_HOOK_GRACE_MS) {
  if (!isRefineRecord(record)) return false;
  if (record.refine?.status === 'ok' || record.refine?.status === 'failed') return false;
  if (!row || row.missing || row.deletedAt || row.processingStage === 'failed') return false;
  const createdAt = toMs(record.createdAt);
  if (Number.isFinite(createdAt) && nowMs - createdAt >= graceMs && rewrittenSince(row, record)) return false;
  return true;
}

/**
 * What to post for a refine: the reported outcome, else one inferred from
 * the file (`inferred: true` — the copy then claims no correction).
 */
function resolveRefineOutcome(record, row) {
  const stored = record?.refine;
  if (stored?.status === 'ok' || stored?.status === 'failed') {
    return { status: stored.status, unchanged: stored.unchanged === true, code: stored.code || null, inferred: false };
  }
  if (row && !row.missing && !row.deletedAt && row.processingStage !== 'failed' && rewrittenSince(row, record)) {
    return { status: 'ok', unchanged: false, code: null, inferred: true };
  }
  return { status: 'failed', unchanged: false, code: 'refine_timeout', inferred: true };
}

const REFINE_FAILURE_ES = Object.freeze({
  refine_not_ready: 'la transcripción de este archivo todavía no estaba lista',
  refine_untimed: 'el motor no devolvió marcas de tiempo para ese tramo',
  refine_incomplete: 'no se pudo volver a transcribir todo el tramo',
  invalid_range: 'el tramo queda fuera de la grabación',
  no_speech: 'no se detectó voz en ese tramo',
  no_audio_track: 'el archivo no tiene pista de audio que volver a transcribir',
  refine_timeout: 'la corrección no terminó a tiempo',
  media_timeout: 'la corrección superó el tiempo permitido',
  media_not_found: 'el archivo ya no está disponible',
});

function refineFailureReason(code) {
  return REFINE_FAILURE_ES[String(code || '')] || 'no se pudo volver a transcribir ese tramo';
}

/** The refined window as text on the recording's clock, escaped and bounded. */
function refineWindowPreview(row, transcript, delivery) {
  const view = reportViewOf(row, transcript, delivery);
  let text = '';
  if (view?.sliced) {
    try {
      text = require('./media-transcript-format').renderText(view.result, { fileName: displayName(row), header: false });
    } catch (_) { text = ''; }
  }
  if (!String(text || '').trim()) return { body: '', truncated: false, view };
  const cut = cutAtParagraph(text, PREVIEW_CHARS);
  return { body: escapeChatMarkdown(cut.text), truncated: cut.truncated, view };
}

/**
 * Spanish chat message for a refine: «Corregí el tramo 00:12:00–00:15:00 de
 * «clase.mp4».» with the corrected window, what is still doubtful in it and
 * the updated downloads; or an honest «no pude» / «no cambió».
 */
function refineMessage({ delivery = {}, rows = [], transcripts = {}, artifacts = [], outcome = null } = {}) {
  const row = (Array.isArray(rows) ? rows : [])[0] || null;
  const name = quoteName(displayName(row, delivery, 0));
  const label = refineRangeLabel(rangeOf(delivery));
  const result = outcome || resolveRefineOutcome(delivery, row);
  const blocks = [];
  if (!row || !isUsableRow(row)) {
    blocks.push(`**No pude corregir el tramo ${label} de ${name}.**`);
    if (!row || row.missing || row.deletedAt) {
      blocks.push(row?.processingError ? `Motivo: ${cleanReason(row.processingError)}` : 'Motivo: el archivo ya no está disponible.');
    } else if (stateOf(row) === 'pending') {
      // The file exists and is still being transcribed (the 24 h ceiling came first).
      blocks.push(`Motivo: ${REFINE_FAILURE_ES.refine_not_ready}.`);
      blocks.push('La transcripción sigue en curso. Cuando esté lista, pídeme de nuevo en este chat que revise ese tramo.');
    } else {
      blocks.push(row.processingError ? `Motivo: ${cleanReason(row.processingError)}` : 'Motivo: este archivo no tiene una transcripción que corregir.');
    }
    return blocks.join('\n\n');
  }
  const transcript = transcripts?.[row.id] || null;
  if (result.status === 'failed') {
    blocks.push(`**No pude corregir el tramo ${label} de ${name}.**`);
    blocks.push(`Motivo: ${refineFailureReason(result.code)}.`);
    blocks.push('La transcripción sigue como estaba. Puedes pedírmelo de nuevo en este chat, por ejemplo con los nombres o el idioma que esperas.');
    return blocks.join('\n\n');
  }
  if (result.inferred) blocks.push(`**Aquí tienes el tramo ${label} de ${name} con la transcripción más reciente.**`);
  else if (result.unchanged) blocks.push(`**Volví a transcribir el tramo ${label} de ${name}.**`);
  else blocks.push(`**Corregí el tramo ${label} de ${name}.**`);
  if (result.unchanged) blocks.push('El resultado coincide con la transcripción anterior, así que no cambié nada.');
  if (result.inferred) blocks.push('No recibí la confirmación de la corrección; si todavía se escucha mal, pídemelo de nuevo.');
  const preview = refineWindowPreview(row, transcript, delivery);
  const report = preview.view?.result ? qualityReportFor(row, transcript, delivery, { artifacts, coverageShown: true }) : null;
  if (report?.doubtful) blocks.push(`Todavía hay dudas en este tramo: ${escapeChatMarkdown(report.doubtful)}.`);
  blocks.push(`### ${result.unchanged ? 'Lo que se escucha en ese tramo' : 'Tramo corregido'}\n\n${preview.body || '(Sin voz transcrita en este tramo.)'}`);
  if (preview.truncated) blocks.push('_Vista previa del tramo. Los archivos adjuntos tienen la transcripción completa._');
  const files = (Array.isArray(artifacts) ? artifacts : []).filter(artifact => artifact?.filename);
  if (files.length) {
    blocks.push(`**Descargas:** ${files.map(artifact => escapeChatMarkdown(artifact.filename)).join(' · ')}`);
    blocks.push('Los archivos tienen la transcripción completa con el tramo actualizado.');
  }
  if (stateOf(row) === 'partial') blocks.push('La grabación todavía tiene tramos sin transcribir; escribe «reintenta» en este chat para recuperarlos.');
  if (result.unchanged) blocks.push('Si sigue sin entenderse, dime qué palabras o nombres esperas y lo intento con esas indicaciones.');
  else blocks.push('Puedes seguir preguntándome sobre esta grabación en este chat.');
  return blocks.join('\n\n');
}

/** Chat copy when a turn asks for a refine: the job runs in the media queue. */
function refineHandOffMessage({ fileName = null, range = null } = {}) {
  const label = refineRangeLabel(range && Number.isFinite(Number(range.start)) ? range : null);
  const what = label ? `el tramo ${label}` : 'ese tramo';
  const of = fileName ? ` de ${quoteName(fileName)}` : '';
  return `Voy a volver a transcribir ${what}${of}. Te aviso aquí y en notificaciones cuando esté listo; puedes seguir usando el chat.`;
}

function refineNotificationCopy({ delivery = {}, rows = [], outcome = null } = {}) {
  const row = rows[0] || null;
  const name = quoteName(displayName(row, delivery, 0));
  const label = refineRangeLabel(rangeOf(delivery));
  const result = outcome || resolveRefineOutcome(delivery, row);
  if (!row || !isUsableRow(row) || result.status === 'failed') {
    return { kind: 'refine_failed', title: `No pude corregir el tramo ${label} de ${name}`, body: 'La transcripción sigue como estaba; abre el chat para ver el motivo.' };
  }
  if (result.unchanged) return { kind: 'refine', title: `Revisé el tramo ${label} de ${name}`, body: 'El resultado no cambió; ábrelo en el chat para verlo.' };
  if (result.inferred) return { kind: 'refine', title: `El tramo ${label} de ${name} está listo`, body: 'Ábrelo en el chat para verlo.' };
  return { kind: 'refine', title: `Corregí el tramo ${label} de ${name}`, body: 'Ábrelo en el chat para ver el tramo y los archivos actualizados.' };
}

/** Inbox / push copy for a delivered transcription. */
function notificationCopy({ delivery = {}, rows = [], outcome = null } = {}) {
  if (isRefineRecord(delivery)) return refineNotificationCopy({ delivery, rows, outcome });
  const counts = summarizeStates(rows);
  if (rows.length === 1) {
    const name = quoteName(displayName(rows[0], delivery, 0));
    const state = stateOf(rows[0]);
    if (state === 'partial') return { kind: 'partial', title: `Tu transcripción de ${name} terminó parcialmente`, body: 'Faltan algunos tramos; ábrela en el chat y escribe «reintenta» para recuperarlos.' };
    if (state === 'failed') return { kind: 'failed', title: `No pude transcribir ${name}`, body: 'Abre el chat para ver el motivo y reintentarlo.' };
    if (state === 'pending') return { kind: 'partial', title: `${name} sigue en la cola de transcripción`, body: 'Abre el chat para ver su estado.' };
    return { kind: 'ready', title: `Tu transcripción de ${name} está lista`, body: 'Ábrela en el chat para leerla y descargarla.' };
  }
  const n = counts.total;
  const done = counts.ready + counts.partial;
  if (counts.ready === n) return { kind: 'ready', title: `Tus transcripciones están listas (${n} archivos)`, body: 'Ábrelas en el chat para leerlas y descargarlas.' };
  if (!done) return { kind: 'failed', title: `No pude transcribir tus ${n} archivos`, body: 'Abre el chat para ver los motivos y reintentarlos.' };
  return { kind: 'partial', title: `Tus transcripciones terminaron (${counts.ready} de ${n} completas)`, body: 'Abre el chat para ver lo que falta y reintentarlo.' };
}

/** Copy once a delivery gave up after its last attempt. */
function deliveryFailureCopy({ delivery = {}, rows = [] } = {}) {
  const names = (rows.length ? rows.map((row, index) => displayName(row, delivery, index)) : (delivery.fileNames || []))
    .filter(Boolean);
  const subject = names.length ? listNames(names, 1) : 'tus archivos';
  if (isRefineRecord(delivery)) {
    return {
      kind: 'delivery_failed',
      title: 'No pude entregar la corrección',
      body: `No pude entregar la corrección del tramo ${refineRangeLabel(rangeOf(delivery))} de ${subject}. La transcripción sigue guardada; pídemelo de nuevo en el chat.`,
    };
  }
  return {
    kind: 'delivery_failed',
    title: 'No pude entregar la transcripción',
    body: `No pude entregar la transcripción de ${subject}. Tus archivos y su transcripción siguen guardados; escribe "reintenta" en el chat.`,
  };
}

function chatTitleFor(delivery = {}, rows = []) {
  const names = (rows.length ? rows.map((row, index) => displayName(row, delivery, index)) : (delivery.fileNames || [])).filter(Boolean);
  const first = String(names[0] || 'archivo').slice(0, 60);
  const lead = isRefineRecord(delivery) ? 'Corrección' : 'Transcripción';
  return `${lead}: ${first}${names.length > 1 ? ` y ${names.length - 1} más` : ''}`.slice(0, 120);
}

function actionUrlFor(chatId) {
  return chatId ? `/agentes?id=${encodeURIComponent(chatId)}` : '/agentes';
}

// ── default artifact builder (until the professional formatter lands) ──

function safeBaseName(name) {
  const stem = String(name || 'transcripcion').replace(/\.[^./\\]{1,8}$/, '');
  const ascii = stem.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return (ascii || 'transcripcion').slice(0, 60);
}

function segmentsOf(transcript) {
  return (Array.isArray(transcript?.segments) ? transcript.segments : []).map(segment => ({
    start: Number(segment?.s ?? segment?.start),
    end: Number(segment?.e ?? segment?.end),
    text: String(segment?.t ?? segment?.text ?? ''),
  })).filter(segment => Number.isFinite(segment.start) && segment.text.trim());
}

function plainBundle(rows, delivery) {
  return rows.map((row, index) => {
    const state = stateOf(row);
    const name = displayName(row, delivery, index);
    const header = rows.length === 1 ? name : `${index + 1}. ${name}`;
    let body;
    if (state === 'ready') body = String(row.extractedText || '').trim();
    else if (state === 'partial') body = `[Transcripción parcial: ${partialDetail(row) || 'faltan algunos tramos'}]\n\n${String(row.extractedText || '').trim()}`;
    else if (state === 'failed') body = 'No se pudo transcribir este archivo. Puedes reintentarlo sin volver a subir los demás.';
    else body = 'Transcripción pendiente. El archivo permanece en la cola.';
    return `${header}\n${'='.repeat(48)}\n${body}\n`;
  }).join('\n');
}

function markdownBundle(rows, delivery) {
  const sections = rows.map((row, index) => {
    if (!isUsableRow(row)) return null;
    const note = stateOf(row) === 'partial' ? `_Transcripción parcial: ${escapeChatMarkdown(partialDetail(row) || 'faltan algunos tramos')}._\n\n` : '';
    return `## ${escapeChatMarkdown(displayName(row, delivery, index))}\n\n${note}${escapeChatMarkdown(String(row.extractedText || '').trim())}`;
  }).filter(Boolean);
  return `# Transcripción\n\n${sections.join('\n\n')}\n`;
}

/**
 * Fallback builder: a TXT with every file (always), SRT/VTT per file from
 * the segments sidecar when asked, and one Word document when asked. File
 * names are ASCII so the artifact store keeps them readable.
 */
async function defaultBuildArtifacts({ rows = [], transcripts = {}, delivery = {}, createDocument = null } = {}) {
  if (!rows.some(isUsableRow)) return [];
  const out = [];
  const used = new Set();
  const unique = filename => {
    let candidate = filename;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = filename.replace(/(\.[a-z0-9]+)$/i, `-${n}$1`);
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const single = rows.length === 1;
  const base = single ? safeBaseName(displayName(rows[0], delivery, 0)) : 'transcripciones';
  out.push({ filename: unique(single ? `${base}-transcripcion.txt` : 'transcripciones-completas.txt'),
    base64: Buffer.from(plainBundle(rows, delivery), 'utf8').toString('base64'), mime: 'text/plain' });
  const formats = new Set(Array.isArray(delivery.formats) ? delivery.formats : []);
  if (formats.has('srt') || formats.has('vtt')) {
    const { buildSrt, buildVtt } = require('./audio-transcriber');
    rows.forEach((row, index) => {
      if (!isUsableRow(row)) return;
      const segments = segmentsOf(transcripts?.[row.id]);
      if (!segments.length) return;
      const rowBase = safeBaseName(displayName(row, delivery, index));
      if (formats.has('srt')) {
        const srt = buildSrt(segments);
        if (srt) out.push({ filename: unique(`${rowBase}.srt`), base64: Buffer.from(`${srt}\n`, 'utf8').toString('base64'), mime: 'application/x-subrip' });
      }
      if (formats.has('vtt')) {
        const vtt = buildVtt(segments);
        if (vtt) out.push({ filename: unique(`${rowBase}.vtt`), base64: Buffer.from(vtt, 'utf8').toString('base64'), mime: 'text/vtt' });
      }
    });
  }
  if (formats.has('docx')) {
    let filePath = null;
    try {
      const build = createDocument || require('./document-service').createDocument;
      const filename = unique(`${base}-transcripcion.docx`);
      // A unique working copy under uploads/documents/<user>/ (removed below):
      // the friendly name repeats and another render may be using it.
      ({ filePath } = await build(delivery.userId, `transcript-${crypto.randomUUID()}.docx`, markdownBundle(rows, delivery)));
      const buffer = await fs.promises.readFile(filePath);
      out.push({ filename, base64: buffer.toString('base64'), mime: DOCX_MIME });
    } catch (_) { /* reported to the user as a missing format */ } finally {
      if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
    }
  }
  return out;
}

/**
 * The professional pack (header, timestamped paragraphs, Word, SRT/VTT,
 * ranges, clip clock) from media-transcript-artifacts; the plain builder
 * above stays as the fallback when the pack cannot be built.
 */
async function professionalBuildArtifacts({ rows = [], transcripts = {}, delivery = {} } = {}) {
  try {
    const pack = require('./media-transcript-artifacts');
    const formats = new Set(Array.isArray(delivery.formats) ? delivery.formats : []);
    const output = delivery.output || {};
    const built = await pack.buildMediaTranscriptArtifacts({
      rows: rows.filter(isUsableRow),
      transcripts: new Map(Object.entries(transcripts || {})),
      output: {
        documentFormat: output.documentFormat || (formats.has('pdf') ? 'pdf' : formats.has('docx') ? 'docx' : null),
        wantsSubtitles: Boolean(output.wantsSubtitles) || formats.has('srt') || formats.has('vtt'),
        // A refine re-sends the whole updated transcript, not just its window.
        range: !isRefineRecord(delivery) && delivery.range && Number.isFinite(Number(delivery.range.start)) ? delivery.range : null,
        timeOffsetSec: Number(output.timeOffsetSec) || 0,
      },
      userId: delivery.userId,
    });
    if (built?.artifacts?.length) return built.artifacts;
  } catch (err) {
    defaultLogger.warn(`[media-delivery] professional pack unavailable: ${err?.code || err?.message || 'pack_error'}`);
  }
  return defaultBuildArtifacts({ rows, transcripts, delivery });
}

// ── default side effects (lazy; never loaded by tests that inject fakes) ──

function defaultLoadFiles(prisma, userId, fileIds, { includeText = true } = {}) {
  return prisma.file.findMany({
    where: { userId, id: { in: fileIds }, deletedAt: null },
    select: {
      id: true, userId: true, originalName: true, filename: true, mimeType: true, size: true,
      processingStage: true, processingStageAt: true, processingError: true,
      ...(includeText ? { extractedText: true } : {}),
    },
  });
}

async function defaultLoadTranscript(prisma, args) {
  let mod;
  try {
    mod = require('./media-transcript-store');
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND' && /media-transcript-store/.test(String(err.message))) return null;
    throw err;
  }
  return typeof mod.loadMediaTranscript === 'function' ? mod.loadMediaTranscript(prisma, args) : null;
}

function defaultChatModel(model) {
  if (model) return String(model).slice(0, 200);
  try { return require('./agent-runner/native-llm').FLASH; } catch (_) { return 'deepseek-v4-flash'; }
}

async function defaultEnsureChat(prisma, { userId, chatId, title, model }) {
  if (chatId) {
    const own = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } });
    if (own) return { chatId: own.id, created: false };
  }
  // The origin chat was deleted (or never existed): a fresh chat keeps the
  // result reachable instead of dropping it (cowork/scheduler pattern).
  const chat = await prisma.chat.create({
    data: { userId, title: String(title || 'Transcripción').slice(0, 120), model: defaultChatModel(model) },
    select: { id: true },
  });
  return { chatId: chat.id, created: true };
}

function publicArtifact(artifact) {
  return {
    id: artifact.id, filename: artifact.filename, format: artifact.format, mime: artifact.mime,
    sizeBytes: artifact.sizeBytes, downloadUrl: artifact.downloadUrl,
  };
}

async function defaultPostMessage(prisma, { userId, chatId, content, metadata = {}, artifacts = [] }) {
  const own = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null }, select: { id: true } });
  if (!own) {
    const err = new Error('El chat de destino no está disponible.');
    err.code = 'chat_unavailable';
    throw err;
  }
  const list = (artifacts || []).filter(artifact => artifact?.id).map(publicArtifact);
  // Same envelope the agent-task runner persists, so the chat renders the
  // download cards; the plain answer follows the fenced state.
  const body = list.length
    ? `\`\`\`agent-task-state\n${JSON.stringify({ steps: [], artifacts: list, finalText: content, done: true,
      stoppedReason: metadata.stoppedReason, checkpoints: [] })}\n\`\`\`\n\n${content}`
    : content;
  const message = await prisma.message.create({
    data: {
      chatId, role: 'ASSISTANT', content: body, tokens: Math.ceil(body.length / 4), timestamp: new Date(),
      metadata: { ...metadata, source: DELIVERY_SOURCE, artifacts: list, updatedAt: new Date().toISOString() },
    },
  });
  try {
    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  } catch (_) { /* best-effort: surfaces the chat in the sidebar */ }
  return { messageId: message.id, chatId };
}

function defaultPersistArtifact({ artifact, userId, chatId, taskId, messageId }) {
  return require('./agents/agent-task-persistence').persistGeneratedArtifact({
    artifact, task: { userId, chatId, taskId: taskId || null }, messageId: messageId || null,
  });
}

function defaultNotify(prisma, { userId, title, body, actionUrl, type, metadata }) {
  return require('./cowork/notify').notify(prisma, {
    userId, type: type || 'media_transcription', title, message: body,
    channels: ['in_app', 'web_push'], actionUrl, metadata,
  });
}

/**
 * The window the analysis (summary, minutes, answer) reads: the moment the
 * user asked about («qué dice en el minuto 30», `output.analysisRange`), else
 * the transcript range they asked for, else null (the whole recording). The
 * transcript files, the chat view and a translation follow `delivery.range`
 * only (rangeOf).
 */
function analysisRangeOf(delivery) {
  const asked = delivery?.output?.analysisRange;
  if (asked && typeof asked === 'object') {
    const start = Number(asked.start);
    const end = Number(asked.end);
    if (Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start) return { start, end };
  }
  const range = delivery?.range;
  return range && Number.isFinite(Number(range.start)) ? range : null;
}

/** Summary/minutes with the model the user picked (plan quota enforced). */
async function defaultAnalyze({ rows, delivery, prisma }) {
  const runner = require('./agents/agent-task-runner');
  const profile = runner.normalizeAgentRuntimeModel(delivery?.model?.id || '');
  const resolution = runner.resolveAgentRuntimeClient(profile);
  if (!resolution?.client) {
    const err = new Error('selected_model_unavailable');
    err.code = 'selected_model_unavailable';
    throw err;
  }
  const completion = require('./media-analysis-runtime').createMediaAnalysisCompletion({
    client: resolution.client, model: resolution.model, provider: resolution.provider,
    userId: delivery.userId, chatId: delivery.deliveryChatId || delivery.chatId, prisma,
  });
  const rowsIn = (range) => {
    if (!range) return rows;
    try {
      const transcripts = new Map(Object.entries(delivery.transcripts || {}));
      return require('./media-handoff').mediaRowsForAnalysis(rows, transcripts, range);
    } catch (_) { return rows; }
  };
  // A requested range («del minuto 30 al 45») or moment is analysed alone.
  const analysisRows = rowsIn(analysisRangeOf(delivery));
  const mediaBatch = require('./media-batch');
  const target = delivery?.mode === 'translation' ? mediaBatch.detectTranslationTarget(delivery.goal) : null;
  if (target) {
    // The translation is of the transcript the user asked for (their range,
    // or the whole recording), never cut to the moment they asked about: that
    // moment only shapes the summary that comes with it.
    const range = rangeOf(delivery);
    const translationRows = rowsIn(range);
    const translation = await mediaBatch.translateMediaBatch({ rows: translationRows, target, complete: completion.complete });
    // «resume y tradúcelo»: the summary too, with the same model. Its failure
    // never costs the translation.
    let summary = '';
    if (delivery.output?.alsoAnalysis === true) {
      try {
        summary = (await mediaBatch.analyzeMediaBatch({ rows: analysisRows, goal: delivery.goal, complete: completion.complete }))?.text || '';
      } catch (_) { summary = ''; }
    }
    const failed = translation.failed || [];
    if (!translation.files.length) return { text: '', artifacts: [], failed, summary };
    const pack = require('./media-transcript-artifacts');
    const built = await pack.buildTranslationArtifacts({ files: translation.files, target,
      output: { ...(delivery.output || {}), range }, userId: delivery.userId });
    const firstFile = translation.files[0];
    const first = firstFile.text;
    const preview = first.length > 3000
      ? `${pack.escapeChatMarkdown(`${first.slice(0, 3000)}…`)}\n\n_Vista previa: el archivo adjunto tiene la traducción completa._`
      : pack.escapeChatMarkdown(first);
    // In a batch the preview names the file it shows.
    const label = translationRows.length > 1 ? `#### ${pack.escapeChatMarkdown(quoteName(firstFile.name))}\n\n` : '';
    return { text: `${label}${preview}`, artifacts: built.artifacts,
      notes: Array.isArray(built.notes) ? built.notes : [], failed, summary };
  }
  const result = await mediaBatch.analyzeMediaBatch({ rows: analysisRows, goal: delivery.goal, complete: completion.complete });
  return result?.text || '';
}

const defaultLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
};

function shutdownError() {
  const err = new Error('delivery_shutdown');
  err.code = 'delivery_shutdown';
  return err;
}

function createGate(limit) {
  let active = 0;
  const waiting = [];
  return async fn => {
    while (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await fn(); } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// ── service ────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} [deps.prisma]  Prisma client (message.findFirst for idempotency; default side effects).
 * @param {object} [deps.store]   media-delivery-store instance (default: one rooted at UPLOAD_DIR).
 * @param {string} [deps.root]    Store root when `store` is not given.
 * @param {(userId, fileIds, {includeText}) => Promise<object[]>} [deps.loadFiles]
 * @param {({fileIds, userId}) => Promise<object>} [deps.readJobStates]  owner-scoped durable queue states.
 * @param {(prisma, {userId, fileId}) => Promise<object|null>} [deps.loadTranscript]
 * @param {({rows, transcripts, delivery}) => Promise<{filename, base64, mime}[]>} [deps.buildArtifacts]
 * @param {({filename, base64, mime, ownerUserId, chatId}) => object} [deps.saveArtifact]
 * @param {({artifact, userId, chatId, taskId, messageId}) => Promise} [deps.persistArtifact]
 * @param {({userId, chatId, content, metadata, artifacts}) => Promise<{messageId, chatId}>} [deps.postMessage]
 * @param {({userId, chatId, title, model}) => Promise<{chatId, created}|string>} [deps.ensureChat]
 * @param {({userId, title, body, actionUrl, type, metadata}) => Promise} [deps.notify]
 * @param {(({rows, transcripts, delivery}) => Promise<string|{text}>)|null} [deps.analyze]  null disables analysis.
 * @param {({fileId, userId, language, hints}) => Promise<{ok}>} [deps.recordHints]  durable per-file hints (media-transcript-store.recordMediaHints).
 * @param {number} [deps.refineGraceMs]  how long a refine waits for a missed outcome report (default 30 min).
 * @param {() => number} [deps.now]
 * @param {{info, warn}} [deps.logger]
 */
function createMediaDeliveryService(deps = {}) {
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const logger = deps.logger || defaultLogger;
  const maxAttempts = Math.max(1, Number(deps.maxAttempts) || MAX_ATTEMPTS);
  const backoffMs = Array.isArray(deps.backoffMs) && deps.backoffMs.length ? deps.backoffMs : RETRY_BACKOFF_MS;
  const pendingCeilingMs = Math.max(1, Number(deps.pendingCeilingMs) || PENDING_CEILING_MS);
  const maxPerSweep = Math.max(1, Number(deps.maxPerSweep) || MAX_PER_SWEEP);
  const refineGraceMs = Math.max(0, Number(deps.refineGraceMs ?? REFINE_HOOK_GRACE_MS) || 0);
  const gate = createGate(Math.max(1, Math.min(4, Number(deps.concurrency) || 1)));

  let prismaRef = deps.prisma || null;
  const getPrisma = () => prismaRef || (prismaRef = require('../config/database'));
  let storeRef = deps.store || null;
  const getStore = () => storeRef || (storeRef = createMediaDeliveryStore({ env, now, root: deps.root || null }));

  const loadFiles = deps.loadFiles || ((userId, fileIds, opts) => defaultLoadFiles(getPrisma(), userId, fileIds, opts));
  const loadTranscript = deps.loadTranscript || defaultLoadTranscript;
  const readJobStates = deps.readJobStates || (args => require('./media-transcription-queue').readMediaJobStates(args));
  const transcriptPrisma = () => (deps.loadTranscript ? (deps.prisma || null) : getPrisma());
  const buildArtifacts = deps.buildArtifacts || professionalBuildArtifacts;
  const saveArtifact = deps.saveArtifact || (args => require('./agents/task-tools').saveArtifact(args));
  const persistArtifact = deps.persistArtifact || defaultPersistArtifact;
  const postMessage = deps.postMessage || (args => defaultPostMessage(getPrisma(), args));
  const ensureChat = deps.ensureChat || (args => defaultEnsureChat(getPrisma(), args));
  const notify = deps.notify || (args => defaultNotify(getPrisma(), args));
  const analyze = deps.analyze === undefined ? (args => defaultAnalyze({ ...args, prisma: getPrisma() })) : deps.analyze;
  const recordHints = deps.recordHints || (args => require('./media-transcript-store').recordMediaHints(deps.prisma || getPrisma(), args));

  const inflight = new Map();
  const held = new Map();
  let closing = false;
  let sweeping = false;
  let lastSweepOldAt = 0;
  let sweepCursor = null;

  const enabled = () => isMediaDeliveryEnabled(env);
  const checkpoint = () => { if (closing) throw shutdownError(); };

  async function createDelivery(record) {
    if (!enabled()) return null;
    const created = await getStore().create(record);
    logger.info(`[media-delivery] created id=${created.id} files=${created.fileIds.length} mode=${created.mode} kind=${created.kind || 'transcript'}`);
    await rememberHints(created);
    return created;
  }

  /**
   * What the user said about the recordings (language, names, speakers,
   * «literal») is kept durably per file, so a job that has not started yet
   * — or a recovery re-queue that only knows { fileId, userId } — still gets
   * it. Best-effort: a failure never costs the delivery.
   */
  async function rememberHints(created) {
    // A refine's language is about its window only: the refine job carries
    // it, the file never keeps it (a later gap retry would force it on the
    // whole recording).
    const language = isRefineRecord(created) ? null : (created?.language || null);
    if (!language && !created?.hints) return;
    let failed = 0;
    for (const fileId of created.fileIds) {
      try {
        const out = await recordHints({ fileId, userId: created.userId, language, hints: created.hints || null });
        if (out && out.ok === false && out.reason !== 'unavailable') failed++;
      } catch (_) { failed++; }
    }
    if (failed) logger.warn(`[media-delivery] hints not recorded id=${created.id} files=${failed}`);
  }

  async function findDeliveredMessage(chatId, id) {
    if (!chatId) return null;
    const prisma = deps.prisma || getPrisma();
    if (typeof prisma?.message?.findFirst !== 'function') return null;
    // Idempotency: the message carries the delivery id; never post twice.
    // Only a message this service wrote counts (see DELIVERY_SOURCE).
    return prisma.message.findFirst({
      where: { chatId, AND: [
        { metadata: { path: ['mediaDelivery'], equals: id } },
        { metadata: { path: ['source'], equals: DELIVERY_SOURCE } },
      ] },
      select: { id: true, chatId: true },
    });
  }

  function alignRows(ids, loaded, record) {
    const byId = new Map((Array.isArray(loaded) ? loaded : []).filter(Boolean).map(row => [row.id, row]));
    return ids.map((id, index) => byId.get(id) || {
      id, originalName: record.fileNames?.[index] || null, processingStage: 'failed',
      processingError: 'El archivo ya no está disponible.', missing: true,
    });
  }

  /**
   * Status-only probe (no transcripts loaded): files still pending, a refine
   * still waiting for its job's outcome, and whether the ceiling passed.
   */
  async function probePending(record) {
    const light = alignRows(record.fileIds, await loadFiles(record.userId, record.fileIds, { includeText: false }), record);
    const createdAt = Date.parse(record.createdAt || '');
    const pending = light.filter(row => !isTerminalRow(row));
    let overdue = Number.isFinite(createdAt) && now() - createdAt >= pendingCeilingMs;
    if (overdue && pending.length) {
      // An age limit is not evidence that transcription has stopped. Keep
      // its delivery attached while work exists, including delayed retries
      // and deployments. Failed probes are unknown, never proof of absence.
      try {
        const states = await readJobStates({ fileIds: pending.map(row => row.id), userId: record.userId });
        if (pending.some(row => !['missing', 'completed', 'failed'].includes(states[row.id] || 'unknown'))) overdue = false;
      } catch { overdue = false; }
    }
    return {
      pending: pending.length,
      awaitingRefine: awaitingRefineOutcome(record, light[0], now(), refineGraceMs),
      overdue,
    };
  }

  const isWaiting = probe => (probe.pending > 0 || probe.awaitingRefine) && !probe.overdue;

  async function attempt(record, token) {
    const store = getStore();
    const { id, userId } = record;
    const ids = record.fileIds;

    // Checked again under the lock: a file may have been re-queued since.
    const probe = await probePending(record);
    checkpoint();
    if (isWaiting(probe)) {
      await store.release(id, token);
      return { id, status: 'waiting', pending: probe.pending, ...(probe.awaitingRefine ? { awaitingRefine: true } : {}) };
    }

    const candidates = [...new Set([record.deliveryChatId, record.chatId].filter(Boolean))];
    for (const chatId of candidates) {
      const existing = await findDeliveredMessage(chatId, id);
      if (existing?.id) {
        await store.markDelivered(id, token, { deliveredMessageId: existing.id, deliveredChatId: existing.chatId || chatId });
        logger.info(`[media-delivery] already delivered id=${id}`);
        return { id, status: 'already_delivered', messageId: existing.id, chatId: existing.chatId || chatId };
      }
    }

    const rows = alignRows(ids, await loadFiles(userId, ids, { includeText: true }), record)
      .map(row => ({ ...row, deliveryState: classifyFileRow(row) }));
    checkpoint();

    const preferred = record.deliveryChatId || record.chatId || null;
    const ensured = await ensureChat({ userId, chatId: preferred, title: chatTitleFor(record, rows), model: record.model?.id || null });
    const targetChatId = typeof ensured === 'string' ? ensured : ensured?.chatId;
    if (!targetChatId) {
      const err = new Error('chat_unavailable');
      err.code = 'chat_unavailable';
      throw err;
    }
    if (targetChatId !== preferred) await store.patch(id, token, { deliveryChatId: targetChatId });
    checkpoint();

    const transcripts = {};
    for (const row of rows) {
      if (!isUsableRow(row)) continue;
      transcripts[row.id] = await Promise.resolve(loadTranscript(transcriptPrisma(), { userId, fileId: row.id }))
        .catch(() => null) || null;
    }
    checkpoint();

    const usable = rows.filter(isUsableRow);
    if (isRefineRecord(record)) return deliverRefine({ record, token, rows, transcripts, usable, targetChatId });
    const translating = record.mode === 'translation';
    // «resume y tradúcelo»: the summary comes with the translation.
    const alsoAnalysis = translating && record.output?.alsoAnalysis === true;
    let analysisText = '';
    let analysisFailed = false;
    let analysisArtifacts = [];
    let analysisNotes = [];
    let translationFailed = [];
    let summaryText = '';
    let summaryFailed = false;
    if ((record.mode === 'analysis' || translating) && usable.length) {
      if (typeof analyze !== 'function') {
        analysisFailed = true;
        summaryFailed = alsoAnalysis;
      } else {
        try {
          const result = await analyze({ rows: usable, transcripts, delivery: { ...record, deliveryChatId: targetChatId, transcripts } });
          analysisText = String(typeof result === 'string' ? result : result?.text || '').trim();
          // A translation returns its own files (TXT/Word) next to a preview.
          if (Array.isArray(result?.artifacts)) analysisArtifacts = result.artifacts;
          if (Array.isArray(result?.notes)) analysisNotes = result.notes.filter(note => typeof note === 'string' && note.trim());
          // Files whose translation failed while the others succeeded.
          if (Array.isArray(result?.failed)) translationFailed = result.failed.filter(Boolean);
          if (alsoAnalysis) {
            summaryText = String(result?.summary || '').trim();
            summaryFailed = !summaryText;
          }
          if (!analysisText) analysisFailed = true;
        } catch (err) {
          analysisFailed = true;
          summaryFailed = alsoAnalysis;
          logger.warn(`[media-delivery] analysis unavailable id=${id} code=${err?.code || 'analysis_error'}`);
        }
      }
      checkpoint();
    }

    // A translation alone does not re-send the transcript files, unless the
    // user also asked for the transcription or the translation produced
    // nothing (then the transcript is all there is to deliver).
    const wantsTranscriptFiles = !translating || record.output?.includeTranscript === true
      || analysisFailed || !analysisArtifacts.length;
    const transcriptSpecs = usable.length && wantsTranscriptFiles ? await buildArtifacts({ rows, transcripts, delivery: record }) : [];
    // Every file keeps what it is through the artifact store (which renames
    // it): the report names the transcript's sections and the embedded
    // track only when those files are really attached.
    const specs = [
      ...(Array.isArray(transcriptSpecs) ? transcriptSpecs : []).map(spec => withRole(spec, transcriptSpecRole(spec))),
      ...analysisArtifacts.map(spec => withRole(spec, typeof spec?.role === 'string' && spec.role ? spec.role : 'analysis')),
    ];
    const saved = await saveSpecs(specs, { userId, targetChatId });
    checkpoint();

    const counts = summarizeStates(rows);
    const content = deliveryMessage({ delivery: record, rows, transcripts, artifacts: saved, analysisText, analysisFailed,
      analysisNotes, translationFailed, summaryText, summaryFailed,
      transcriptFilesAttached: saved.some(artifact => artifact?.role === 'transcript') });
    return postAndFinish({ record, token, rows, counts, content, saved, targetChatId,
      extraMetadata: { deliveryKind: 'transcript', stoppedReason: stoppedReasonFor(counts) } });
  }

  async function saveSpecs(specs, { userId, targetChatId }) {
    const saved = [];
    for (const spec of Array.isArray(specs) ? specs : []) {
      if (!spec?.filename || typeof spec.base64 !== 'string') continue;
      const out = await saveArtifact({ filename: spec.filename, base64: spec.base64, mime: spec.mime,
        ownerUserId: userId, chatId: targetChatId });
      // The store sanitizes the name: the role (and the file a track belongs to) travels apart.
      const tags = {
        ...(typeof spec.role === 'string' && spec.role ? { role: spec.role } : {}),
        ...(typeof spec.sourceFileId === 'string' && spec.sourceFileId ? { sourceFileId: spec.sourceFileId } : {}),
      };
      saved.push(out && typeof out === 'object' && Object.keys(tags).length ? { ...out, ...tags } : out);
    }
    return saved;
  }

  /**
   * A refine: the corrected window of one file. Its outcome comes from the
   * refine job (or is inferred when its report was missed); the updated
   * files (the whole transcript, never only the window) go out when the
   * window actually changed.
   */
  async function deliverRefine({ record, token, rows, transcripts, usable, targetChatId }) {
    const { userId } = record;
    const outcome = resolveRefineOutcome(record, rows[0]);
    const sendFiles = usable.length > 0 && outcome.status === 'ok' && !outcome.unchanged;
    const built = sendFiles ? await buildArtifacts({ rows, transcripts, delivery: { ...record, range: null } }) : [];
    const specs = (Array.isArray(built) ? built : []).map(spec => withRole(spec, transcriptSpecRole(spec)));
    const saved = await saveSpecs(specs, { userId, targetChatId });
    checkpoint();
    const counts = summarizeStates(rows);
    const content = refineMessage({ delivery: record, rows, transcripts, artifacts: saved, outcome });
    const ok = usable.length > 0 && outcome.status === 'ok';
    return postAndFinish({ record, token, rows, counts, content, saved, targetChatId, outcome,
      extraMetadata: { deliveryKind: 'refine', refineRange: record.range || null,
        refineOutcome: ok ? (outcome.unchanged ? 'unchanged' : (outcome.inferred ? 'inferred' : 'ok')) : 'failed',
        stoppedReason: ok ? 'transcription_refine' : 'transcription_refine_failed' } });
  }

  /** Post the message (under the lock), mark the record delivered, then the optional steps. */
  async function postAndFinish({ record, token, rows, counts, content, saved, targetChatId, outcome = null, extraMetadata = {} }) {
    const store = getStore();
    const { id, userId } = record;
    const ids = record.fileIds;
    // Never post without the lock: if another process reclaimed it while this
    // one stalled past the stale window, that holder may be posting too.
    if (typeof store.holds === 'function' && !(await store.holds(id, token))) {
      const err = new Error('lock_lost');
      err.code = 'lock_lost';
      throw err;
    }
    const metadata = {
      source: DELIVERY_SOURCE,
      mediaDelivery: id,
      transcriptionFileIds: ids,
      servedBy: 'media_batch',
      taskId: record.taskId || null,
      deliveryMode: record.mode,
      mediaBatch: counts,
      ...extraMetadata,
    };
    const posted = await postMessage({ userId, chatId: targetChatId, content, metadata, artifacts: saved });
    const messageId = posted?.messageId || posted?.id || null;
    const deliveredChatId = posted?.chatId || targetChatId;
    // Terminal BEFORE the optional steps: a failed notification or artifact
    // index must never cause a second message.
    await store.markDelivered(id, token, { deliveredMessageId: messageId, deliveredChatId });

    for (const artifact of saved) {
      try {
        await persistArtifact({ artifact, userId, chatId: deliveredChatId, taskId: record.taskId || null, messageId });
      } catch (_) { /* the chat message already links the download */ }
    }
    const copy = notificationCopy({ delivery: record, rows, outcome });
    try {
      await notify({ userId, title: copy.title, body: copy.body, actionUrl: actionUrlFor(deliveredChatId),
        type: `media_transcription_${copy.kind}`, metadata: { mediaDelivery: id, chatId: deliveredChatId, fileIds: ids } });
    } catch (err) {
      logger.warn(`[media-delivery] notification failed id=${id} code=${err?.code || 'notify_error'}`);
    }
    logger.info(`[media-delivery] delivered id=${id} kind=${isRefineRecord(record) ? 'refine' : 'transcript'} files=${counts.total} ready=${counts.ready} partial=${counts.partial} failed=${counts.failed} pending=${counts.pending} attempt=${(Number(record.attempts) || 0) + 1}`);
    return { id, status: 'delivered', messageId, chatId: deliveredChatId, artifacts: saved.length, counts };
  }

  async function recordFailure(record, token, err) {
    const store = getStore();
    const { id } = record;
    if (err?.code === 'delivery_shutdown') {
      await store.release(id, token).catch(() => null);
      return { id, status: 'closing' };
    }
    const failed = await store.markFailed(id, token, err, { maxAttempts, backoffMs }).catch(() => null);
    const code = err?.code || 'delivery_error';
    if (!failed) {
      // The lock was reclaimed (its new holder owns the record) or the
      // store is unreachable (the stale window hands it back).
      logger.warn(`[media-delivery] attempt failed id=${id} code=${code} (not recorded: lock lost or store unavailable)`);
      return { id, status: 'lock_lost' };
    }
    logger.warn(`[media-delivery] attempt failed id=${id} attempts=${failed.attempts}/${maxAttempts} code=${code}`);
    if (failed.status !== 'failed') return { id, status: 'retry', attempts: failed.attempts, nextAttemptAt: failed.nextAttemptAt };
    const copy = deliveryFailureCopy({ delivery: failed });
    // `failed` is the stored record: it carries a replacement chat created
    // during an earlier attempt, unlike the record read at claim time.
    const chatId = failed.deliveryChatId || failed.chatId || null;
    try {
      await notify({ userId: failed.userId, title: copy.title, body: copy.body,
        actionUrl: actionUrlFor(chatId), type: 'media_transcription_delivery_failed',
        metadata: { mediaDelivery: id, chatId, fileIds: failed.fileIds } });
    } catch (notifyErr) {
      logger.warn(`[media-delivery] notification failed id=${id} code=${notifyErr?.code || 'notify_error'}`);
    }
    return { id, status: 'failed', attempts: failed.attempts };
  }

  async function runDelivery(id, { force = false, at = null } = {}) {
    const store = getStore();
    let record;
    try {
      record = await store.get(id);
    } catch (err) {
      logger.warn(`[media-delivery] read failed id=${id} code=${err?.code || 'read_error'}`);
      return { id, status: 'error' };
    }
    if (!record) return { id, status: 'missing' };
    if (record.status === 'delivered' || record.status === 'failed') return { id, status: record.status };
    const asOf = Number.isFinite(at) ? at : now();
    const nextAt = Date.parse(record.nextAttemptAt || '');
    if (!force && Number.isFinite(nextAt) && nextAt > asOf) return { id, status: 'backoff', nextAttemptAt: record.nextAttemptAt };
    if (closing) return { id, status: 'closing' };
    // Read-only first: a record still waiting on its files is not claimed
    // or rewritten on every sweep.
    try {
      const probe = await probePending(record);
      if (isWaiting(probe)) return { id, status: 'waiting', pending: probe.pending, ...(probe.awaitingRefine ? { awaitingRefine: true } : {}) };
    } catch (err) {
      logger.warn(`[media-delivery] status probe failed id=${id} code=${err?.code || 'probe_error'}`);
      return { id, status: 'error' };
    }
    if (closing) return { id, status: 'closing' };
    let claimed;
    try {
      claimed = await store.claim(id);
    } catch (err) {
      logger.warn(`[media-delivery] claim failed id=${id} code=${err?.code || 'claim_error'}`);
      return { id, status: 'error' };
    }
    if (!claimed) return { id, status: 'busy' };
    const { token } = claimed;
    held.set(id, token);
    const refreshEvery = Math.max(1000, Math.floor(store.staleMs / 3));
    const timer = setInterval(() => { store.refresh(id, token).catch(() => {}); }, refreshEvery);
    timer.unref?.();
    try {
      return await attempt(claimed.record, token);
    } catch (err) {
      return await recordFailure(claimed.record, token, err);
    } finally {
      clearInterval(timer);
      held.delete(id);
    }
  }

  /** Try to deliver one record now. Never throws; returns { id, status }. */
  function deliverOne(id, options = {}) {
    if (!isValidDeliveryId(id)) return Promise.resolve({ id, status: 'invalid' });
    if (!enabled()) return Promise.resolve({ id, status: 'disabled' });
    if (closing) return Promise.resolve({ id, status: 'closing' });
    if (inflight.has(id)) return inflight.get(id);
    const run = gate(() => runDelivery(id, options))
      .catch(err => {
        logger.warn(`[media-delivery] unexpected id=${id} code=${err?.code || 'delivery_error'}`);
        return { id, status: 'error' };
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, run);
    return run;
  }

  /** A delivery record by id (active or done), or null; never throws. */
  async function readRecordQuietly(id) {
    const store = getStore();
    if (typeof store.get !== 'function' || !isValidDeliveryId(String(id || ''))) return null;
    try { return await store.get(String(id)); } catch (_) { return null; }
  }

  /**
   * A refine job reported its outcome: record it on the refine deliveries it
   * answers. The queue runs one job per (file, window, language, hints) and
   * an identical request reuses the running job, which carries only the
   * first request's `deliveryId`: with that record open, the job answers it
   * and the open records with the same job key (refineJobKeyOf), never a
   * same-window request with other hints, which has its own job and its own
   * report. Without a usable id: the open records with the same window
   * (narrowed to the named record's job key when that record is readable),
   * and only without any id, the oldest open refine whose window overlaps.
   */
  async function noteRefineOutcomes(records, payload) {
    const store = getStore();
    if (typeof store.noteRefineOutcome !== 'function') return;
    const open = records.filter(record => isRefineRecord(record) && record.refine?.status !== 'ok');
    if (!open.length) return;
    const range = payload.range && Number.isFinite(Number(payload.range.start)) ? payload.range : null;
    const named = payload.deliveryId ? open.find(record => record.id === payload.deliveryId) || null : null;
    let targets;
    if (named) {
      const key = refineJobKeyOf(named);
      targets = [named, ...open.filter(record => record !== named && refineJobKeyOf(record) === key)];
    } else {
      targets = range ? open.filter(record => sameRange(record.range, range)) : [];
      if (payload.deliveryId && targets.length) {
        // The named record is no longer open: its job key still tells which requests share this job.
        const asked = await readRecordQuietly(payload.deliveryId);
        if (isRefineRecord(asked)) {
          const key = refineJobKeyOf(asked);
          targets = targets.filter(record => refineJobKeyOf(record) === key);
        }
      }
      if (!targets.length && range && !payload.deliveryId) {
        const overlapping = open.filter(record => !record.refine && rangesOverlap(record.range, range))
          .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        targets = overlapping.slice(0, 1);
      }
    }
    const ok = payload.ok === false ? false : payload.ok === true ? true : payload.stage !== 'failed';
    for (const record of targets) {
      try {
        await store.noteRefineOutcome(record.id, { ok, unchanged: payload.unchanged === true, code: payload.code || null });
      } catch (err) {
        logger.warn(`[media-delivery] refine outcome not recorded id=${record.id} code=${err?.code || 'store_error'}`);
      }
    }
  }

  /** Media worker hook: a file reached ready / partial / failed, or a refine finished. Never throws. */
  async function onMediaTerminal(payload = {}) {
    const { fileId, userId } = payload || {};
    if (!enabled()) return { status: 'disabled', matched: 0, results: [] };
    try {
      let records = await getStore().findPendingByFile(String(fileId || ''), { userId: userId || null });
      if (payload?.refine === true) {
        await noteRefineOutcomes(records, payload);
        records = await getStore().findPendingByFile(String(fileId || ''), { userId: userId || null });
      }
      const results = [];
      for (const record of records) results.push(await deliverOne(record.id));
      return { status: 'ok', matched: records.length, results };
    } catch (err) {
      logger.warn(`[media-delivery] terminal hook failed code=${err?.code || 'hook_error'}`);
      return { status: 'error', matched: 0, results: [] };
    }
  }

  /**
   * Reconcile pass (started, not awaited, from the 60 s media timer): retries
   * due records and recovers any whose terminal hook was missed (crash,
   * deploy). Records already in flight in this process are skipped.
   */
  async function sweepPendingDeliveries({ now: at } = {}) {
    if (!enabled()) return { status: 'disabled' };
    if (sweeping) return { status: 'busy' };
    sweeping = true;
    try {
      const asOf = Number.isFinite(at) ? at : now();
      const store = getStore();
      const records = await store.listActive();
      const ready = records.filter(record => {
        // Already running here (terminal hook): awaiting it would hold this
        // sweep for the whole delivery — a translation can take 30 min.
        if (inflight.has(record.id)) return false;
        const nextAt = Date.parse(record.nextAttemptAt || '');
        return !Number.isFinite(nextAt) || nextAt <= asOf;
      });
      // Round-robin over passes: records that keep waiting on their files
      // must not starve the ones behind them when there are more than
      // maxPerSweep.
      const start = sweepCursor ? ready.findIndex(record => record.id > sweepCursor) : 0;
      const ordered = start > 0 ? [...ready.slice(start), ...ready.slice(0, start)] : ready;
      const due = ordered.slice(0, maxPerSweep);
      sweepCursor = due.length < ready.length ? due[due.length - 1].id : null;
      const results = [];
      for (const record of due) results.push(await deliverOne(record.id, { at: asOf }));
      if (asOf - lastSweepOldAt >= SWEEP_OLD_INTERVAL_MS) {
        lastSweepOldAt = asOf;
        await store.sweepOld({ now: asOf }).catch(err => logger.warn(`[media-delivery] sweepOld failed code=${err?.code || 'sweep_error'}`));
      }
      const tally = status => results.filter(result => result.status === status).length;
      return { status: 'ok', scanned: records.length, attempted: due.length, delivered: tally('delivered') + tally('already_delivered'),
        waiting: tally('waiting'), retry: tally('retry'), failed: tally('failed'), results };
    } catch (err) {
      logger.warn(`[media-delivery] sweep failed code=${err?.code || 'sweep_error'}`);
      return { status: 'error' };
    } finally {
      sweeping = false;
    }
  }

  /**
   * Shutdown: stop new claims, give in-flight deliveries `graceMs`, then
   * hand every still-held record back as pending (no attempt is spent) so
   * the next process picks it up immediately instead of after the stale window.
   */
  async function close({ graceMs = 5000 } = {}) {
    closing = true;
    const running = [...inflight.values()];
    if (running.length) await Promise.race([Promise.allSettled(running), delay(Math.max(0, graceMs))]);
    let released = 0;
    for (const [id, token] of [...held]) {
      if (await getStore().release(id, token).catch(() => null)) released++;
    }
    return { released };
  }

  return {
    createDelivery,
    onMediaTerminal,
    sweepPendingDeliveries,
    deliverOne,
    close,
    get store() { return getStore(); },
  };
}

// ── lazy default singleton ─────────────────────────────────────────────

let defaultService = null;

function getMediaDeliveryService() {
  if (!defaultService) defaultService = createMediaDeliveryService();
  return defaultService;
}

function _resetMediaDeliveryDefaults() {
  defaultService = null;
}

module.exports = {
  createMediaDeliveryService,
  getMediaDeliveryService,
  _resetMediaDeliveryDefaults,
  // Default-singleton conveniences for the integration points. They never
  // throw except createDelivery (invalid input / disk error → caller keeps
  // the inline wait); disabled → null / { status: 'disabled' }.
  createDelivery: record => (isMediaDeliveryEnabled() ? getMediaDeliveryService().createDelivery(record) : Promise.resolve(null)),
  onMediaTerminal: payload => (isMediaDeliveryEnabled() ? getMediaDeliveryService().onMediaTerminal(payload)
    : Promise.resolve({ status: 'disabled', matched: 0, results: [] })),
  sweepPendingDeliveries: options => (isMediaDeliveryEnabled() ? getMediaDeliveryService().sweepPendingDeliveries(options)
    : Promise.resolve({ status: 'disabled' })),
  closeMediaDelivery: options => (defaultService ? defaultService.close(options) : Promise.resolve({ released: 0 })),
  // Pure helpers
  isMediaDeliveryEnabled,
  inlineWaitMs,
  estimateTranscriptionSeconds,
  estimateBatchEtaSeconds,
  shouldHandOff,
  handOffMessage,
  deliveryMessage,
  refineMessage,
  refineHandOffMessage,
  analysisRangeOf,
  resolveRefineOutcome,
  awaitingRefineOutcome,
  refineJobKeyOf,
  transcriptFilesIn,
  notificationCopy,
  deliveryFailureCopy,
  classifyFileRow,
  isTerminalRow,
  summarizeStates,
  chatTitleFor,
  actionUrlFor,
  formatApproxDuration,
  formatClock,
  defaultBuildArtifacts,
  professionalBuildArtifacts,
  TRANSCRIPTION_RTF,
  DEFAULT_INLINE_WAIT_MS,
  PENDING_CEILING_MS,
  REFINE_HOOK_GRACE_MS,
};
