'use strict';

/**
 * media-transcript-artifacts — the professional deliverables of a media
 * transcription turn, shared by the chat turn (inline) and the durable
 * delivery that posts long recordings into the chat later.
 *
 * Input: the File rows of the batch plus each file's transcript sidecar
 * (segments with absolute times, language, coverage, gaps — written by the
 * media job). Legacy transcripts without a sidecar still deliver their plain
 * text. Output: TXT with a header (always), Word for long recordings or when
 * asked, PDF when asked, SRT/VTT subtitles for videos and long recordings or
 * when asked, and a chat preview that never dumps five hours into one
 * message. A requested time range («del minuto 30 al 45») slices every
 * format to that window.
 *
 * The honest report travels with every deliverable (contract C6): the
 * engine's quality level, its doubtful stretches, where the text came from
 * (voice, the video's embedded subtitles or the text on screen), a text
 * subtitle track kept next to a voice transcript, the text read on screen
 * («Texto en pantalla») and the hints the engine was given. The formatter
 * renders the TXT/Word/PDF header from the result; `transcriptQualityReport`
 * gives the chat the same facts in a few lines. Every time is on the
 * recording's clock and cut to the requested window, like the body.
 *
 * Every collaborator is injectable (formatter, store, createDocument) so the
 * decision and the rendering are unit-testable without Prisma or pandoc.
 */

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const MIME = Object.freeze({
  txt: 'text/plain',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
});
const LONG_RECORDING_SECONDS = 10 * 60;
const SUBTITLE_FILE_CAP = 20;
const PREVIEW_FULL_MAX_CHARS = 12000;
const PREVIEW_HEAD_CHARS = 3500;
const PREVIEW_BATCH_HEAD_CHARS = 1200;
const PREVIEW_TOTAL_MAX_CHARS = 20000;

function stripAccentsLower(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function defaultFormatter() { return require('./media-transcript-format'); }
function defaultStore() { return require('./media-transcript-store'); }

/** What the user asked for: document format, subtitles and an optional time range. */
function resolveTranscriptOutput(goal, { documentPolicy = null, formatter = null } = {}) {
  const text = stripAccentsLower(goal);
  let documentFormat = null;
  try {
    documentFormat = require('./message-attachments').transcriptionFileOutputFormat(goal);
  } catch (_) { documentFormat = null; }
  if (!documentFormat) {
    if (/\bpdf\b/.test(text)) documentFormat = 'pdf';
    else if (/\b(word|docx|documento)\b/.test(text)) documentFormat = 'docx';
  }
  const policyFormat = String(documentPolicy?.format || '').toLowerCase();
  if (!documentFormat && documentPolicy?.autoGenerate && (policyFormat === 'docx' || policyFormat === 'pdf')) documentFormat = policyFormat;
  if (documentFormat && documentFormat !== 'docx' && documentFormat !== 'pdf') documentFormat = null;
  const wantsSubtitles = /\b(subtitul\w*|srt|vtt|webvtt|subs?)\b/.test(text) || /\bclosed caption/.test(text);
  let range = null;
  try {
    const parsed = (formatter || defaultFormatter()).parseTimeRange?.(goal);
    // An open range («desde el minuto 30») runs to the end of the recording.
    if (parsed && Number.isFinite(parsed.start) && parsed.start >= 0
      && (parsed.end == null || (Number.isFinite(parsed.end) && parsed.end > parsed.start))) range = { start: parsed.start, end: parsed.end ?? null };
  } catch (_) { range = null; }
  return { documentFormat, wantsSubtitles, range };
}

/** Accepts the sidecar shape ({s,e,t,spk,conf}) or the engine shape. */
function normalizeSegments(segments) {
  return (Array.isArray(segments) ? segments : []).map((seg) => ({
    start: Number(seg?.start ?? seg?.s),
    end: Number(seg?.end ?? seg?.e),
    text: String(seg?.text ?? seg?.t ?? ''),
    speaker: seg?.speaker ?? seg?.spk ?? null,
    confidence: seg?.confidence ?? seg?.conf ?? null,
  })).filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end >= seg.start && seg.text.trim());
}

function rowName(row) {
  return String(row?.originalName || row?.filename || row?.id || 'archivo');
}

function isVideoRow(row) {
  return /^video\//i.test(String(row?.mimeType || '')) || /\.(mp4|mov|mkv|webm|avi|m4v|mpe?g|ts)$/i.test(rowName(row));
}

