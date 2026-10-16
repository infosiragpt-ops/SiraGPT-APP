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

/** The formatter input for one file: its sidecar when present, else its text. */
function transcriptResultFor(row, transcript) {
  const segments = normalizeSegments(transcript?.segments);
  const storedOffset = storedOffsetOf(transcript);
  // durationSec is the clip's own length; a shifted clip spans [offset, offset + duration].
  const spoken = segments.length ? Math.max(...segments.map((seg) => seg.end)) - storedOffset : 0;
  const durationSec = Number(transcript?.durationSec) || (spoken > 0 ? spoken : null);
  return {
    text: String(row?.extractedText || '').trim(),
    transcript: String(row?.extractedText || '').trim(),
    segments,
    language: transcript?.language || null,
    durationSec: durationSec || null,
    coverage: Number.isFinite(Number(transcript?.coverage)) ? Number(transcript.coverage) : (segments.length ? 1 : null),
    gaps: Array.isArray(transcript?.gaps) ? transcript.gaps : [],
    partial: Boolean(transcript?.partial) || String(row?.processingError || '').startsWith('Parcial:'),
    providers: transcript?.providers || null,
    engine: transcript?.engine || null,
    segmentCount: Number(transcript?.segmentCount) || segments.length,
    ...(storedOffset ? { timeOffsetSec: storedOffset } : {}),
  };
}

/**
 * A clip cut from a longer recording (a link section «del minuto 60 al 90»)
 * is transcribed from 0; its deliverables follow the recording's own clock.
 * Same shape as a transcript the media queue stored already shifted:
 * segments and gaps move, durationSec stays the clip's length and
 * timeOffsetSec marks the shift (the window is [offset, offset + duration]).
 */
function shiftResult(result, offsetSec) {
  const offset = Number(offsetSec) || 0;
  if (!(offset > 0) || !result.segments.length) return result;
  return {
    ...result,
    segments: result.segments.map((seg) => ({ ...seg, start: seg.start + offset, end: seg.end + offset })),
    gaps: result.gaps.map((gap) => ({ ...gap, start: Number(gap.start) + offset, end: Number(gap.end) + offset })),
    timeOffsetSec: offset,
  };
}

function resultFor(row, transcript, output) {
  return shiftResult(transcriptResultFor(row, transcript), clockOffsetFor(transcript, output));
}

function applyRange(result, range, formatter) {
  if (!range || !result.segments.length) return { result, sliced: false };
  const end = range.end == null ? null : Number(range.end);
  // The formatter clips gaps to the window and recomputes coverage.
  const sliced = typeof formatter.sliceResult === 'function' ? formatter.sliceResult(result, { start: range.start, end }) : null;
  const segments = normalizeSegments(sliced ? sliced.segments : formatter.sliceSegments(result.segments, { start: range.start, end }));
  const gaps = sliced ? sliced.gaps : result.gaps.filter((gap) => Number(gap.end) > range.start && (end == null || Number(gap.start) < end));
  const text = segments.map((seg) => seg.text).join(' ');
  return { result: { ...result, ...(sliced || {}), segments, gaps, text, transcript: text, range: { start: range.start, end } }, sliced: true };
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

function toArtifact(filename, content, format) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  return { filename, base64: buffer.toString('base64'), mime: MIME[format], format, sizeBytes: buffer.length };
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

  const packs = entries.map((entry) => ({ ...entry,
    pack: fmt.buildTranscriptPack(entry.result, { fileName: entry.name, formats: ['txt', 'srt', 'vtt', 'md'] }) }));
  const artifacts = [];
  const range = output.range || null;
  const txt = single ? packs[0].pack.txt : packs.map((entry, index) => `${index + 1}. ${entry.name}\n${'='.repeat(48)}\n${entry.pack.txt}`).join('\n\n');
  artifacts.push(toArtifact(deliverableName(ready, 'txt', range), txt, 'txt'));

  const markdown = single ? packs[0].pack.md : [`# Transcripciones (${packs.length} archivos)`, ...packs.map((entry) => entry.pack.md
    // Each file keeps its own section; its title drops one level.
    .replace(/^# /m, '## '))].join('\n\n');
  for (const [wanted, ext] of [[wantsDocx, 'docx'], [wantsPdf, 'pdf']]) {
    if (!wanted) continue;
    try {
      const filename = deliverableName(ready, ext, range);
      const buffer = await renderDocument({ userId, filename, markdown, format: ext, createDocument });
      artifacts.push(toArtifact(filename, buffer, ext));
    } catch (err) {
      logger?.warn?.('[media-transcript-artifacts] document render failed', ext, err?.code || err?.message || 'render_error');
      notes.push(`No pude generar el ${ext === 'docx' ? 'Word' : 'PDF'}; el TXT tiene la transcripción completa.`);
    }
  }

  const subtitled = subtitleEntries.slice(0, SUBTITLE_FILE_CAP);
  for (const entry of subtitled) {
    const pack = packs.find((candidate) => candidate.row.id === entry.row.id).pack;
    const names = [entry.row];
    if (pack.srt) artifacts.push(toArtifact(deliverableName(names, 'srt', range), pack.srt, 'srt'));
    if (pack.vtt) artifacts.push(toArtifact(deliverableName(names, 'vtt', range), pack.vtt, 'vtt'));
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
  const artifacts = [toArtifact(name('txt'), `${txt}\n`, 'txt')];
  const long = txt.length >= 20000;
  const wanted = output.documentFormat || (long ? 'docx' : null);
  if (wanted === 'docx' || wanted === 'pdf') {
    const markdown = [`# ${usable.length === 1 ? `Traducción al ${target.name} — ${sourceStem(usable[0].name)}` : `Traducciones al ${target.name}`}`,
      ...usable.map((file) => `${usable.length === 1 ? '' : `## ${sourceStem(file.name)}\n\n`}${file.text.trim().split(/\n+/).join('\n\n')}`)].join('\n\n');
    try {
      const filename = name(wanted);
      artifacts.push(toArtifact(filename, await renderDocument({ userId, filename, markdown, format: wanted, createDocument }), wanted));
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
  const coverage = Number(result.coverage);
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

/** Chat message body: a summary card per file and a bounded preview. */
function buildTranscriptChatPreview({ rows = [], transcripts = new Map(), output = {}, formatter = null } = {}) {
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
    parts.push(`#### ${escapeChatMarkdown(rowName(row))}${line ? `\n\n_${line}_` : ''}${gaps}\n\n${escapeChatMarkdown(head.text)}`);
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
  _internals: { applyRange, headAtParagraph, sourceStem, isVideoRow },
};
