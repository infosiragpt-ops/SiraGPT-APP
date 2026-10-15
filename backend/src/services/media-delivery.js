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
// Every side effect is injected (tests use fakes only); the defaults lazily
// require the real modules so this file can be required from the media queue
// and the agent-task runner without load-order cycles.

const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const {
  createMediaDeliveryStore,
  isValidDeliveryId,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
} = require('./media-delivery-store');

const PARTIAL_RE = /^\s*parcial\b/i;
const DEFAULT_INLINE_WAIT_MS = 240000;
// Files still pending after this long are reported as pending instead of
// holding the delivery forever (a media job may take 3 attempts × 12 h).
const PENDING_CEILING_MS = 24 * 60 * 60 * 1000;
const SWEEP_OLD_INTERVAL_MS = 60 * 60 * 1000;
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

function fileDetails(row, transcript, delivery) {
  const parts = [];
  const duration = formatDuration(transcript?.durationSec);
  if (duration) parts.push(duration);
  const language = languageLabel(transcript?.language || delivery?.language);
  if (language) parts.push(language);
  const words = wordCount(row?.extractedText);
  if (words) parts.push(`${formatCount(words)} palabras`);
  const coverage = Number(transcript?.coverage);
  if (stateOf(row) === 'partial' && Number.isFinite(coverage) && coverage > 0 && coverage < 1) {
    parts.push(`cobertura ${Math.floor(coverage * 100)} %`);
  }
  return parts;
}

function missingPartsSentence(row, transcript) {
  const gaps = gapsOf(transcript);
  if (gaps.length) return `Faltan ${gaps.length === 1 ? 'este tramo' : 'estos tramos'}: ${formatGaps(gaps)}.`;
  const detail = partialDetail(row);
  return detail ? `No se pudieron transcribir algunos tramos (${detail}).` : 'No se pudieron transcribir algunos tramos.';
}

/**
 * Spanish chat message for a finished delivery: headline, per-file status
 * (gaps for partial files, reasons for failures), the analysis or a
 * preview, the downloads and the retry hint.
 */