/** Offset a stored sidecar already carries: its segments are on the recording's clock. */
function storedOffsetOf(transcript) {
  const offset = Number(transcript?.timeOffsetSec);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

/**
 * Seconds to add to a file's times to put them on the recording's clock: the
 * requested clip offset, unless the stored transcript is already shifted
 * (the media queue shifts link clips before storing them) — never twice.
 */
function clockOffsetFor(transcript, output = {}) {
  if (storedOffsetOf(transcript)) return 0;
  const offset = Number(output?.timeOffsetSec);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

const AUTHORED_SOURCES = new Set(['subtitles', 'onscreen']);

function formatterOrNull() {
  try { return defaultFormatter(); } catch (_) { return null; }
}

/**
 * The optional report fields of a stored transcript (contract C5), bounded
 * by the formatter's normalizers: where the text came from, the engine's
 * quality report, the text read on screen, a text subtitle track kept as a
 * cross-check, the hints the engine was given and what the queue's cleanup
 * removed. A transcript without them (older sidecar) gets none: its
 * deliverables look exactly as before.
 */
function reportFieldsOf(transcript) {
  if (!transcript || typeof transcript !== 'object') return {};
  const fmt = formatterOrNull();
  const out = {};
  const source = fmt?.normalizeSource ? fmt.normalizeSource(transcript.source) : null;
  if (source) out.source = source;
  if (source === 'subtitles' && transcript.subtitleOrigin === 'platform') out.subtitleOrigin = 'platform';
  const quality = fmt?.normalizeQuality ? fmt.normalizeQuality(transcript.quality) : null;
  if (quality) out.quality = quality;
  const onScreen = fmt?.normalizeTimedTextList ? fmt.normalizeTimedTextList(transcript.onScreenText) : [];
  if (onScreen.length) out.onScreenText = onScreen;
  const embedded = fmt?.normalizeEmbeddedSubtitles ? fmt.normalizeEmbeddedSubtitles(transcript.embeddedSubtitles) : null;
  if (embedded) out.embeddedSubtitles = embedded;
  const hints = normalizeHintsForReport(transcript.hints, fmt);
  if (hints) out.hints = hints;
  if (transcript.audioStream && typeof transcript.audioStream === 'object' && !Array.isArray(transcript.audioStream)) {
    out.audioStream = transcript.audioStream;
  }
  if (transcript.cleanup && typeof transcript.cleanup === 'object' && !Array.isArray(transcript.cleanup)) out.cleanup = transcript.cleanup;
  return out;
}

/** Stored hints → { language?, terms?, speakers?, verbatim? } or null. */
function normalizeHintsForReport(raw, fmt = formatterOrNull()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hints = (fmt?.normalizeMediaHints ? fmt.normalizeMediaHints(raw) : null) || {};
  const language = fmt?.normalizeHintLanguage ? fmt.normalizeHintLanguage(raw.language) : null;
  const out = { ...(language ? { language } : {}), ...hints };
  return Object.keys(out).length ? out : null;
}

/** The formatter input for one file: its sidecar when present, else its text. */
function transcriptResultFor(row, transcript) {
  const segments = normalizeSegments(transcript?.segments);
  const storedOffset = storedOffsetOf(transcript);
  const extras = reportFieldsOf(transcript);
  // durationSec is the clip's own length; a shifted clip spans [offset, offset + duration].
  const spoken = segments.length ? Math.max(...segments.map((seg) => seg.end)) - storedOffset : 0;
  const durationSec = Number(transcript?.durationSec) || (spoken > 0 ? spoken : null);
  // A stored `coverage: null` is «not measured», never 0 %. Subtitles and
  // on-screen text are not a reading of the audio: no coverage of their own.
  const declared = transcript?.coverage == null || transcript.coverage === '' ? NaN : Number(transcript.coverage);
  const coverage = Number.isFinite(declared) ? declared
    : (AUTHORED_SOURCES.has(extras.source) ? null : (segments.length ? 1 : null));
  return {
    text: String(row?.extractedText || '').trim(),
    transcript: String(row?.extractedText || '').trim(),
    segments,
    language: transcript?.language || null,
    durationSec: durationSec || null,
    coverage,
    gaps: Array.isArray(transcript?.gaps) ? transcript.gaps : [],
    partial: Boolean(transcript?.partial) || String(row?.processingError || '').startsWith('Parcial:'),
    providers: transcript?.providers || null,
    engine: transcript?.engine || null,
    segmentCount: Number(transcript?.segmentCount) || segments.length,
    ...(storedOffset ? { timeOffsetSec: storedOffset } : {}),
    ...extras,
  };
}

function shiftTimed(list, offset) {
  return (Array.isArray(list) ? list : []).map((item) => ({ ...item, start: Number(item.start) + offset, end: Number(item.end) + offset }));
}

/**
 * A clip cut from a longer recording (a link section «del minuto 60 al 90»)
 * is transcribed from 0; its deliverables follow the recording's own clock.
 * Same shape as a transcript the media queue stored already shifted:
 * segments, gaps, doubtful stretches, on-screen text and a kept subtitle
 * track move, durationSec stays the clip's length and timeOffsetSec marks
 * the shift (the window is [offset, offset + duration]).
 */
function shiftResult(result, offsetSec) {
  const offset = Number(offsetSec) || 0;
  if (!(offset > 0) || !result.segments.length) return result;
  const out = {
    ...result,
    segments: result.segments.map((seg) => ({ ...seg, start: seg.start + offset, end: seg.end + offset })),
    gaps: result.gaps.map((gap) => ({ ...gap, start: Number(gap.start) + offset, end: Number(gap.end) + offset })),
    timeOffsetSec: offset,
  };
  if (Array.isArray(result.onScreenText)) out.onScreenText = shiftTimed(result.onScreenText, offset);
  if (result.embeddedSubtitles && Array.isArray(result.embeddedSubtitles.segments)) {
    out.embeddedSubtitles = { ...result.embeddedSubtitles, segments: shiftTimed(result.embeddedSubtitles.segments, offset) };
  }
  if (result.quality && Array.isArray(result.quality.lowConfidence)) {
    out.quality = { ...result.quality, lowConfidence: shiftTimed(result.quality.lowConfidence, offset) };
  }
  return out;
}

function resultFor(row, transcript, output) {
  return shiftResult(transcriptResultFor(row, transcript), clockOffsetFor(transcript, output));
}

function overlapsWindow(item, start, end) {
  const itemStart = Number(item?.start);
  const itemEnd = Number(item?.end) > itemStart ? Number(item.end) : itemStart + 1e-6;
  return itemEnd > start && (end == null || itemStart < end);
}

function applyRange(result, range, formatter) {
  if (!range || !result.segments.length) return { result, sliced: false };
  const end = range.end == null ? null : Number(range.end);
  // The formatter clips gaps to the window and recomputes coverage.
  const sliced = typeof formatter.sliceResult === 'function' ? formatter.sliceResult(result, { start: range.start, end }) : null;
  const segments = normalizeSegments(sliced ? sliced.segments : formatter.sliceSegments(result.segments, { start: range.start, end }));
  const gaps = sliced ? sliced.gaps : result.gaps.filter((gap) => Number(gap.end) > range.start && (end == null || Number(gap.start) < end));
  const text = segments.map((seg) => seg.text).join(' ');
  const windowed = { ...result, ...(sliced || {}), segments, gaps, text, transcript: text, range: { start: range.start, end } };
  // The stored cleanup counts cover the whole recording: a window header
  // must not claim them (the render-time cleanup still counts its own).
  delete windowed.cleanup;
  // The side texts and the doubtful stretches follow the window too (the
  // formatter's slice already cuts them; this also covers an older one).
  if (Array.isArray(result.onScreenText)) windowed.onScreenText = (sliced?.onScreenText || result.onScreenText).filter((item) => overlapsWindow(item, range.start, end));
  if (result.quality && Array.isArray(result.quality.lowConfidence)) {
    const quality = sliced?.quality || result.quality;
    windowed.quality = { ...quality, lowConfidence: (quality.lowConfidence || []).filter((item) => overlapsWindow(item, range.start, end)) };
  }
  if (result.embeddedSubtitles && Array.isArray(result.embeddedSubtitles.segments)) {
    const kept = result.embeddedSubtitles.segments.filter((item) => overlapsWindow(item, range.start, end));
    if (kept.length) windowed.embeddedSubtitles = { ...result.embeddedSubtitles, segments: kept };
    else delete windowed.embeddedSubtitles;
  }
  return { result: windowed, sliced: true };
}

function clock(seconds, withHours) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return withHours || h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function rangeLabel(range) {
  if (!range) return '';
  if (range.end == null) return `desde ${clock(range.start, range.start >= 3600)}`;
  const withHours = range.end >= 3600;
  return `${clock(range.start, withHours)}–${clock(range.end, withHours)}`;
}

function sourceStem(name) {
  const raw = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, ' ');
  const clean = raw.replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 80) || 'transcripcion';
}

