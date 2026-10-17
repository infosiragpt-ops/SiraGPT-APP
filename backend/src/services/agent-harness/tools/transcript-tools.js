'use strict';

/**
 * Transcript tools (contract C7) — the chat agent acts on the transcripts of
 * the recordings in this chat instead of paraphrasing a truncated text:
 *
 *   transcript_lookup   — read a time window («¿qué dijo en el minuto 95?») or
 *                         search the transcript for words, from the owner-
 *                         scoped segments sidecar (never from the 8 000-char
 *                         head the history carries). `[hh:mm:ss]` lines.
 *   retranscribe_range  — «revisa el minuto 12, se escuchó mal»: queue a
 *                         durable refine of that window (media queue refine
 *                         job + a refine delivery that posts the corrected
 *                         stretch into this chat).
 *   rename_speaker      — «el hablante 2 es la Dra. Rojas»: rename a speaker
 *                         label in the sidecar and the stored text.
 *
 * Every file is resolved owner-scoped (the turn's attachments and the chat's
 * newest media batch); nothing here logs transcript text. `deps` is
 * injectable for offline tests (store, format, mediaBatch, queue).
 */

const { z } = require('zod');

const MAX_WINDOW_CHARS = 30_000;
// A start without an end reads a minute before and four after it.
const POINT_BEFORE_SEC = 60;
const POINT_AFTER_SEC = 240;
// The first window when nothing was asked for, and the longest single read.
const DEFAULT_SPAN_SEC = 300;
const MAX_LOOKUP_SPAN_SEC = 60 * 60;
const MAX_SEARCH_HITS = 12;
// One retranscribe_range call re-does at most this much audio.
const MAX_REFINE_SPAN_SEC = 60 * 60;
const MAX_SPEAKER_NAME_CHARS = 60;
const MAX_CANDIDATE_FILES = 50;

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function deps(over = {}) {
  return {
    store: over.store || require('../../media-transcript-store'),
    format: over.format || require('../../media-transcript-format'),
    mediaBatch: over.mediaBatch || require('../../media-batch'),
    queue: over.queue || require('../../media-transcription-queue'),
    // null: no delivery module (tests); undefined: the real one, lazily.
    delivery: over.delivery !== undefined ? over.delivery : lazyDelivery(),
    refineInFlight: typeof over.refineInFlight === 'function' ? over.refineInFlight : null,
  };
}

function lazyDelivery() {
  try { return require('../../media-delivery'); } catch (_) { return null; }
}

// ── per-turn refine budget ──────────────────────────────────────────────────
//
// One turn may re-transcribe at most this much audio in total (a loop of
// retranscribe_range calls would otherwise queue hours of CPU on the
// production box), and never the same stretch twice. Keyed by the turn's
// shared tool context, so nothing is written on it.
const MAX_TURN_REFINE_SEC = 60 * 60;
const turnRefines = new WeakMap();

function refinesOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  let entry = turnRefines.get(ctx);
  if (!entry) { entry = { seconds: 0, ranges: [] }; turnRefines.set(ctx, entry); }
  return entry;
}

/**
 * A refine of `fileId` is queued or running (a pending refine delivery, or
 * one this turn queued): its splice would undo a speaker rename. Never throws.
 */
async function refinePending(row, ctx, d) {
  const turn = ctx && typeof ctx === 'object' ? turnRefines.get(ctx) : null;
  if (turn && turn.ranges.some(range => range.fileId === row.id)) return true;
  if (d.refineInFlight) {
    try { return Boolean(await d.refineInFlight({ fileId: row.id, userId: ctx.userId })); } catch (_) { return false; }
  }
  const delivery = d.delivery;
  try {
    if (!delivery || typeof delivery.getMediaDeliveryService !== 'function'
      || (typeof delivery.isMediaDeliveryEnabled === 'function' && !delivery.isMediaDeliveryEnabled())) return false;
    const store = delivery.getMediaDeliveryService()?.store;
    if (!store || typeof store.findPendingByFile !== 'function') return false;
    const records = await store.findPendingByFile(row.id, { userId: ctx.userId });
    return (Array.isArray(records) ? records : []).some(record => record && record.kind === 'refine');
  } catch (_) {
    return false;
  }
}