function deliveryMessage({ delivery = {}, rows = [], transcripts = {}, artifacts = [], analysisText = '', analysisFailed = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = summarizeStates(list);
  const single = list.length === 1;
  const blocks = [];
  const transcriptOf = row => transcripts?.[row?.id] || null;

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
    const details = fileDetails(row, transcriptOf(row), delivery);
    if (details.length && (state === 'ready' || state === 'partial')) blocks.push(details.join(' · '));
    if (state === 'partial') blocks.push(missingPartsSentence(row, transcriptOf(row)));
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
      if (state === 'ready') {
        const details = fileDetails(row, transcript, delivery);
        return `- ${name}: lista${details.length ? ` · ${details.join(' · ')}` : ''}`;
      }
      if (state === 'partial') {
        const gaps = gapsOf(transcript);
        const detail = gaps.length ? `faltan ${formatGaps(gaps, 4)}` : (partialDetail(row) || 'faltan algunos tramos');
        return `- ${name}: parcial (${detail})`;
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
  if (analysisText && String(analysisText).trim()) {
    blocks.push(`### Análisis\n\n${String(analysisText).trim()}`);
  } else if (analysisFailed && usable.length) {
    blocks.push('No pude terminar el análisis que pediste. La transcripción está guardada; vuelve a pedírmelo en este chat cuando quieras.');
  }

  if (usable.length && !(analysisText && String(analysisText).trim())) {
    const shown = usable.slice(0, PREVIEW_FILES);
    const budget = Math.floor(PREVIEW_CHARS / shown.length);
    let truncated = usable.length > shown.length;
    const pieces = shown.map(row => {
      const cut = cutAtParagraph(row.extractedText, budget);
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

/** Inbox / push copy for a delivered transcription. */
function notificationCopy({ delivery = {}, rows = [] } = {}) {
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
  return {
    kind: 'delivery_failed',
    title: 'No pude entregar la transcripción',
    body: `No pude entregar la transcripción de ${subject}. Tus archivos y su transcripción siguen guardados; escribe "reintenta" en el chat.`,
  };
}

function chatTitleFor(delivery = {}, rows = []) {
  const names = (rows.length ? rows.map((row, index) => displayName(row, delivery, index)) : (delivery.fileNames || [])).filter(Boolean);
  const first = String(names[0] || 'archivo').slice(0, 60);
  return `Transcripción: ${first}${names.length > 1 ? ` y ${names.length - 1} más` : ''}`.slice(0, 120);
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
async function defaultBuildArtifacts({ rows = [], transcripts = {}, delivery = {} } = {}) {
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
    try {
      const { createDocument } = require('./document-service');
      const filename = unique(`${base}-transcripcion.docx`);
      const { filePath } = await createDocument(delivery.userId, filename, markdownBundle(rows, delivery));
      const buffer = await fs.promises.readFile(filePath);
      out.push({ filename, base64: buffer.toString('base64'), mime: DOCX_MIME });
    } catch (_) { /* reported to the user as a missing format */ }
  }
  return out;
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
      metadata: { source: 'media-delivery', ...metadata, artifacts: list, updatedAt: new Date().toISOString() },
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
  const result = await require('./media-batch').analyzeMediaBatch({ rows, goal: delivery.goal, complete: completion.complete });
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
 * @param {(prisma, {userId, fileId}) => Promise<object|null>} [deps.loadTranscript]
 * @param {({rows, transcripts, delivery}) => Promise<{filename, base64, mime}[]>} [deps.buildArtifacts]
 * @param {({filename, base64, mime, ownerUserId, chatId}) => object} [deps.saveArtifact]
 * @param {({artifact, userId, chatId, taskId, messageId}) => Promise} [deps.persistArtifact]
 * @param {({userId, chatId, content, metadata, artifacts}) => Promise<{messageId, chatId}>} [deps.postMessage]
 * @param {({userId, chatId, title, model}) => Promise<{chatId, created}|string>} [deps.ensureChat]
 * @param {({userId, title, body, actionUrl, type, metadata}) => Promise} [deps.notify]
 * @param {(({rows, transcripts, delivery}) => Promise<string|{text}>)|null} [deps.analyze]  null disables analysis.
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
  const gate = createGate(Math.max(1, Math.min(4, Number(deps.concurrency) || 1)));

  let prismaRef = deps.prisma || null;
  const getPrisma = () => prismaRef || (prismaRef = require('../config/database'));
  let storeRef = deps.store || null;
  const getStore = () => storeRef || (storeRef = createMediaDeliveryStore({ env, now, root: deps.root || null }));

  const loadFiles = deps.loadFiles || ((userId, fileIds, opts) => defaultLoadFiles(getPrisma(), userId, fileIds, opts));
  const loadTranscript = deps.loadTranscript || defaultLoadTranscript;
  const transcriptPrisma = () => (deps.loadTranscript ? (deps.prisma || null) : getPrisma());
  const buildArtifacts = deps.buildArtifacts || defaultBuildArtifacts;
  const saveArtifact = deps.saveArtifact || (args => require('./agents/task-tools').saveArtifact(args));
  const persistArtifact = deps.persistArtifact || defaultPersistArtifact;
  const postMessage = deps.postMessage || (args => defaultPostMessage(getPrisma(), args));
  const ensureChat = deps.ensureChat || (args => defaultEnsureChat(getPrisma(), args));
  const notify = deps.notify || (args => defaultNotify(getPrisma(), args));
  const analyze = deps.analyze === undefined ? (args => defaultAnalyze({ ...args, prisma: getPrisma() })) : deps.analyze;

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
    logger.info(`[media-delivery] created id=${created.id} files=${created.fileIds.length} mode=${created.mode}`);
    return created;
  }

  async function findDeliveredMessage(chatId, id) {
    if (!chatId) return null;
    const prisma = deps.prisma || getPrisma();
    if (typeof prisma?.message?.findFirst !== 'function') return null;
    // Idempotency: the message carries the delivery id; never post twice.
    return prisma.message.findFirst({
      where: { chatId, metadata: { path: ['mediaDelivery'], equals: id } },
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

  /** Status-only probe (no transcripts loaded): files still pending, and whether the ceiling passed. */
  async function probePending(record) {
    const light = alignRows(record.fileIds, await loadFiles(record.userId, record.fileIds, { includeText: false }), record);
    const createdAt = Date.parse(record.createdAt || '');
    return {
      pending: light.filter(row => !isTerminalRow(row)).length,
      overdue: Number.isFinite(createdAt) && now() - createdAt >= pendingCeilingMs,
    };
  }

  async function attempt(record, token) {
    const store = getStore();
    const { id, userId } = record;
    const ids = record.fileIds;

    // Checked again under the lock: a file may have been re-queued since.
    const probe = await probePending(record);
    checkpoint();
    if (probe.pending && !probe.overdue) {
      await store.release(id, token);
      return { id, status: 'waiting', pending: probe.pending };
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
    let analysisText = '';
    let analysisFailed = false;
    if (record.mode === 'analysis' && usable.length) {
      if (typeof analyze !== 'function') analysisFailed = true;
      else {
        try {
          const result = await analyze({ rows: usable, transcripts, delivery: { ...record, deliveryChatId: targetChatId } });
          analysisText = String(typeof result === 'string' ? result : result?.text || '').trim();
          if (!analysisText) analysisFailed = true;
        } catch (err) {
          analysisFailed = true;
          logger.warn(`[media-delivery] analysis unavailable id=${id} code=${err?.code || 'analysis_error'}`);
        }
      }
      checkpoint();
    }

    const specs = usable.length ? await buildArtifacts({ rows, transcripts, delivery: record }) : [];
    const saved = [];
    for (const spec of Array.isArray(specs) ? specs : []) {
      if (!spec?.filename || typeof spec.base64 !== 'string') continue;
      saved.push(await saveArtifact({ filename: spec.filename, base64: spec.base64, mime: spec.mime,
        ownerUserId: userId, chatId: targetChatId }));
    }
    checkpoint();

    const counts = summarizeStates(rows);
    const content = deliveryMessage({ delivery: record, rows, transcripts, artifacts: saved, analysisText, analysisFailed });
    const metadata = {
      mediaDelivery: id,
      transcriptionFileIds: ids,
      servedBy: 'media_batch',
      taskId: record.taskId || null,
      deliveryMode: record.mode,
      stoppedReason: stoppedReasonFor(counts),
      mediaBatch: counts,
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
    const copy = notificationCopy({ delivery: record, rows });
    try {
      await notify({ userId, title: copy.title, body: copy.body, actionUrl: actionUrlFor(deliveredChatId),
        type: `media_transcription_${copy.kind}`, metadata: { mediaDelivery: id, chatId: deliveredChatId, fileIds: ids } });
    } catch (err) {
      logger.warn(`[media-delivery] notification failed id=${id} code=${err?.code || 'notify_error'}`);
    }
    logger.info(`[media-delivery] delivered id=${id} files=${counts.total} ready=${counts.ready} partial=${counts.partial} failed=${counts.failed} pending=${counts.pending} attempt=${(Number(record.attempts) || 0) + 1}`);
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
      if (probe.pending && !probe.overdue) return { id, status: 'waiting', pending: probe.pending };
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

  /** Media worker hook: a file reached ready / partial / failed. Never throws. */
  async function onMediaTerminal({ fileId, userId } = {}) {
    if (!enabled()) return { status: 'disabled', matched: 0, results: [] };
    try {
      const records = await getStore().findPendingByFile(String(fileId || ''), { userId: userId || null });
      const results = [];
      for (const record of records) results.push(await deliverOne(record.id));
      return { status: 'ok', matched: records.length, results };
    } catch (err) {
      logger.warn(`[media-delivery] terminal hook failed code=${err?.code || 'hook_error'}`);
      return { status: 'error', matched: 0, results: [] };
    }
  }

  /**
   * Reconcile pass (call from the existing 60 s media timer): retries due
   * records and recovers any whose terminal hook was missed (crash, deploy).
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
  TRANSCRIPTION_RTF,
  DEFAULT_INLINE_WAIT_MS,
  PENDING_CEILING_MS,
};