function deliverableName(rows, ext, range) {
  const base = rows.length === 1 ? `${sourceStem(rowName(rows[0]))} (transcripción` : `Transcripciones (${rows.length} archivos`;
  const window = range ? ` ${rangeLabel(range).replace(/:/g, '.')}` : '';
  return `${base}${window}).${ext}`;
}

// ── honest report (contract C6) ─────────────────────────────────────────

const ENGINE_NAMES_ES = Object.freeze({
  openai: 'OpenAI', groq: 'Groq', xai: 'xAI', grok: 'xAI', meta: 'Meta', elevenlabs: 'ElevenLabs',
  scribe: 'ElevenLabs', gemini: 'Gemini', voicestudio: 'VoiceStudio', deepgram: 'Deepgram', assemblyai: 'AssemblyAI',
  local: 'Whisper local', 'local-whisper': 'Whisper local', 'whisper-cpp': 'Whisper local', whisper: 'Whisper',
  'local-strong': 'Whisper local reforzado', local_strong: 'Whisper local reforzado',
  subtitles: 'subtítulos incrustados', captions: 'subtítulos de la plataforma', platform_captions: 'subtítulos de la plataforma',
  ocr: 'OCR', tesseract: 'OCR', vision: 'lectura visual', 'glm-ocr': 'GLM-OCR', glm: 'GLM-OCR',
});
const ENGINE_FAMILY_ES = Object.freeze({ cloud: 'en la nube', local: 'Whisper local', mixed: 'nube y local' });
const MAX_ENGINES_SHOWN = 4;
const MAX_TERMS_SHOWN = 8;
const MAX_CHAT_NOTES = 4;
// The formatter's header shows the first six quality notes.
const HEADER_NOTE_SLOTS = 6;
const SOURCE_NOTE_RE = /subt[ií]tulos|pantalla/i;

// A local whisper.cpp model this size or larger is the strong local rung.
const STRONG_LOCAL_MODEL_RE = /large|turbo/;

/**
 * The user-facing name of one engine. The engine reports `provider`,
 * `provider:model` or `provider:model+variant` («openai:whisper-1»,
 * «local:ggml-base.bin+loudnorm»): only the provider is shown, never a model
 * file or a variant. An identifier that cannot be named returns '' (the
 * caller then falls back to the providers or the engine family).
 */