function parseTimecode(value) {
  return require('./transcribe-url-tool').parseTimecode(value);
}

function clock(seconds, longForm) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const two = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return longForm || h > 0 ? `${two(h)}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

function fail(code, message, extra = {}) {
  return { ok: false, code, userMessage: message, ...extra };
}

function rowName(row) {
  return String(row?.originalName || row?.filename || row?.id || 'archivo');
}

// ── which recording ─────────────────────────────────────────────────────────

const ROW_SELECT = Object.freeze({ id: true, userId: true, originalName: true, filename: true, mimeType: true,
  processingStage: true, processingError: true, size: true });

/**
 * The media files this turn may read: the turn's attachments, then the
 * chat's newest media batch (owner-checked, never another chat's).
 */
async function candidateMediaRows(ctx = {}, d = deps()) {
  const prisma = ctx.prisma;
  const userId = ctx.userId;
  if (!prisma?.file?.findMany || !userId) return [];
  const ids = [];
  for (const id of Array.isArray(ctx.fileIds) ? ctx.fileIds : []) if (typeof id === 'string' && id) ids.push(id);
  if (ctx.chatId && typeof d.mediaBatch.resolveChatMediaFileIds === 'function') {
    try { ids.push(...await d.mediaBatch.resolveChatMediaFileIds(prisma, { userId, chatId: ctx.chatId })); } catch (_) { /* none */ }
  }
  const unique = [...new Set(ids)].slice(0, MAX_CANDIDATE_FILES);
  if (!unique.length) return [];
  let rows = [];
  try {
    rows = await prisma.file.findMany({ where: { id: { in: unique }, userId, deletedAt: null }, select: ROW_SELECT });
  } catch (_) { return []; }
  const byId = new Map((Array.isArray(rows) ? rows : []).filter(row => row && row.userId === userId).map(row => [row.id, row]));
  return unique.map(id => byId.get(id)).filter(row => row && d.queue.isMediaFile(row));
}

/**
 * The recording `file` names (id or name), or the only one in context.
 * Returns { row } or a structured failure (several candidates, none, unknown).
 */
async function resolveMediaRow(file, ctx = {}, d = deps()) {
  if (!ctx.prisma || !ctx.userId) return { error: fail('transcripts_unavailable', 'No puedo leer transcripciones en este contexto.') };
  const rows = await candidateMediaRows(ctx, d);
  const wanted = typeof file === 'string' ? file.trim() : '';
  if (wanted) {
    const byId = rows.find(row => row.id === wanted);
    if (byId) return { row: byId };
    // An id outside the chat context is still the user's own file.
    if (/^[A-Za-z0-9_-]{8,64}$/.test(wanted) && typeof ctx.prisma.file.findFirst === 'function') {
      try {
        const own = await ctx.prisma.file.findFirst({ where: { id: wanted, userId: ctx.userId, deletedAt: null }, select: ROW_SELECT });
        if (own && own.userId === ctx.userId && d.queue.isMediaFile(own)) return { row: own };
      } catch (_) { /* fall through to name matching */ }
    }
    // One recording in context: a slightly different name still means it.
    if (rows.length === 1) return { row: rows[0] };
    const picked = d.mediaBatch.pickRowByName(rows, wanted);
    if (picked) return { row: picked };
    if (rows.length) {
      return { error: fail('file_not_found', `No encuentro «${wanted.slice(0, 80)}» entre las grabaciones de este chat.`, { files: describeRows(rows) }) };
    }
  }
  if (rows.length === 1) return { row: rows[0] };
  if (!rows.length) {
    return { error: fail('no_media', 'No hay grabaciones transcritas en este chat. Pide al usuario que adjunte el audio o el video, o usa transcribe_url si pegó un enlace.') };
  }
  return { error: fail('file_ambiguous', 'Hay varias grabaciones en este chat; vuelve a llamar con `file` (nombre o id).', { files: describeRows(rows) }) };
}

function describeRows(rows) {
  return rows.slice(0, 12).map(row => ({ id: row.id, name: rowName(row), stage: row.processingStage || null }));
}

function readyState(row, d) {
  const ready = row.processingStage === 'ready' && !d.queue.isReprocessingPartial?.(row);
  return ready ? null : fail('transcript_not_ready', `La transcripción de «${rowName(row)}» todavía no está lista (${row.processingStage || 'en cola'}). Avísale al usuario que se entregará en este chat cuando termine.`);
}

// ── reading a window ────────────────────────────────────────────────────────

const PARAGRAPH_LINE_RE = /^\[(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\]\s?(.*)$/;

/** Stored text «[hh:mm:ss] …» paragraphs → [{ start, text }] (the fallback without a sidecar). */
function paragraphsFromText(text) {
  const out = [];
  for (const block of String(text || '').split(/\n{1,}/)) {
    const m = PARAGRAPH_LINE_RE.exec(block.trim());
    if (m) {
      const start = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
      out.push({ start, text: block.trim() });
    } else if (out.length && block.trim()) {
      out[out.length - 1].text += `\n${block.trim()}`;
    }
  }
  return out;
}

function capText(text, maxChars = MAX_WINDOW_CHARS) {
  const value = String(text || '');
  if (value.length <= maxChars) return { text: value, truncated: false };
  const cut = value.lastIndexOf('\n', maxChars);
  return { text: `${value.slice(0, cut > maxChars / 2 ? cut : maxChars)}\n[… tramo recortado: pide un tramo más corto para leer el resto]`, truncated: true };
}

function windowFor({ start = null, end = null } = {}, audioStart = 0, audioEnd = null) {
  let from;
  let to;
  if (start != null && end != null) { from = start; to = Math.min(end, start + MAX_LOOKUP_SPAN_SEC); }
  else if (start != null) { from = Math.max(audioStart, start - POINT_BEFORE_SEC); to = start + POINT_AFTER_SEC; }
  else if (end != null) { from = Math.max(audioStart, end - DEFAULT_SPAN_SEC); to = end; }
  else { from = audioStart; to = audioStart + DEFAULT_SPAN_SEC; }
  from = Math.max(audioStart, from);
  if (audioEnd != null) to = Math.min(to, audioEnd);
  return { start: from, end: to };
}

const STOPWORDS = new Set(['que', 'qué', 'del', 'los', 'las', 'una', 'uno', 'con', 'por', 'para', 'como', 'sobre', 'the', 'and',
  'dijo', 'dice', 'habla', 'hablo', 'minuto', 'parte', 'donde', 'cuando', 'esto', 'esta', 'este', 'eso', 'esa']);

function queryTerms(query) {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && !STOPWORDS.has(word)))].slice(0, 12);
}

/** Segment hits for `query`, best first then by time, with one segment of context each side. */
function searchSegments(segments, query, { longForm }) {
  const terms = queryTerms(query);
  if (!terms.length) return { hits: [], text: '' };
  const scored = [];
  segments.forEach((seg, index) => {
    const text = fold(seg.text);
    let score = 0;
    for (const term of terms) if (text.includes(term)) score += 1;
    if (score) scored.push({ index, score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = scored.slice(0, MAX_SEARCH_HITS).sort((a, b) => a.index - b.index);
  const lines = [];
  let lastIndex = -2;
  for (const { index } of picked) {
    const from = Math.max(0, index - 1);
    const to = Math.min(segments.length - 1, index + 1);
    if (from > lastIndex + 1 && lines.length) lines.push('…');
    for (let i = Math.max(from, lastIndex + 1); i <= to; i++) {
      lines.push(`[${clock(segments[i].start, longForm)}] ${String(segments[i].text || '').trim()}`);
    }
    lastIndex = to;
  }
  return { hits: picked.map(({ index }) => ({ start: segments[index].start, end: segments[index].end })), text: lines.join('\n') };
}

/**
 * Read a window (or search) of one owned recording's transcript. The sidecar
 * is the source; a recording without one falls back to the stored
 * «[hh:mm:ss]» text. Returns { ok, ... } or a structured failure.
 */
async function readTranscriptWindow(prisma, { userId, fileId, fileName = null } = {}, { start = null, end = null, query = null, maxChars = MAX_WINDOW_CHARS } = {}, over = {}) {
  const d = deps(over);
  let transcript = null;
  try { transcript = await d.store.loadMediaTranscript(prisma, { userId, fileId }); } catch (_) { transcript = null; }
  const name = fileName || transcript?.fileName || null;
  if (transcript && !transcript.synthetic && Array.isArray(transcript.segments) && transcript.segments.length) {
    const offset = Number(transcript.timeOffsetSec) > 0 ? Number(transcript.timeOffsetSec) : 0;
    const duration = Number(transcript.durationSec) > 0 ? Number(transcript.durationSec) : null;
    let lastEnd = 0;
    for (const seg of transcript.segments) lastEnd = Math.max(lastEnd, Number(seg.end) || 0);
    const audioEnd = duration ? Math.max(offset + duration, lastEnd) : lastEnd || null;
    const longForm = (audioEnd || 0) >= 3600;
    const base = { ok: true, source: 'sidecar', file: { id: fileId, name }, durationSec: duration,
      language: transcript.language || null, transcriptSource: transcript.source || 'asr', partial: transcript.partial === true };
    if (query && String(query).trim() && start == null && end == null) {
      const found = searchSegments(transcript.segments, query, { longForm });
      const capped = capText(found.text, maxChars);
      return { ...base, query: String(query).slice(0, 200), hits: found.hits.length,
        text: found.hits.length ? capped.text : '', truncated: capped.truncated,
        note: found.hits.length ? 'Coincidencias con su marca [hh:mm:ss] y una línea de contexto a cada lado.' : 'Ninguna coincidencia en la transcripción; prueba otras palabras o lee un tramo por tiempo.' };
    }
    // A clip of a longer recording (a link stretch) covers [offset, audioEnd]:
    // a moment before it is not in this transcript — never «an invalid range».
    const covered = offset > 0
      ? `Esta transcripción cubre ${clock(offset, true)}–${audioEnd != null ? clock(audioEnd, true) : '…'}`
      : null;
    if ((start != null && end == null && start < offset) || (end != null && end <= offset)) {
      return fail('out_of_range', `${covered || 'La transcripción empieza más tarde'}; ese minuto queda fuera.`,
        { durationSec: duration, covers: { start: offset, end: audioEnd } });
    }
    if (audioEnd != null && start != null && start >= audioEnd) {
      return fail('out_of_range', covered ? `${covered}; ese minuto queda fuera.` : `La grabación dura ${clock(audioEnd - offset, longForm)}; ese minuto queda fuera.`,
        { durationSec: duration, ...(covered ? { covers: { start: offset, end: audioEnd } } : {}) });
    }
    const window = windowFor({ start, end }, offset, audioEnd);
    if (!(window.end > window.start)) return fail('invalid_range', 'El tramo no es válido: el inicio debe ser anterior al fin.');
    const sliced = d.format.sliceResult(transcript, window);
    if (!sliced) return fail('transcript_untimed', 'Esta transcripción no tiene marcas de tiempo; no puedo leer un minuto concreto.');
    let body = '';
    try { body = d.format.renderText(sliced, { fileName: name, header: false }); } catch (_) { body = ''; }
    const capped = capText(String(body || '').trim(), maxChars);
    const gaps = (Array.isArray(sliced.gaps) ? sliced.gaps : []).map(gap => ({ start: gap.start, end: gap.end, reason: gap.reason || null,
      label: `${clock(gap.start, longForm)}–${clock(gap.end, longForm)}` }));
    const doubtful = (Array.isArray(sliced.quality?.lowConfidence) ? sliced.quality.lowConfidence : []).slice(0, 12)
      .map(item => ({ start: item.start, end: item.end, reason: item.reason || null, label: `${clock(item.start, longForm)}–${clock(item.end, longForm)}` }));
    return { ...base, window: { start: window.start, end: window.end, label: `${clock(window.start, longForm)}–${clock(window.end, longForm)}` },
      text: capped.text || '(Sin voz transcrita en este tramo.)', truncated: capped.truncated, gaps, doubtful };
  }
  // No sidecar (older transcript or a text-only one): the stored text's paragraphs.
  let row = null;
  try {
    row = await prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null }, select: { id: true, originalName: true, extractedText: true } });
  } catch (_) { row = null; }
  if (!row || !String(row.extractedText || '').trim()) return fail('transcript_missing', 'No encuentro la transcripción de esa grabación.');
  const paragraphs = paragraphsFromText(row.extractedText);
  const base = { ok: true, source: 'text', file: { id: fileId, name: name || row.originalName || null } };
  if (!paragraphs.length) {
    const capped = capText(String(row.extractedText), maxChars);
    return { ...base, untimed: true, text: capped.text, truncated: capped.truncated,
      note: 'Esta transcripción no tiene marcas de tiempo: no puedo ubicar un minuto concreto.' };
  }
  const longForm = paragraphs[paragraphs.length - 1].start >= 3600;
  if (query && String(query).trim() && start == null && end == null) {
    const terms = queryTerms(query);
    const hits = paragraphs.filter(p => terms.some(term => fold(p.text).includes(term))).slice(0, MAX_SEARCH_HITS);
    const capped = capText(hits.map(p => p.text).join('\n\n'), maxChars);
    return { ...base, query: String(query).slice(0, 200), hits: hits.length, text: capped.text, truncated: capped.truncated };
  }
  const window = windowFor({ start, end }, 0, null);
  const picked = paragraphs.filter((p, index) => {
    const next = paragraphs[index + 1];
    const pEnd = next ? next.start : p.start + 90;
    return pEnd > window.start && p.start < window.end;
  });
  const capped = capText(picked.map(p => p.text).join('\n\n'), maxChars);
  return { ...base, window: { start: window.start, end: window.end, label: `${clock(window.start, longForm)}–${clock(window.end, longForm)}` },
    text: capped.text || '(Sin voz transcrita en este tramo.)', truncated: capped.truncated };
}

// ── tools ───────────────────────────────────────────────────────────────────

const timeValue = z.union([z.string().min(1).max(40), z.number().min(0).max(7 * 24 * 3600)]);

const lookupSchema = z.object({
  file: z.string().min(1).max(300).optional().describe('Name or id of the recording. Omit when the chat has only one.'),
  start: timeValue.optional().describe('Start of the window: seconds or "mm:ss" / "hh:mm:ss" ("1:35:00" for minute 95). Alone, it reads a minute before and four after.'),
  end: timeValue.optional().describe('End of the window (same formats).'),
  query: z.string().min(1).max(200).optional().describe('Words to find in the transcript (when the user asks WHERE something is said).'),
}).strict();

const retranscribeSchema = z.object({
  file: z.string().min(1).max(300).optional().describe('Name or id of the recording. Omit when the chat has only one.'),
  start: timeValue.describe('Start of the stretch to transcribe again (seconds or "mm:ss" / "hh:mm:ss").'),
  end: timeValue.describe('End of the stretch (same formats). At most one hour per call.'),
  language: z.string().min(2).max(20).optional().describe('Language of the speech when the user said it (es, en, «inglés»…).'),
  terms: z.array(z.string().min(2).max(60)).max(30).optional().describe('Names / terms the user gave («Huamán», «Ayacucho»): they bias the recogniser.'),
}).strict();

const renameSchema = z.object({
  file: z.string().min(1).max(300).optional().describe('Name or id of the recording. Omit when the chat has only one.'),
  from: z.string().min(1).max(60).describe('The speaker label as shown («Hablante 2») or its number («2»).'),
  to: z.string().min(1).max(MAX_SPEAKER_NAME_CHARS).describe('The real name («Dra. Rojas»).'),
}).strict();

function parseTimeArg(value, label) {
  if (value == null || value === '') return { value: null };
  const parsed = parseTimecode(value);
  if (parsed == null) return { error: fail('invalid_range', `«${String(value).slice(0, 40)}» no es una marca de tiempo válida para ${label} (usa segundos o mm:ss / hh:mm:ss).`) };
  return { value: parsed };
}

function buildTranscriptLookupTool(over = {}) {
  return {
    name: 'transcript_lookup',
    description: [
      'Read the transcript of a recording (audio/video) of THIS chat by time window, or search it for words. Returns `[hh:mm:ss]` lines from the stored segments.',
      'WHEN TO USE: «¿qué dijo en el minuto 95?», «léeme del minuto 30 al 35», «¿en qué minuto habla de la mitocondria?», «¿quién habla en el minuto 12?» — any question about a moment of a long recording. Convert «minuto 95» to start "1:35:00". Never answer about a minute you have not read with this tool: the history only carries the beginning of long transcripts.',
      'WHEN NOT TO USE: a link that was never transcribed (use transcribe_url); a document.',
      'Cite the moments with their [hh:mm:ss] marks. `gaps` / `doubtful` list stretches that were not (or not reliably) transcribed: say so instead of guessing.',
    ].join(' '),
    inputSchema: lookupSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => {
      if (args.query) return `Buscando «${String(args.query).slice(0, 40)}» en la transcripción`;
      const s = parseTimecode(args.start);
      return s != null ? `Leyendo la transcripción desde ${clock(s, s >= 3600)}` : 'Leyendo la transcripción';
    },
    execute: async (args = {}, ctx = {}) => {
      const d = deps(over);
      const resolved = await resolveMediaRow(args.file, ctx, d);
      if (resolved.error) return resolved.error;
      const row = resolved.row;
      const start = parseTimeArg(args.start, 'el inicio');
      if (start.error) return start.error;
      const end = parseTimeArg(args.end, 'el fin');
      if (end.error) return end.error;
      if (start.value != null && end.value != null && end.value <= start.value) return fail('invalid_range', 'El fin del tramo debe ser posterior al inicio.');
      const result = await readTranscriptWindow(ctx.prisma, { userId: ctx.userId, fileId: row.id, fileName: rowName(row) },
        { start: start.value, end: end.value, query: args.query || null }, over);
      if (result.ok) return { ...result, hint: 'Responde solo con lo que dice este texto y cita las marcas [hh:mm:ss]; si el tramo está vacío o marcado como dudoso, dilo.' };
      // A transcript still in the queue (a partial being retried keeps its text and reads above).
      return result.code === 'transcript_missing' ? (readyState(row, d) || result) : result;
    },
  };
}

function buildRetranscribeRangeTool(over = {}) {
  return {
    name: 'retranscribe_range',
    description: [
      'Transcribe AGAIN one stretch of a recording of this chat whose transcript is ready («revisa el minuto 12, se escuchó mal», «vuelve a transcribir de 1:10:00 a 1:15:00», «los nombres son Huamán y Quispe, corrígelo en el minuto 30»).',
      'It queues a durable job (it survives deploys) and the corrected stretch with updated files is posted in this chat when it finishes. Pass the names / terms and language the user gave. At most one hour per call.',
      'Relay `userMessage` as is. Do not promise the corrected text in this answer and do not call it twice for the same stretch.',
    ].join(' '),
    inputSchema: retranscribeSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => {
      const s = parseTimecode(args.start); const e = parseTimecode(args.end);
      return s != null && e != null ? `Volviendo a transcribir ${clock(s, e >= 3600)}–${clock(e, e >= 3600)}` : 'Volviendo a transcribir un tramo';
    },
    execute: async (args = {}, ctx = {}) => {
      const d = deps(over);
      const resolved = await resolveMediaRow(args.file, ctx, d);
      if (resolved.error) return resolved.error;
      const row = resolved.row;
      const notReady = readyState(row, d);
      if (notReady) return notReady;
      const start = parseTimeArg(args.start, 'el inicio');
      if (start.error) return start.error;
      const end = parseTimeArg(args.end, 'el fin');
      if (end.error) return end.error;
      if (start.value == null || end.value == null || end.value <= start.value) return fail('invalid_range', 'Indica un tramo con inicio y fin (el fin después del inicio).');
      if (end.value - start.value > MAX_REFINE_SPAN_SEC) {
        return fail('range_too_long', 'El tramo supera una hora; pídelo por partes (por ejemplo de hora en hora).');
      }
      const turn = refinesOf(ctx);
      if (turn) {
        if (turn.ranges.some(range => range.fileId === row.id && range.start < end.value && start.value < range.end)) {
          return fail('refine_already_queued', 'Ese tramo ya está en cola para volver a transcribirse en este mensaje; no lo pidas otra vez. Avísale al usuario que llegará corregido a este chat.');
        }
        if (turn.seconds + (end.value - start.value) > MAX_TURN_REFINE_SEC) {
          return fail('refine_budget', `En este mensaje ya programé volver a transcribir ${clock(turn.seconds, true)} de audio (máximo una hora por mensaje). Pregúntale al usuario si quiere corregir más tramos; con su confirmación se programan en el siguiente mensaje.`);
        }
      }
      const language = args.language ? d.format.normalizeHintLanguage(args.language) : null;
      const terms = Array.isArray(args.terms) ? d.format.normalizeHintTerms(args.terms) : [];
      const outcome = await d.mediaBatch.requestMediaRefine({
        prisma: ctx.prisma, userId: ctx.userId, chatId: ctx.chatId || null, taskId: ctx.taskId || null,
        rows: [row], goal: String(ctx.userQuery || '').slice(0, 4000),
        intent: { kind: 'refine', range: { start: start.value, end: end.value } },
        language, hints: terms.length ? { terms } : null,
        ...(over.refineDeps ? { deps: over.refineDeps } : {}),
      });
      if (!outcome.ok) return fail(outcome.reason || 'refine_failed', outcome.message || 'No pude programar la corrección de ese tramo.');
      if (turn) {
        const queued = outcome.range && Number.isFinite(Number(outcome.range.start)) && Number.isFinite(Number(outcome.range.end))
          ? { start: Number(outcome.range.start), end: Number(outcome.range.end) } : { start: start.value, end: end.value };
        turn.ranges.push({ fileId: row.id, ...queued });
        turn.seconds += Math.max(0, queued.end - queued.start);
      }
      return { ok: true, queued: true, file: { id: row.id, name: rowName(row) }, range: outcome.range,
        deliveryId: outcome.deliveryId || null, userMessage: outcome.message,
        hint: 'Transmite userMessage tal cual: el tramo corregido llega a este chat cuando termine.' };
    },
  };
}

const GENERIC_LABEL_RE = /^(?:(?:hablante|speaker|spk|locutor|voz|persona|participante)\s*)?#?\s*(\d{1,3})$/i;

function cleanSpeakerName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\[\]{}<>]/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_SPEAKER_NAME_CHARS);
  return /\p{L}/u.test(name) ? name : '';
}

/** The raw speaker id `from` designates: its label («Hablante 2»), its number, the raw id or a given name. */
function resolveSpeaker(from, labels) {
  const wanted = fold(String(from || '').trim());
  if (!wanted) return null;
  const entries = [...labels.entries()];
  const exact = entries.find(([raw, label]) => fold(raw) === wanted || fold(label) === wanted);
  if (exact) return exact[0];
  const m = GENERIC_LABEL_RE.exec(wanted);
  if (m) {
    const byNumber = entries.find(([, label]) => fold(label) === `hablante ${Number(m[1])}`);
    if (byNumber) return byNumber[0];
  }
  return null;
}

function buildRenameSpeakerTool(over = {}) {
  return {
    name: 'rename_speaker',
    description: [
      'Rename a speaker of a diarized transcript of this chat («el hablante 2 es la Dra. Rojas»): the stored segments, the text the chat reads and later downloads use the new name.',
      'Only for transcripts that already separate speakers («Hablante 1», «Hablante 2»…). The remaining generic speakers are numbered again in order of appearance: relay the `summary` with the new labels.',
    ].join(' '),
    inputSchema: renameSchema,
    permissionTier: 'auto',
    humanDescription: (args = {}) => `Renombrando «${String(args.from || '').slice(0, 30)}» como «${String(args.to || '').slice(0, 30)}»`,
    execute: async (args = {}, ctx = {}) => {
      const d = deps(over);
      const resolved = await resolveMediaRow(args.file, ctx, d);
      if (resolved.error) return resolved.error;
      const row = resolved.row;
      const notReady = readyState(row, d);
      if (notReady) return notReady;
      const name = cleanSpeakerName(args.to);
      if (!name) return fail('invalid_name', 'El nombre nuevo no es válido.');
      // A refine that splices its window back would silently undo the rename.
      if (await refinePending(row, ctx, d)) {
        return fail('refine_in_progress', `Hay una corrección en curso de «${rowName(row)}»; renombra el hablante cuando termine (llegará a este chat).`);
      }
      let transcript = null;
      try { transcript = await d.store.loadMediaTranscript(ctx.prisma, { userId: ctx.userId, fileId: row.id }); } catch (_) { transcript = null; }
      if (!transcript || !Array.isArray(transcript.segments) || !transcript.segments.length) {
        return fail('transcript_missing', 'No encuentro los segmentos de esa transcripción para renombrar hablantes.');
      }
      const before = d.format.speakerLabels(transcript.segments);
      if (!before.labels.size) {
        return fail('no_speakers', 'Esta transcripción no separa hablantes (no se distinguieron las voces), así que no hay etiquetas que renombrar.');
      }
      const raw = resolveSpeaker(args.from, before.labels);
      if (raw == null) {
        return fail('speaker_not_found', `No hay un hablante «${String(args.from).slice(0, 40)}» en esta transcripción.`,
          { speakers: [...before.labels.values()] });
      }
      const segments = transcript.segments.map(seg => (seg.speaker === raw ? { ...seg, speaker: name } : seg));
      const patched = { ...transcript, segments };
      try {
        await d.store.writeSidecar({ fileId: row.id, userId: ctx.userId, result: patched },
          transcript.createdAt ? { now: new Date(transcript.createdAt) } : {});
      } catch (err) {
        return fail('rename_failed', 'No pude guardar el cambio de nombre; la transcripción sigue como estaba.');
      }
      // The text the chat and RAG read follows the sidecar (long recordings
      // keep their «[hh:mm:ss] Nombre: …» paragraphs; short clips have none).
      let textUpdated = false;
      try {
        const text = d.queue.transcriptTextFor(patched, null, { fileName: rowName(row), formatter: d.format });
        if (text) {
          const note = (patched.source === 'subtitles' || patched.source === 'onscreen') && patched.quality?.notes?.[0];
          const stored = note ? `(${note})\n\n${text}` : text;
          const updated = await ctx.prisma.file.updateMany({ where: { id: row.id, userId: ctx.userId, deletedAt: null }, data: { extractedText: stored } });
          textUpdated = Number(updated?.count) === 1;
        }
      } catch (_) { textUpdated = false; }
      const after = d.format.speakerLabels(segments);
      const changes = [];
      for (const [id, label] of before.labels) {
        const next = id === raw ? name : after.labels.get(id);
        if (next && next !== label) changes.push(`${label} → ${next}`);
      }
      return { ok: true, file: { id: row.id, name: rowName(row) }, renamed: { from: before.labels.get(raw), to: name },
        speakers: [...after.labels.values()], textUpdated,
        summary: `Listo: en «${rowName(row)}» ${changes.join(', ')}. Hablantes ahora: ${[...after.labels.values()].join(', ')}.` };
    },
  };
}

function buildTranscriptTools(over = {}) {
  return [buildTranscriptLookupTool(over), buildRetranscribeRangeTool(over), buildRenameSpeakerTool(over)];
}

/** «minuto 95», «se escuchó mal», «hablante 2», «transcripción»: a turn the transcript tools may serve. */
const TRANSCRIPT_FOLLOWUP_RE = /\b(?:minutos?|min\.?\s*\d|hora\s+\d|\d{1,2}:\d{2}|transcri\w*|trascri\w*|hablantes?|speakers?|se\s+(?:escuch|oy|entend)\w*\s+mal|no\s+se\s+(?:entiende|escucha|oye)|grabaci[oó]n|audio|video|v[ií]deo)\b/i;

function mentionsTranscriptFollowup(text) {
  return TRANSCRIPT_FOLLOWUP_RE.test(String(text || ''));
}

module.exports = {
  buildTranscriptTools,
  buildTranscriptLookupTool,
  buildRetranscribeRangeTool,
  buildRenameSpeakerTool,
  readTranscriptWindow,
  resolveMediaRow,
  candidateMediaRows,
  paragraphsFromText,
  searchSegments,
  resolveSpeaker,
  mentionsTranscriptFollowup,
  MAX_WINDOW_CHARS,
  MAX_REFINE_SPAN_SEC,
  MAX_TURN_REFINE_SEC,
};