function engineNameEs(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  if (ENGINE_NAMES_ES[key]) return ENGINE_NAMES_ES[key];
  const [provider, ...rest] = key.split(/[:+]/);
  if (!provider || provider === 'unknown') return '';
  if ((provider === 'local' || provider === 'local-whisper' || provider === 'whisper-cpp') && STRONG_LOCAL_MODEL_RE.test(rest.join(':'))) {
    return ENGINE_NAMES_ES['local-strong'];
  }
  if (ENGINE_NAMES_ES[provider]) return ENGINE_NAMES_ES[provider];
  // An unknown internal identifier is never printed as is.
  if (/[:+]/.test(raw)) return '';
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 40);
}

function listEs(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** «Whisper local», «OpenAI y Whisper local»: what read the audio, or ''. */
function engineSummaryEs(meta) {
  // Deduped after mapping: «local:ggml-base.bin» and its «+loudnorm» variant are one engine.
  let names = [...new Set((meta.quality?.enginesUsed || []).map(engineNameEs).filter(Boolean))];
  if (!names.length) {
    names = Object.entries(meta.providers && typeof meta.providers === 'object' ? meta.providers : {})
      .filter(([name, count]) => name && Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([name]) => engineNameEs(name));
  }
  names = [...new Set(names.filter(Boolean))];
  if (!names.length) return ENGINE_FAMILY_ES[meta.engine] || '';
  const shown = names.slice(0, MAX_ENGINES_SHOWN);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} y ${more} más` : listEs(shown);
}

/** Recordings of an hour or more print hh:mm:ss, like the body of the files. */
function longFormOf(meta) {
  let end = (Number(meta.timeOffsetSec) || 0) + (Number(meta.durationSec) || 0);
  for (const seg of meta.segments || []) end = Math.max(end, Number(seg.end) || 0);
  return end >= 3600;
}

/** «idioma inglés · 3 hablantes · transcripción literal · nombres y términos: Huamán y Ayacucho», or ''. */
function hintsSummaryEs(hints, fmt) {
  if (!hints || typeof hints !== 'object') return '';
  const parts = [];
  if (hints.language) parts.push(`idioma ${fmt?.languageNameEs ? fmt.languageNameEs(hints.language) : hints.language}`);
  const speakers = Number(hints.speakers);
  if (Number.isInteger(speakers) && speakers > 0) parts.push(`${speakers} ${speakers === 1 ? 'hablante' : 'hablantes'}`);
  if (hints.verbatim === true) parts.push('transcripción literal');
  const terms = (Array.isArray(hints.terms) ? hints.terms : []).map((term) => String(term).trim()).filter(Boolean);
  if (terms.length) {
    const shown = terms.slice(0, MAX_TERMS_SHOWN);
    const more = terms.length - shown.length;
    parts.push(`nombres y términos: ${more > 0 ? `${shown.join(', ')} y ${more} más` : listEs(shown)}`);
  }
  return parts.join(' · ');
}

function languageSuffixEs(code, fmt) {
  const name = code && fmt?.languageNameEs ? fmt.languageNameEs(code) : '';
  return name && name !== 'no detectado' ? ` (${name})` : '';
}

/**
 * The notes a file header gets on top of what the formatter already prints
 * (source, engine notes, doubtful stretches): a text subtitle track kept
 * next to a voice transcript, the on-screen section and the hints given.
 * `transcriptFilesAttached` (chat only): the message carries the transcript
 * TXT/Word/PDF, so the on-screen note may point at their «Texto en
 * pantalla» section; a translation-only delivery or a failed build does not.
 */
function reportExtraNotes(meta, fmt, { where = 'chat', embeddedAttached = false, hints = null, transcriptFilesAttached = true } = {}) {
  const notes = [];
  const authored = AUTHORED_SOURCES.has(meta.source);
  if (!authored && meta.embeddedSubtitles?.segments?.length) {
    const lang = languageSuffixEs(meta.embeddedSubtitles.language, fmt);
    notes.push(`El video también trae subtítulos incrustados${lang}; esta transcripción es del audio${embeddedAttached
      ? ' y esos subtítulos van aparte en SRT' : ''}.`);
  }
  if (!authored && meta.onScreenText?.length) {
    const n = meta.onScreenText.length;
    const count = `${n} ${n === 1 ? 'fragmento' : 'fragmentos'}`;
    notes.push(where === 'file'
      ? `Al final está el texto que aparece en pantalla (${count}).`
      : `También leí el texto que aparece en pantalla (${count})${transcriptFilesAttached === false
        ? '' : '; está en la sección «Texto en pantalla» de los archivos'}.`);
  }
  // The formatter's canonical shape has no hints: they come from the result.
  const given = hintsSummaryEs(normalizeHintsForReport(hints || meta.hints, fmt), fmt);
  if (given) notes.push(`Tuve en cuenta lo que me indicaste: ${given}.`);
  return notes;
}

/**
 * The honest quality report of one file, for the chat. `result` is the
 * formatter input (on the recording's clock, cut to the requested window).
 * Returns { hasReport, level, line, doubtful, doubtfulCount, notes,
 * sourceShort, authored }: `line` is «Calidad: alta · cobertura 99 % ·
 * motor: Whisper local» (empty for an older transcript without a report),
 * `doubtful` «00:12:30–00:13:10 (ruido)», `notes` the source and engine
 * notes plus the subtitle / on-screen / hints notes. `transcriptFilesAttached`
 * is false when no transcript TXT/Word/PDF goes with the message (see
 * reportExtraNotes).
 */
function transcriptQualityReport(result, { includeCoverage = true, formatter = null, embeddedAttached = false,
  transcriptFilesAttached = true } = {}) {
  const fmt = formatter || formatterOrNull();
  const empty = { hasReport: false, level: null, line: '', doubtful: '', doubtfulCount: 0, notes: [], sourceShort: '', authored: false };
  if (!fmt?.normalizeTranscriptResult) return empty;
  let meta;
  try { meta = fmt.normalizeTranscriptResult(result); } catch (_) { return empty; }
  const quality = meta.quality;
  const authored = AUTHORED_SOURCES.has(meta.source);
  const level = quality?.level || null;
  const parts = [];
  if (authored) {
    const label = fmt.sourceLabelEs ? fmt.sourceLabelEs(meta) : '';
    if (label) parts.push(`fuente: ${label}`);
    if (level) parts.push(`calidad ${level}`);
  } else if (quality) {
    if (level) parts.push(`calidad: ${level}`);
    const coverage = Number(meta.coverage);
    if (includeCoverage && meta.coverage != null && Number.isFinite(coverage) && meta.segments.length) {
      parts.push(`cobertura ${Math.floor(Math.max(0, Math.min(1, coverage)) * 100)} %`);
    }
    const engines = engineSummaryEs(meta);
    if (engines) parts.push(`${engines.includes(',') || / y /.test(engines) ? 'motores' : 'motor'}: ${engines}`);
  }
  const joined = parts.join(' · ');
  const line = joined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}` : '';
  let doubtful = '';
  try { doubtful = fmt.doubtfulStretches ? fmt.doubtfulStretches(quality, longFormOf(meta)) : ''; } catch (_) { doubtful = ''; }
  const notes = [];
  const qualityNotes = (quality?.notes || []).slice(0, MAX_CHAT_NOTES);
  if (authored && !qualityNotes.some((note) => SOURCE_NOTE_RE.test(note))) {
    const sourceNote = fmt.sourceNoteEs ? fmt.sourceNoteEs(meta) : '';
    if (sourceNote) notes.push(sourceNote);
  }
  notes.push(...qualityNotes);
  notes.push(...reportExtraNotes(meta, fmt, { where: 'chat', embeddedAttached, hints: result?.hints, transcriptFilesAttached }));
  const sourceShort = meta.source === 'subtitles'
    ? (meta.subtitleOrigin === 'platform' ? 'desde los subtítulos de la plataforma' : 'desde los subtítulos del video')
    : meta.source === 'onscreen' ? 'desde el texto en pantalla' : '';
  return {
    hasReport: Boolean(line || doubtful || notes.length),
    level,
    line,
    doubtful,
    doubtfulCount: quality?.lowConfidence?.length || 0,
    notes,
    sourceShort,
    authored,
  };
}

/**
 * The result with the extra header notes added to its quality notes (the
 * formatter prints them as «Nota: …» in the TXT and «Notas» in Word/PDF).
 * The engine's own notes come first; the six header slots are shared.
 */
function withHeaderNotes(result, notes) {
  if (!notes.length) return result;
  const base = result.quality && typeof result.quality === 'object' ? result.quality
    : { score: null, level: null, lowConfidence: [], escalations: 0, enginesUsed: [], notes: [] };
  const own = (Array.isArray(base.notes) ? base.notes : []).filter((note) => !notes.includes(note));
  return { ...result, quality: { ...base, notes: [...own.slice(0, Math.max(0, HEADER_NOTE_SLOTS - notes.length)), ...notes] } };
}

/** The text subtitle track kept next to a voice transcript, as SRT (on the same clock and window). */
function embeddedSubtitlesSrt(result, fmt) {
  const track = result.embeddedSubtitles;
  if (!track?.segments?.length || typeof fmt.renderSrt !== 'function') return '';
  try {
    return fmt.renderSrt({ source: 'subtitles', segments: track.segments, language: track.language || null,
      durationSec: result.durationSec || null, ...(Number(result.timeOffsetSec) > 0 ? { timeOffsetSec: result.timeOffsetSec } : {}) }) || '';
  } catch (_) {
    return '';
  }
}

/** «clase (subtítulos incrustados).srt», with the window when one was asked. */
function embeddedSubtitlesName(row, range) {
  const window = range ? ` ${rangeLabel(range).replace(/:/g, '.')}` : '';
  return `${sourceStem(rowName(row))} (subtítulos incrustados${window}).srt`;
}

/**
 * What a deliverable is, for the message that carries it (the artifact
 * store renames files, so the name cannot tell): 'transcript' (TXT, Word,
 * PDF), 'subtitles' (SRT/VTT of the transcript), 'embedded_subtitles' (the
 * video's own text track) or 'translation'.
 */
const ARTIFACT_ROLES = Object.freeze(['transcript', 'subtitles', 'embedded_subtitles', 'translation']);

function toArtifact(filename, content, format, role = null) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  return { filename, base64: buffer.toString('base64'), mime: MIME[format], format, sizeBytes: buffer.length,
    ...(ARTIFACT_ROLES.includes(role) ? { role } : {}) };
}

/**
 * Render under a unique working name: the document service writes to
 * uploads/documents/<userId>/<name>, and the friendly deliverable names
 * repeat for one user («Transcripciones (2 archivos).docx», two «Nueva
 * grabación.m4a»), so two overlapping renders would read or delete each
 * other's file. The friendly name stays on the artifact only.
 */
async function renderDocument({ userId, filename, markdown, format, createDocument }) {
  const build = createDocument || require('./document-service').createDocument;
  const ext = format || String(filename || '').split('.').pop() || 'docx';
  const { filePath } = await build(userId, `transcript-${randomUUID()}.${ext}`, markdown);
  try {
    return await fs.readFile(filePath);
  } finally {
    // A working copy only: the artifact store keeps the delivered one.
    if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

/**
 * @returns {Promise<{artifacts: Array<{filename, base64, mime, format, sizeBytes}>, notes: string[], formats: string[]}>}
 */
async function buildMediaTranscriptArtifacts({ rows = [], transcripts = new Map(), output = {}, userId,
  formatter = null, createDocument = null, logger = console } = {}) {
  const fmt = formatter || defaultFormatter();
  const ready = rows.filter((row) => String(row?.extractedText || '').trim());
  const notes = [];
  if (!ready.length) return { artifacts: [], notes, formats: [] };
  const entries = ready.map((row) => {
    const base = resultFor(row, transcripts.get(row.id), output);
    const { result, sliced } = applyRange(base, output.range, fmt);
    if (output.range && !sliced) notes.push(`«${rowName(row)}» no tiene marcas de tiempo; se entrega completa en lugar del tramo ${rangeLabel(output.range)}.`);
    return { row, result, name: rowName(row) };
  });
  const totalSeconds = entries.reduce((sum, entry) => sum + (Number(entry.result.durationSec) || 0), 0);
  const long = totalSeconds >= LONG_RECORDING_SECONDS;
  const wantsDocx = output.documentFormat === 'docx' || (!output.documentFormat && long);
  const wantsPdf = output.documentFormat === 'pdf';
  const single = entries.length === 1;
  const timed = (entry) => entry.result.segments.length > 0;
  const autoSubtitles = single && timed(entries[0]) && (isVideoRow(entries[0].row) || long);
  const subtitleEntries = output.wantsSubtitles ? entries.filter(timed) : autoSubtitles ? entries : [];
  if (output.wantsSubtitles && entries.some((entry) => !timed(entry))) {
    notes.push('Algunas transcripciones no tienen marcas de tiempo, así que no se pudieron generar sus subtítulos.');
  }

  // A text subtitle track kept next to a voice transcript goes out as its
  // own SRT when subtitles were asked for (the header says so).
  const subtitledIds = new Set(subtitleEntries.slice(0, SUBTITLE_FILE_CAP).map((entry) => entry.row.id));
  const packs = entries.map((entry) => {
    const embeddedSrt = output.wantsSubtitles && subtitledIds.has(entry.row.id) && !AUTHORED_SOURCES.has(entry.result.source)
      ? embeddedSubtitlesSrt(entry.result, fmt) : '';
    let headed = entry.result;
    try {
      const meta = fmt.normalizeTranscriptResult ? fmt.normalizeTranscriptResult(entry.result) : null;
      if (meta) {
        headed = withHeaderNotes(entry.result, reportExtraNotes(meta, fmt, { where: 'file', embeddedAttached: Boolean(embeddedSrt),
          hints: entry.result.hints }));
      }
    } catch (_) { headed = entry.result; }
    return { ...entry, embeddedSrt,
      pack: fmt.buildTranscriptPack(headed, { fileName: entry.name, formats: ['txt', 'srt', 'vtt', 'md'] }) };
  });
  const artifacts = [];
  const range = output.range || null;
  const txt = single ? packs[0].pack.txt : packs.map((entry, index) => `${index + 1}. ${entry.name}\n${'='.repeat(48)}\n${entry.pack.txt}`).join('\n\n');
  artifacts.push(toArtifact(deliverableName(ready, 'txt', range), txt, 'txt', 'transcript'));

  const markdown = single ? packs[0].pack.md : [`# Transcripciones (${packs.length} archivos)`, ...packs.map((entry) => entry.pack.md
    // Each file keeps its own section; its title drops one level.
    .replace(/^# /m, '## '))].join('\n\n');
  for (const [wanted, ext] of [[wantsDocx, 'docx'], [wantsPdf, 'pdf']]) {
    if (!wanted) continue;
    try {
      const filename = deliverableName(ready, ext, range);
      const buffer = await renderDocument({ userId, filename, markdown, format: ext, createDocument });
      artifacts.push(toArtifact(filename, buffer, ext, 'transcript'));
    } catch (err) {
      logger?.warn?.('[media-transcript-artifacts] document render failed', ext, err?.code || err?.message || 'render_error');
      notes.push(`No pude generar el ${ext === 'docx' ? 'Word' : 'PDF'}; el TXT tiene la transcripción completa.`);
    }
  }

  const subtitled = subtitleEntries.slice(0, SUBTITLE_FILE_CAP);
  for (const entry of subtitled) {
    const pack = packs.find((candidate) => candidate.row.id === entry.row.id).pack;
    const names = [entry.row];
    if (pack.srt) artifacts.push(toArtifact(deliverableName(names, 'srt', range), pack.srt, 'srt', 'subtitles'));
    if (pack.vtt) artifacts.push(toArtifact(deliverableName(names, 'vtt', range), pack.vtt, 'vtt', 'subtitles'));
    const embeddedSrt = packs.find((candidate) => candidate.row.id === entry.row.id).embeddedSrt;
    if (embeddedSrt) {
      artifacts.push({ ...toArtifact(embeddedSubtitlesName(entry.row, range), embeddedSrt, 'srt', 'embedded_subtitles'),
        ...(entry.row?.id ? { sourceFileId: String(entry.row.id) } : {}) });
    }
  }
  if (subtitleEntries.length > SUBTITLE_FILE_CAP) {
    notes.push(`Generé subtítulos para los primeros ${SUBTITLE_FILE_CAP} archivos; pide los demás por nombre si los necesitas.`);
  }
  return { artifacts, notes, formats: [...new Set(artifacts.map((artifact) => artifact.format))] };
}

/**
 * Deliverables of a translation: one TXT per batch (each file under its own
 * heading) and a Word copy for long texts or when asked.
 * @param {{files: Array<{id, name, text}>, target: {code, name}}} input
 */
async function buildTranslationArtifacts({ files = [], target, output = {}, userId, createDocument = null, logger = console } = {}) {
  const usable = files.filter((file) => String(file?.text || '').trim());
  if (!usable.length || !target?.name) return { artifacts: [], notes: [] };
  const notes = [];
  const label = `traducción al ${target.name}`;
  const base = usable.length === 1 ? `${sourceStem(usable[0].name)} (${label}` : `Traducciones al ${target.name} (${usable.length} archivos`;
  const window = output.range ? ` ${rangeLabel(output.range).replace(/:/g, '.')}` : '';
  const name = (ext) => `${base}${window}).${ext}`;
  const txt = usable.length === 1 ? usable[0].text.trim()
    : usable.map((file, index) => `${index + 1}. ${file.name}\n${'='.repeat(48)}\n${file.text.trim()}`).join('\n\n');
  const artifacts = [toArtifact(name('txt'), `${txt}\n`, 'txt', 'translation')];
  const long = txt.length >= 20000;
  const wanted = output.documentFormat || (long ? 'docx' : null);
  if (wanted === 'docx' || wanted === 'pdf') {
    const markdown = [`# ${usable.length === 1 ? `Traducción al ${target.name} — ${sourceStem(usable[0].name)}` : `Traducciones al ${target.name}`}`,
      ...usable.map((file) => `${usable.length === 1 ? '' : `## ${sourceStem(file.name)}\n\n`}${file.text.trim().split(/\n+/).join('\n\n')}`)].join('\n\n');
    try {
      const filename = name(wanted);
      artifacts.push(toArtifact(filename, await renderDocument({ userId, filename, markdown, format: wanted, createDocument }), wanted, 'translation'));
    } catch (err) {
      logger?.warn?.('[media-transcript-artifacts] translation document failed', err?.code || err?.message || 'render_error');
      notes.push(`No pude generar el ${wanted === 'docx' ? 'Word' : 'PDF'} de la traducción; el TXT la tiene completa.`);
    }
  }
  return { artifacts, notes };
}

function escapeChatMarkdown(value) {
  return String(value || '')
    .replace(/[\\`*_[\]<>|~]/g, (ch) => `\\${ch}`)
    .replace(/^(\s*)(\d+)([.)]\s)/gm, (_m, lead, num, rest) => `${lead}${num}\\${rest}`)
    .replace(/^(\s*)(#{1,6}\s|[-+]\s|={3,}|-{3,})/gm, (_m, lead, marker) => `${lead}\\${marker}`);
}

function headAtParagraph(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return { text: value, cut: false };
  const slice = value.slice(0, maxChars);
  const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
  return { text: (breakAt > maxChars * 0.5 ? slice.slice(0, breakAt) : slice).trim(), cut: true };
}

function languageName(code) {
  const names = { es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán', ca: 'catalán',
    qu: 'quechua', zh: 'chino', ja: 'japonés', ko: 'coreano', ru: 'ruso', ar: 'árabe', nl: 'neerlandés' };
  return names[String(code || '').toLowerCase()] || (code ? String(code) : '');
}

function durationLabel(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (!h) return `${Math.max(1, m)} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

function summaryLine(result, words) {
  // No measured coverage (null) or no audio read (subtitles, screen text): none shown, never «0 %».
  const coverage = result.coverage == null || AUTHORED_SOURCES.has(result.source) ? NaN : Number(result.coverage);
  return [
    durationLabel(result.durationSec),
    languageName(result.language),
    words ? `${words.toLocaleString('es-PE')} palabras` : '',
    Number.isFinite(coverage) && result.segments.length ? `cobertura ${Math.round(coverage * 100)} %` : '',
    result.range ? `tramo ${rangeLabel(result.range)}` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * The stretch of the recording a file holds, on the recording's clock:
 * [offset, offset + duration], widened to its last segment or gap. `end` is
 * null when neither the duration nor any timestamp is known.
 */
function audioSpanOf(result) {
  const start = Number(result?.timeOffsetSec) > 0 ? Number(result.timeOffsetSec) : 0;
  let end = Number(result?.durationSec) > 0 ? start + Number(result.durationSec) : 0;
  for (const seg of result?.segments || []) end = Math.max(end, Number(seg?.end) || 0);
  for (const gap of result?.gaps || []) end = Math.max(end, Number(gap?.end) || 0);
  return { start, end: end > start ? end : null };
}

/**
 * One file as the user asked to see it: on the recording's clock and cut to
 * the requested window (`output.range`), exactly like the deliverables.
 * `sliced` is false when there was no range or the file has no timestamps;
 * `shifted` when a clip offset moved its times; `span` is the audio the
 * file holds before the cut (a window outside it has nothing to show).
 */
function transcriptView(row, transcript, output = {}, formatter = null) {
  const base = resultFor(row, transcript, output);
  const { result, sliced } = applyRange(base, output?.range || null, formatter || defaultFormatter());
  return { result, sliced, shifted: clockOffsetFor(transcript, output) > 0 && base.segments.length > 0, span: audioSpanOf(base) };
}

/** The report lines of a preview card (italic, escaped), or ''. */
function previewReportBlock(report) {
  if (!report?.hasReport) return '';
  const lines = [];
  if (report.line) lines.push(report.line);
  if (report.doubtful) lines.push(`Tramos dudosos: ${report.doubtful}`);
  lines.push(...report.notes);
  return lines.map((line) => `\n\n_${escapeChatMarkdown(line)}_`).join('');
}

/**
 * Chat message body: a summary card per file and a bounded preview.
 * `transcriptFilesAttached`: whether the turn attaches the transcript
 * TXT/Word/PDF (the caller knows: true when its built artifacts are not
 * empty). Omitted, the inline turn's usual case (they are attached) holds.
 */
function buildTranscriptChatPreview({ rows = [], transcripts = new Map(), output = {}, formatter = null,
  transcriptFilesAttached = true } = {}) {
  const fmt = formatter || defaultFormatter();
  const ready = rows.filter((row) => String(row?.extractedText || '').trim());
  if (!ready.length) return '';
  const single = ready.length === 1;
  const parts = [];
  let budget = PREVIEW_TOTAL_MAX_CHARS;
  let anyCut = false;
  for (const row of ready) {
    const base = resultFor(row, transcripts.get(row.id), output);
    const { result } = applyRange(base, output.range, fmt);
    let body = '';
    let stats = {};
    try {
      const pack = fmt.buildTranscriptPack(result, { fileName: rowName(row), formats: ['txt'] });
      stats = pack.stats || {};
      body = fmt.renderText(result, { fileName: rowName(row), header: false });
    } catch (_) {
      body = result.text;
    }
    const limit = single ? (body.length <= PREVIEW_FULL_MAX_CHARS ? PREVIEW_FULL_MAX_CHARS : PREVIEW_HEAD_CHARS) : PREVIEW_BATCH_HEAD_CHARS;
    const head = headAtParagraph(body, Math.min(limit, Math.max(400, budget)));
    budget -= head.text.length;
    anyCut = anyCut || head.cut;
    const line = summaryLine(result, Number(stats.words) || 0);
    const gaps = result.gaps.length
      ? `\n\n_Tramos sin transcribir: ${result.gaps.slice(0, 6).map((gap) => rangeLabel({ start: Number(gap.start), end: Number(gap.end) })).join(', ')}${result.gaps.length > 6 ? '…' : ''}. Escribe «reintenta» para recuperarlos._`
      : '';
    // The summary line already carries the coverage.
    const report = previewReportBlock(transcriptQualityReport(result, { includeCoverage: false, formatter: fmt,
      embeddedAttached: Boolean(output.wantsSubtitles), transcriptFilesAttached: transcriptFilesAttached !== false }));
    parts.push(`#### ${escapeChatMarkdown(rowName(row))}${line ? `\n\n_${line}_` : ''}${report}${gaps}\n\n${escapeChatMarkdown(head.text)}`);
    if (budget <= 400) break;
  }
  if (parts.length < ready.length) anyCut = true;
  if (anyCut) parts.push('_Vista previa. La transcripción completa está en los archivos adjuntos._');
  return parts.join('\n\n');
}

/** Owner-scoped sidecars for the ready rows; a missing or broken one is null. */
async function loadTranscripts(prisma, { userId, rows = [], store = null } = {}) {
  const loader = store || (() => { try { return defaultStore(); } catch (_) { return null; } })();
  const map = new Map();
  if (!loader?.loadMediaTranscript) return map;
  await Promise.all(rows.filter((row) => String(row?.extractedText || '').trim()).map(async (row) => {
    try {
      map.set(row.id, await loader.loadMediaTranscript(prisma, { userId, fileId: row.id }) || null);
    } catch (_) {
      map.set(row.id, null);
    }
  }));
  return map;
}

module.exports = {
  resolveTranscriptOutput,
  buildMediaTranscriptArtifacts,
  buildTranscriptChatPreview,
  buildTranslationArtifacts,
  escapeChatMarkdown,
  loadTranscripts,
  transcriptResultFor,
  transcriptView,
  audioSpanOf,
  clockOffsetFor,
  normalizeSegments,
  deliverableName,
  rangeLabel,
  durationLabel,
  MIME,
  LONG_RECORDING_SECONDS,
  SUBTITLE_FILE_CAP,
  shiftResult,
  transcriptQualityReport,
  reportExtraNotes,
  hintsSummaryEs,
  engineSummaryEs,
  embeddedSubtitlesName,
  engineNameEs,
  ARTIFACT_ROLES,
  _internals: { applyRange, headAtParagraph, sourceStem, isVideoRow, withHeaderNotes, reportFieldsOf, previewReportBlock },
};
