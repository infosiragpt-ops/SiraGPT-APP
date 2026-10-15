'use strict';

/**
 * media-transcript-format — professional rendering of a media transcription.
 *
 * PURE: no I/O, no network, no module state. Every function takes the engine
 * result (audio-transcriber `transcribe()`), or the normalized sidecar that
 * media-transcript-store.loadMediaTranscript() returns, and produces text.
 *
 * Input contract (both shapes accepted everywhere):
 *   result = { ok, text, transcript, method, model, language, segments,
 *              durationSec, partial, gaps, coverage, providers, engine }
 *   segment = { start, end, text, speaker?, confidence? }   (engine shape)
 *           | { s, e, t, spk?, conf? }                        (sidecar shape)
 *   gap     = { start, end, reason }
 * Times are ABSOLUTE seconds in the recording. An older result may carry only
 * `text`/`transcript`: it renders as plain paragraphs without timestamps (and,
 * when the duration is known, subtitles with proportionally spread timing).
 *
 * Output conventions (Spanish, user-facing):
 *   - Timestamps are [hh:mm:ss] when the recording lasts ≥ 1 h, else [mm:ss].
 *   - A paragraph is «[hh:mm:ss] Hablante N: texto»; the label is omitted when
 *     the transcript has no speaker information (see `speakerLabels`).
 *   - An untranscribed stretch renders «[01:20:00–01:30:00 · tramo sin
 *     transcribir]» in its chronological place.
 *   - LOW-CONFIDENCE MARKER: a segment whose confidence is < 0.4 is followed by
 *     « [?]» in TXT and Markdown. The header and the DOCX note explain it
 *     («[?] marca fragmentos de baja confianza…»). Subtitles (SRT/VTT) never
 *     carry the marker: on-screen text follows subtitle norms.
 *   - HALLUCINATION CLEANUP (`cleanSegments`): removes engine credits
 *     («Subtítulos realizados por la comunidad de Amara.org»), isolated
 *     sign-offs («Gracias por ver», «Suscríbete», «Thank you for watching»), a
 *     lone «¡Gracias!» stretched over a mostly silent segment, silence tokens
 *     ([BLANK_AUDIO]), runs of ≥ 3 identical consecutive segments (and 2- or
 *     3-segment cycles repeated ≥ 3 times), and in-segment n-gram loops. A
 *     phrase said twice is never touched. Every removal is counted.
 */

const DEFAULT_PAUSE_SEC = 1.5;
const DEFAULT_PARAGRAPH_SEC = 75;
const LOW_CONFIDENCE_THRESHOLD = 0.4;
const LOW_CONFIDENCE_MARK = '[?]';
const HOUR = 3600;

const SUBTITLE = Object.freeze({
  maxLineChars: 42,
  maxLines: 2,
  maxCueMs: 7000,
  minCueMs: 700,
});

const DEFAULT_TIME_ZONE = 'America/Lima';
const RULE = '═'.repeat(48);

// ── small helpers ───────────────────────────────────────────────────────────

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Length in code points («é» and emoji count as one). */
function charLen(text) {
  return Array.from(String(text)).length;
}

/** Lowercase, accent-free, punctuation-free key for comparisons. */
function foldKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function groupThousands(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const s = String(v);
  // Spanish (CLDR «es»): four-digit numbers are not grouped.
  if (s.length < 5) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ── time formatting ─────────────────────────────────────────────────────────

/**
 * 83 → "01:23" · with `longForm` (recording ≥ 1 h) → "00:01:23". A time past
 * the hour is always "hh:mm:ss". Seconds are floored by default ('ceil' for
 * the end of a stretch) so a stamp never points after the words begin.
 */
function formatClock(seconds, longForm, rounding = 'floor') {
  const raw = Math.max(0, Number(seconds) || 0);
  const total = rounding === 'ceil' ? Math.ceil(raw - 1e-6) : rounding === 'round' ? Math.round(raw) : Math.floor(raw + 1e-6);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / HOUR);
  if (longForm || h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/** 10805 → "3 h 00 min 05 s" · 2712 → "45 min 12 s" · 52 → "52 s". */
function formatDurationHuman(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / HOUR);
  const m = Math.floor((total % HOUR) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${pad2(m)} min ${pad2(s)} s`;
  if (m > 0) return `${m} min ${pad2(s)} s`;
  return `${s} s`;
}

function formatPercent(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (r >= 0.9995) return '100 %';
  const pct = Math.floor(r * 1000 + 1e-6) / 10; // never round up into a better number
  return `${String(pct.toFixed(1)).replace('.', ',').replace(/,0$/, '')} %`;
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function formatDateEs(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  let parts = null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  } catch (_) {
    parts = null;
  }
  const y = parts ? Number(parts.year) : date.getUTCFullYear();
  const mo = parts ? Number(parts.month) - 1 : date.getUTCMonth();
  const d = parts ? Number(parts.day) : date.getUTCDate();
  return `${d} de ${MONTHS_ES[mo]} de ${y}`;
}

// ── language / engine labels ────────────────────────────────────────────────

const LANGUAGE_NAMES_ES = Object.freeze({
  es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán',
  qu: 'quechua', ay: 'aimara', gn: 'guaraní', ca: 'catalán', gl: 'gallego', eu: 'euskera',
  nl: 'neerlandés', ru: 'ruso', uk: 'ucraniano', pl: 'polaco', tr: 'turco', ar: 'árabe',
  he: 'hebreo', hi: 'hindi', zh: 'chino', ja: 'japonés', ko: 'coreano', sv: 'sueco',
  no: 'noruego', da: 'danés', fi: 'finés', el: 'griego', cs: 'checo', ro: 'rumano',
  hu: 'húngaro', vi: 'vietnamita', th: 'tailandés', id: 'indonesio', ms: 'malayo',
  fa: 'persa', bg: 'búlgaro', hr: 'croata', sr: 'serbio', sk: 'eslovaco', sl: 'esloveno',
  lt: 'lituano', lv: 'letón', et: 'estonio', la: 'latín', tl: 'tagalo', sw: 'suajili',
});

// Whisper's verbose_json reports the language by English name.
const LANGUAGE_BY_NAME = Object.freeze({
  spanish: 'es', castilian: 'es', english: 'en', portuguese: 'pt', french: 'fr', italian: 'it',
  german: 'de', quechua: 'qu', aymara: 'ay', guarani: 'gn', catalan: 'ca', galician: 'gl',
  basque: 'eu', dutch: 'nl', russian: 'ru', ukrainian: 'uk', polish: 'pl', turkish: 'tr',
  arabic: 'ar', hebrew: 'he', hindi: 'hi', chinese: 'zh', mandarin: 'zh', japanese: 'ja',
  korean: 'ko', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
  czech: 'cs', romanian: 'ro', hungarian: 'hu', vietnamese: 'vi', thai: 'th', indonesian: 'id',
  malay: 'ms', persian: 'fa', latin: 'la', tagalog: 'tl', swahili: 'sw',
  espanol: 'es', ingles: 'en', portugues: 'pt', frances: 'fr', aleman: 'de',
});

/** "es" / "es-PE" / "spanish" / "Español" → "es"; unknown → null. */
function languageCode(value) {
  const raw = foldKey(value).replace(/\s+/g, '-');
  if (!raw || raw === 'auto' || raw === 'detect') return null;
  if (LANGUAGE_BY_NAME[raw]) return LANGUAGE_BY_NAME[raw];
  const m = /^([a-z]{2,3})(?:-[a-z0-9]{2,8})*$/.exec(raw);
  return m ? m[1] : null;
}

/** "es" → "español", "en" → "inglés"; unknown codes fall back to Intl. */
function languageNameEs(value) {
  const code = languageCode(value);
  if (!code) {
    const raw = String(value || '').trim();
    return raw && !/^(?:auto|detect|unknown|und)$/i.test(raw) ? raw.slice(0, 40) : 'no detectado';
  }
  if (LANGUAGE_NAMES_ES[code]) return LANGUAGE_NAMES_ES[code];
  try {
    const name = new Intl.DisplayNames(['es'], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code) return name.toLowerCase();
  } catch (_) { /* small-icu builds */ }
  return code;
}

const PROVIDER_LABELS = Object.freeze({
  openai: 'OpenAI', groq: 'Groq', xai: 'xAI', elevenlabs: 'ElevenLabs', meta: 'Meta',
  voicestudio: 'VoiceStudio', deepgram: 'Deepgram', assemblyai: 'AssemblyAI', gemini: 'Gemini',
  local: 'Whisper local', 'local-whisper': 'Whisper local', whisper: 'Whisper', 'whisper-cpp': 'Whisper local',
  'faster-whisper': 'Whisper local',
});

function providerLabel(name) {
  const key = String(name || '').trim().toLowerCase();
  return PROVIDER_LABELS[key] || String(name || '').trim().slice(0, 40);
}

const ENGINE_LABELS = Object.freeze({
  cloud: 'en la nube',
  local: 'local (Whisper en el servidor)',
  mixed: 'mixto (nube y local)',
});

function engineLabel(engine, providers) {
  const base = ENGINE_LABELS[engine] || '';
  const list = Object.entries(isPlainObject(providers) ? providers : {})
    .filter(([name, count]) => name && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([name, count]) => `${providerLabel(name)} (${count} ${Number(count) === 1 ? 'tramo' : 'tramos'})`);
  if (base && list.length) return `${base} — ${list.join(', ')}`;
  return base || list.join(', ') || 'no informado';
}

const GAP_REASONS_ES = Object.freeze({
  provider_failed: 'el motor no respondió',
  provider_error: 'el motor no respondió',
  all_providers_failed: 'ningún motor pudo transcribirlo',
  timeout: 'tiempo agotado',
  rate_limited: 'límite de uso del proveedor',
  quota_exhausted: 'sin saldo en el proveedor',
  local_unavailable: 'motor local no disponible',
  decode_failed: 'audio ilegible',
  corrupt_audio: 'audio dañado',
  no_speech: 'sin voz detectada',
  aborted: 'cancelado',
});

function gapReasonEs(reason) {
  const key = String(reason || '').trim().toLowerCase();
  return GAP_REASONS_ES[key] || '';
}

// ── normalization ───────────────────────────────────────────────────────────

function normalizeConfidence(value) {
  const n = num(value);
  if (n == null || n < 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

function normalizeSpeaker(value) {
  if (value == null || value === false) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 80) : null;
}

/** One raw segment (engine or sidecar shape) → { start, end, text, speaker?, confidence? }. */
function normalizeSegment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const textValue = raw.text != null ? raw.text : raw.t;
  const text = String(textValue == null ? '' : textValue).normalize('NFC').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  const start = Math.max(0, num(raw.start != null ? raw.start : raw.s) || 0);
  let end = num(raw.end != null ? raw.end : raw.e);
  if (end == null || end < start) end = start;
  const seg = { start, end, text };
  const speaker = normalizeSpeaker(raw.speaker != null ? raw.speaker : raw.spk);
  if (speaker) seg.speaker = speaker;
  const confidence = normalizeConfidence(raw.confidence != null ? raw.confidence : raw.conf);
  if (confidence != null) seg.confidence = confidence;
  return seg;
}

function normalizeSegmentList(segments) {
  const list = [];
  for (const raw of Array.isArray(segments) ? segments : []) {
    const seg = normalizeSegment(raw);
    if (seg) list.push(seg);
  }
  // Stable: equal starts keep provider order.
  return list.sort((a, b) => a.start - b.start);
}

/** Sorted, merged, positive-length gaps. */
function normalizeGaps(gaps) {
  const list = [];
  for (const raw of Array.isArray(gaps) ? gaps : []) {
    if (!raw || typeof raw !== 'object') continue;
    const start = num(raw.start != null ? raw.start : raw.s);
    const end = num(raw.end != null ? raw.end : raw.e);
    if (start == null || end == null || end <= start || start < 0) continue;
    const reason = raw.reason == null ? '' : String(raw.reason).slice(0, 60);
    list.push({ start, end, reason });
  }
  list.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const gap of list) {
    const last = merged[merged.length - 1];
    if (last && gap.start <= last.end + 0.5) {
      last.end = Math.max(last.end, gap.end);
      if (!last.reason) last.reason = gap.reason;
    } else {
      merged.push({ ...gap });
    }
  }
  return merged;
}

function normalizeProviders(providers) {
  const out = {};
  if (!isPlainObject(providers)) return out;
  for (const [name, count] of Object.entries(providers)) {
    const n = num(count);
    const key = String(name || '').trim().slice(0, 40);
    if (key && n != null && n > 0) out[key] = Math.round(n);
  }
  return out;
}

const ENGINE_HEADER_RE = /^\s*Transcripci[oó]n(?: local)? — \d+ caracteres[^\n]*\n-{3}\n/;

/** The engine's text field prepends a technical header; the transcript never does. */
function stripEngineHeader(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(ENGINE_HEADER_RE, '').trim();
}

function normalizeCoverage(value) {
  const n = num(value);
  if (n == null || n < 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

function sumGapSeconds(gaps, from = 0, to = Infinity) {
  let total = 0;
  for (const gap of gaps) {
    const s = Math.max(gap.start, from);
    const e = Math.min(gap.end, to);
    if (e > s) total += e - s;
  }
  return total;
}

/**
 * Engine result | sidecar | string → one canonical shape the renderers share.
 * Never throws; a failed result (ok:false) normalizes to an empty transcript.
 */
function normalizeTranscriptResult(result) {
  const r = typeof result === 'string' ? { text: result } : (isPlainObject(result) ? result : {});
  const failed = r.ok === false;
  const segments = failed ? [] : normalizeSegmentList(r.segments);
  const gaps = normalizeGaps(r.gaps);
  const synthetic = r.synthetic === true;
  const range = isPlainObject(r.range) ? { start: num(r.range.start), end: num(r.range.end) } : null;
  // A time window (sliceResult) with no speech is still a timed transcript.
  const legacy = synthetic || (segments.length === 0 && !range);
  let text = '';
  if (!failed && legacy) {
    const own = r.transcript != null ? r.transcript : r.text;
    text = stripEngineHeader(own != null && String(own).trim() ? own : segments.map((s) => s.text).join('\n\n'));
  }
  let lastEnd = 0;
  for (const s of segments) lastEnd = Math.max(lastEnd, s.end, s.start);
  for (const g of gaps) lastEnd = Math.max(lastEnd, g.end);
  const declared = num(r.durationSec);
  const durationSec = declared && declared > 0 ? declared : (lastEnd > 0 ? lastEnd : null);
  const providers = normalizeProviders(r.providers);
  let engine = ['cloud', 'local', 'mixed'].includes(r.engine) ? r.engine : null;
  if (!engine && r.method) engine = String(r.method) === 'local-whisper' ? 'local' : (String(r.method) === 'placeholder' ? null : 'cloud');
  let coverage = normalizeCoverage(r.coverage);
  if (coverage == null && !legacy && durationSec) {
    coverage = Math.max(0, Math.min(1, 1 - sumGapSeconds(gaps) / durationSec));
  }
  return {
    segments,
    gaps,
    legacy,
    synthetic,
    text,
    durationSec,
    language: r.language ? String(r.language).trim().slice(0, 32) : null,
    providers,
    engine,
    coverage,
    partial: r.partial === true || gaps.length > 0,
    createdAt: r.createdAt || null,
    fileName: r.fileName || null,
    range,
    failed,
  };
}

// ── hallucination / repetition cleanup ──────────────────────────────────────

// Whole-segment silence markers (never speech). Music/applause annotations stay.
const SILENCE_TOKEN_RE = /(?:\[\s*(?:blank[_ ]audio|no[_ ]speech|silence|silencio|silent)\s*\]|\(\s*(?:blank[_ ]audio|no[_ ]speech|silence|silencio|silent)\s*\)|<\|\s*nospeech\s*\|>)/gi;

// Isolated sign-offs Whisper invents over silence (matched on the FULL folded segment).
const ISOLATED_HALLUCINATIONS = [
  /^(?:(?:muchas|mil) )?gracias por (?:ver|mirar|vernos|su atencion y por ver)(?: (?:el|este|mi|nuestro) (?:video|canal|programa))?(?: y (?:no olvides|recuerda) suscribirte(?: (?:al|a mi|a nuestro) canal)?)?$/,
  /^(?:no olvides |recuerda |por favor )?(?:dale (?:like|me gusta|un like) y )?(?:suscribete|suscribanse|suscribirte)(?: (?:al|a mi|a nuestro|en el) canal)?(?: y (?:dale|activa) (?:like|me gusta|la campanita|un like))?$/,
  /^(?:thank you|thanks) (?:so much |very much )?for watching(?: (?:the|this|my) video)?(?: and (?:please )?subscribe)?$/,
  /^(?:please )?(?:like and )?subscribe(?: to (?:my|the|our) channel)?$/,
  /^(?:subtitulos?|subtitulado|subtitles?)(?: (?:realizados|hechos|creados|by|por))?(?: por)?(?: la comunidad de| the)? amara org(?: community)?$/,
];

const LONE_THANKS_RE = /^(?:(?:muchas|mil) )?gracias(?: a todos)?$|^(?:thank you|thanks)(?: so much| very much)?$/;
const LONE_THANKS_SILENT_SEC = 3;

const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+/;

/** Remove engine credits (Amara.org …) anywhere in the text, sentence by sentence. */
function stripCredits(text) {
  if (!/amara/i.test(text)) return { text, removed: false };
  const kept = String(text).split(SENTENCE_SPLIT_RE).filter((sentence) => !/\bamara\s*\.?\s*org\b/i.test(sentence));
  const next = kept.join(' ').trim();
  return { text: next, removed: next !== text };
}

function isIsolatedHallucination(seg) {
  const key = foldKey(seg.text);
  if (!key) return false;
  if (ISOLATED_HALLUCINATIONS.some((re) => re.test(key))) return true;
  if (LONE_THANKS_RE.test(key)) {
    const duration = seg.end - seg.start;
    if (duration >= LONE_THANKS_SILENT_SEC) return true;
    if (seg.confidence != null && seg.confidence < 0.5) return true;
  }
  return false;
}

function loopThreshold(n) {
  if (n === 1) return 6;
  if (n <= 3) return 4;
  return 3;
}

const MAX_LOOP_NGRAM = 12;

/**
 * Collapse in-segment n-gram loops to one instance. Thresholds keep human
 * repetition: a single word needs ≥ 6 repeats, 2-3 words ≥ 4, 4+ words ≥ 3
 * («muy bien, muy bien» or «no, no, no» stay).
 */
function collapseNgramLoops(text) {
  const tokens = String(text).split(' ').filter(Boolean);
  if (tokens.length < 6) return { text, loops: 0 };
  const keys = tokens.map((t) => foldKey(t));
  const out = [];
  let loops = 0;
  let i = 0;
  while (i < tokens.length) {
    let best = null;
    for (let n = 1; n <= MAX_LOOP_NGRAM && i + 2 * n <= tokens.length; n++) {
      let allEmpty = true;
      for (let k = 0; k < n; k++) if (keys[i + k]) { allEmpty = false; break; }
      if (allEmpty) continue;
      let reps = 1;
      while (i + (reps + 1) * n <= tokens.length) {
        let same = true;
        for (let k = 0; k < n; k++) {
          if (keys[i + k] !== keys[i + reps * n + k]) { same = false; break; }
        }
        if (!same) break;
        reps++;
      }
      if (reps >= loopThreshold(n) && (!best || reps * n > best.reps * best.n)) best = { n, reps };
    }
    if (best) {
      const instance = tokens.slice(i, i + best.n);
      const loopLast = tokens[i + best.reps * best.n - 1];
      const tail = /[.!?…]+["»”)]*$/.exec(loopLast);
      const lastIdx = instance.length - 1;
      instance[lastIdx] = instance[lastIdx].replace(/[,;:]+$/, '') + (tail && !/[.!?…]["»”)]*$/.test(instance[lastIdx]) ? tail[0] : '');
      out.push(...instance);
      i += best.reps * best.n;
      loops++;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return { text: loops ? out.join(' ') : text, loops };
}

/**
 * Collapse consecutive repeated segments: a run of ≥ 3 identical segments, or a
 * 2-/3-segment cycle repeated ≥ 3 times, keeps its first occurrence. Two
 * identical segments in a row are legitimate speech and are kept.
 */
function collapseRepeatedSegments(list) {
  const out = [];
  let removed = 0;
  let i = 0;
  const keys = list.map((s) => foldKey(s.text));
  while (i < list.length) {
    let best = null;
    for (let p = 1; p <= 3 && i + 3 * p <= list.length; p++) {
      if (p > 1) {
        // A cycle must be made of distinct texts, or it is a p=1 run.
        const cycle = keys.slice(i, i + p);
        if (new Set(cycle).size < p) continue;
      }
      let reps = 1;
      while (i + (reps + 1) * p <= list.length) {
        let same = true;
        for (let k = 0; k < p; k++) {
          if (keys[i + k] !== keys[i + reps * p + k]) { same = false; break; }
        }
        if (!same) break;
        reps++;
      }
      if (reps >= 3 && (!best || reps * p > best.reps * best.p)) best = { p, reps };
    }
    if (best) {
      out.push(...list.slice(i, i + best.p));
      removed += (best.reps - 1) * best.p;
      i += best.reps * best.p;
    } else {
      out.push(list[i]);
      i++;
    }
  }
  return { list: out, removed };
}

function emptyCleanupStats() {
  return { input: 0, kept: 0, empty: 0, hallucinations: 0, repeats: 0, loops: 0, removed: 0 };
}

/**
 * Clean segments and report what was removed.
 * @returns {{ segments: Array<{start,end,text,speaker?,confidence?}>, cleanup: {input,kept,empty,hallucinations,repeats,loops,removed} }}
 * Counters: `empty` = blank/silence-only segments dropped; `hallucinations` =
 * invented fragments removed (a whole segment, or an engine credit inside a
 * kept one); `repeats` = repeated segments collapsed away; `loops` = in-segment
 * loops collapsed (the segment itself is kept); `removed` = input − kept.
 */
function cleanSegmentsDetailed(segments) {
  const stats = emptyCleanupStats();
  const normalized = normalizeSegmentList(segments);
  stats.input = normalized.length;
  const stage = [];
  for (const seg of normalized) {
    let text = seg.text;
    text = text.replace(SILENCE_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
    const credits = stripCredits(text);
    text = credits.text;
    if (!text) {
      if (credits.removed) stats.hallucinations++;
      else stats.empty++;
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(text)) { stats.empty++; continue; }
    if (credits.removed) stats.hallucinations++;
    const candidate = { ...seg, text };
    if (isIsolatedHallucination(candidate)) { stats.hallucinations++; continue; }
    const looped = collapseNgramLoops(text);
    if (looped.loops) stats.loops += looped.loops;
    candidate.text = looped.text;
    stage.push(candidate);
  }
  const collapsed = collapseRepeatedSegments(stage);
  stats.repeats = collapsed.removed;
  stats.kept = collapsed.list.length;
  stats.removed = stats.input - stats.kept;
  return { segments: collapsed.list, cleanup: stats };
}

/** Cleaned segments (see cleanSegmentsDetailed for the counters). */
function cleanSegments(segments) {
  return cleanSegmentsDetailed(segments).segments;
}

// ── speakers ────────────────────────────────────────────────────────────────

const GENERIC_SPEAKER_RE = /^(?:(?:spk|speaker|spkr|hablante|locutor|voz|voice|persona|participante|s)[\s_-]*)?0*(\d{1,3})$/i;

function isGenericSpeaker(value) {
  const s = String(value || '').trim();
  return GENERIC_SPEAKER_RE.test(s) || /^[A-Z]$/.test(s);
}

/**
 * Raw speaker id → display label, in order of first appearance («Hablante 1»,
 * «Hablante 2»…). A real name (a renamed speaker) is kept as is.
 * `show` is false when there is nothing to tell apart: no speakers, or a single
 * generic speaker.
 */
function speakerLabels(segments) {
  const labels = new Map();
  let generic = 0;
  let named = false;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const id = seg && seg.speaker;
    if (!id || labels.has(id)) continue;
    if (isGenericSpeaker(id)) {
      generic++;
      labels.set(id, `Hablante ${generic}`);
    } else {
      named = true;
      labels.set(id, String(id));
    }
  }
  return { labels, count: labels.size, show: labels.size >= 2 || named };
}

// ── paragraphs ──────────────────────────────────────────────────────────────

const SENTENCE_END_RE = /[.!?…]["»”')\]]*$/;

/**
 * Group segments into readable paragraphs. A new paragraph starts on a pause ≥
 * `pauseSec` (1.5 s), a speaker change, an untranscribed gap or a forced break
 * time (`breakAt`, e.g. chapter starts), at a sentence end once the paragraph
 * reaches 80 % of `maxSec` (~60 s of 75 s), and unconditionally at 120 % (~90 s).
 * Segments are used as given (call cleanSegments first).
 * @returns {Array<{start,end,speaker,text,segmentCount,lowConfidence}>}
 */
function buildParagraphs(segments, { pauseSec = DEFAULT_PAUSE_SEC, maxSec = DEFAULT_PARAGRAPH_SEC, breakAt = [], gaps = [], lowConfidenceMark = true } = {}) {
  const list = normalizeSegmentList(segments).filter((s) => s.text);
  const softSec = maxSec * 0.8;
  const hardSec = maxSec * 1.2;
  const breaks = (Array.isArray(breakAt) ? breakAt : []).map(num).filter((n) => n != null).sort((a, b) => a - b);
  const gapStarts = normalizeGaps(gaps).map((g) => g.start);
  const paragraphs = [];
  let current = null;
  let prev = null;
  let breakIdx = 0;
  let gapIdx = 0;
  for (const seg of list) {
    let split = !current;
    if (current) {
      if (seg.start - prev.end >= pauseSec) split = true;
      if ((seg.speaker || null) !== (current.speaker || null)) split = true;
      const length = seg.start - current.start;
      if (length >= hardSec) split = true;
      else if (length >= softSec && SENTENCE_END_RE.test(prev.text)) split = true;
    }
    while (breakIdx < breaks.length && breaks[breakIdx] <= seg.start + 0.5) {
      if (current && breaks[breakIdx] > current.start + 0.5) split = true;
      breakIdx++;
    }
    while (gapIdx < gapStarts.length && gapStarts[gapIdx] <= seg.start) {
      if (current) split = true;
      gapIdx++;
    }
    const low = lowConfidenceMark && seg.confidence != null && seg.confidence < LOW_CONFIDENCE_THRESHOLD;
    const piece = low ? `${seg.text} ${LOW_CONFIDENCE_MARK}` : seg.text;
    if (split) {
      current = { start: seg.start, end: seg.end, speaker: seg.speaker || null, text: piece, segmentCount: 1, lowConfidence: low ? 1 : 0 };
      paragraphs.push(current);
    } else {
      current.text += ` ${piece}`;
      current.end = Math.max(current.end, seg.end);
      current.segmentCount++;
      if (low) current.lowConfidence++;
    }
    prev = seg;
  }
  return paragraphs;
}

/** Legacy plain text → readable paragraphs (~600-900 chars at sentence ends). */
function plainTextParagraphs(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    if (block.length <= 1200) { out.push(block); continue; }
    const sentences = block.split(SENTENCE_SPLIT_RE);
    let buf = '';
    for (const sentence of sentences) {
      if (buf && buf.length + sentence.length + 1 > 900 && buf.length >= 400) {
        out.push(buf);
        buf = sentence;
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
      if (buf.length > 1500) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
  }
  return out;
}

// ── shared preparation ──────────────────────────────────────────────────────

function prepare(result, opts = {}) {
  const meta = normalizeTranscriptResult(result);
  const { segments: cleaned, cleanup } = meta.legacy ? { segments: [], cleanup: emptyCleanupStats() } : cleanSegmentsDetailed(meta.segments);
  let effectiveDuration = meta.durationSec || 0;
  for (const s of cleaned) effectiveDuration = Math.max(effectiveDuration, s.end);
  const longForm = effectiveDuration >= HOUR;
  const speakers = speakerLabels(cleaned);
  const chapters = normalizeChapters(opts.chapters);
  const paragraphs = meta.legacy ? [] : buildParagraphs(cleaned, {
    pauseSec: opts.pauseSec != null ? opts.pauseSec : DEFAULT_PAUSE_SEC,
    maxSec: opts.maxSec != null ? opts.maxSec : DEFAULT_PARAGRAPH_SEC,
    breakAt: chapters.map((c) => c.start),
    gaps: meta.gaps,
  });
  const words = meta.legacy
    ? countWords(meta.text)
    : cleaned.reduce((acc, s) => acc + countWords(s.text), 0);
  const lowConfidence = cleaned.filter((s) => s.confidence != null && s.confidence < LOW_CONFIDENCE_THRESHOLD).length;
  return { meta, cleaned, cleanup, longForm, speakers, chapters, paragraphs, words, lowConfidence, opts };
}

function normalizeChapters(chapters) {
  const out = [];
  for (const raw of Array.isArray(chapters) ? chapters : []) {
    if (!raw || typeof raw !== 'object') continue;
    const start = num(raw.start != null ? raw.start : raw.s);
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (start == null || start < 0 || !title) continue;
    out.push({ start, title });
  }
  return out.sort((a, b) => a.start - b.start);
}

function gapMarker(gap, longForm) {
  return `[${formatClock(gap.start, longForm)}–${formatClock(gap.end, longForm, 'ceil')} · tramo sin transcribir]`;
}

function displayName(fileName) {
  const raw = String(fileName || '').replace(/[\r\n\t]+/g, ' ').trim();
  const base = raw.split(/[\\/]/).pop() || '';
  return base.slice(0, 160);
}

/** Header fields shared by TXT and Markdown, as [label, value] pairs. */
function headerFields(prep, { fileName, now, timeZone } = {}) {
  const { meta, longForm } = prep;
  const fields = [];
  const name = displayName(fileName || meta.fileName);
  if (name) fields.push(['Archivo', name]);
  if (meta.durationSec) fields.push(['Duración', formatDurationHuman(meta.durationSec)]);
  if (meta.range && meta.range.start != null) {
    const rangeEnd = meta.range.end != null ? formatClock(meta.range.end, longForm, 'ceil') : 'final';
    fields.push(['Tramo', `${formatClock(meta.range.start, longForm)}–${rangeEnd}`]);
  }
  fields.push(['Idioma', languageNameEs(meta.language)]);
  fields.push(['Motor', engineLabel(meta.engine, meta.providers)]);
  const dateSource = now || meta.createdAt || new Date();
  const date = formatDateEs(dateSource, timeZone || DEFAULT_TIME_ZONE);
  if (date) fields.push(['Fecha', date]);
  fields.push(['Palabras', groupThousands(prep.words)]);
  if (meta.coverage != null) fields.push(['Cobertura', meta.legacy ? formatPercent(meta.coverage) : `${formatPercent(meta.coverage)} del audio`]);
  if (!meta.legacy || meta.gaps.length) {
    const gaps = meta.gaps.map((g) => {
      const reason = gapReasonEs(g.reason);
      return `${formatClock(g.start, longForm)}–${formatClock(g.end, longForm, 'ceil')}${reason ? ` (${reason})` : ''}`;
    });
    fields.push(['Tramos sin transcribir', gaps.length ? gaps.join('; ') : 'ninguno']);
  }
  if (prep.speakers.show) fields.push(['Hablantes', String(prep.speakers.count)]);
  return fields;
}

function headerNotes(prep) {
  const notes = [];
  if (prep.lowConfidence > 0) {
    notes.push(`${LOW_CONFIDENCE_MARK} marca fragmentos de baja confianza; conviene verificarlos con el audio.`);
  }
  const dropped = prep.cleanup.hallucinations + prep.cleanup.repeats + prep.cleanup.loops;
  if (dropped > 0) {
    notes.push(`Se ${dropped === 1 ? 'omitió 1 fragmento repetido o inventado' : `omitieron ${dropped} fragmentos repetidos o inventados`} por el motor en silencios.`);
  }
  if (prep.meta.legacy && !prep.meta.failed && prep.meta.text) {
    notes.push('Esta transcripción no tiene marcas de tiempo.');
  }
  return notes;
}

// ── TXT ─────────────────────────────────────────────────────────────────────

/** Paragraphs and gap markers in chronological order. */
function bodyItems(prep) {
  const items = [];
  const gaps = prep.meta.gaps.slice();
  let g = 0;
  for (const p of prep.paragraphs) {
    while (g < gaps.length && gaps[g].start <= p.start) items.push({ type: 'gap', gap: gaps[g++] });
    items.push({ type: 'paragraph', paragraph: p });
  }
  while (g < gaps.length) items.push({ type: 'gap', gap: gaps[g++] });
  return items;
}

function emptyBodyNote(prep) {
  return prep.meta.range ? '(Sin voz transcrita en este tramo.)' : '(Sin voz transcrita.)';
}

function paragraphLine(p, prep) {
  const label = prep.speakers.show && p.speaker ? prep.speakers.labels.get(p.speaker) : null;
  return `[${formatClock(p.start, prep.longForm)}] ${label ? `${label}: ` : ''}${p.text}`;
}

function renderTextFromPrep(prep, { fileName, header = true, now, timeZone } = {}) {
  const lines = [];
  if (header) {
    lines.push('TRANSCRIPCIÓN', RULE);
    for (const [label, value] of headerFields(prep, { fileName, now, timeZone })) lines.push(`${label}: ${value}`);
    if (prep.chapters.length && !prep.meta.legacy) {
      lines.push('', 'Índice:');
      prep.chapters.forEach((c, idx) => lines.push(`  ${idx + 1}. ${formatClock(c.start, prep.longForm)}  ${c.title}`));
    }
    const notes = headerNotes(prep);
    if (notes.length) {
      lines.push('');
      for (const note of notes) lines.push(`Nota: ${note}`);
    }
    lines.push(RULE);
  }
  const body = [];
  if (prep.meta.legacy) {
    body.push(...plainTextParagraphs(prep.meta.text));
  } else {
    for (const item of bodyItems(prep)) {
      body.push(item.type === 'gap' ? gapMarker(item.gap, prep.longForm) : paragraphLine(item.paragraph, prep));
    }
  }
  if (header && !body.length && !prep.meta.failed && !prep.meta.legacy) body.push(emptyBodyNote(prep));
  const head = lines.length ? `${lines.join('\n')}\n` : '';
  if (!body.length) return head;
  return `${head}${head ? '\n' : ''}${body.join('\n\n')}\n`;
}

/**
 * Readable transcript. With `header` (default true) it opens with the metadata
 * block; without it, the body alone («[hh:mm:ss] Hablante N: texto»
 * paragraphs and gap markers) — the form meant for File.extractedText / RAG.
 */
function renderText(result, { fileName, header = true, now, timeZone, chapters, pauseSec, maxSec } = {}) {
  return renderTextFromPrep(prepare(result, { chapters, pauseSec, maxSec }), { fileName, header, now, timeZone });
}

// ── subtitles ───────────────────────────────────────────────────────────────

/** Best ≤ 2-line wrap of a cue text, balanced; null when it does not fit. */
function wrapCue(text, maxChars = SUBTITLE.maxLineChars) {
  const t = String(text).trim();
  if (charLen(t) <= maxChars) return [t];
  const words = t.split(' ');
  let best = null;
  let left = '';
  for (let k = 1; k < words.length; k++) {
    left = left ? `${left} ${words[k - 1]}` : words[k - 1];
    const right = words.slice(k).join(' ');
    const l1 = charLen(left);
    const l2 = charLen(right);
    if (l1 > maxChars) break;
    if (l2 > maxChars) continue;
    // Balanced lines; a clause break (after , ; :) earns a small bonus.
    let score = Math.abs(l1 - l2);
    if (/[,;:.!?…]$/.test(left)) score -= 6;
    if (!best || score < best.score) best = { score, lines: [left, right] };
  }
  return best ? best.lines : null;
}

function fitsCue(text) {
  return wrapCue(text) !== null;
}

function splitLongWord(word, max) {
  const chars = Array.from(word);
  const out = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  return out;
}

/** Fill each cue as far as two lines allow (the minimum number of cues). */
function greedyCueChunks(tokens) {
  const chunks = [];
  let cur = [];
  for (const tok of tokens) {
    const candidate = cur.length ? `${cur.join(' ')} ${tok}` : tok;
    if (cur.length && !fitsCue(candidate)) {
      chunks.push(cur);
      cur = [tok];
    } else {
      cur.push(tok);
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const CLAUSE_END_RE = /[,;:]["»”')\]]*$/;

/**
 * Split tokens into `n` cues of similar length, snapping each cut to a nearby
 * sentence end (or clause end) so a cue reads as a unit. A cue that would not
 * fit two lines is split further.
 */
function balancedCueChunks(tokens, n) {
  if (n <= 1 || tokens.length <= 1) return [tokens];
  const cum = [];
  let acc = 0;
  for (let k = 0; k < tokens.length; k++) {
    acc += charLen(tokens[k]) + (k ? 1 : 0);
    cum.push(acc);
  }
  const total = acc;
  const avg = total / n;
  const cuts = [];
  let prevCut = 0;
  for (let c = 1; c < n; c++) {
    const target = (total * c) / n;
    const minIdx = prevCut + 1;
    const maxIdx = tokens.length - (n - c);
    let best = null;
    for (let b = minIdx; b <= maxIdx; b++) {
      const signed = (cum[b - 1] - target) / avg;
      if (signed > 0.4 && best) break; // cum only grows: nothing closer ahead
      const dist = Math.abs(signed);
      if (dist > 0.4 && best) continue;
      let score = dist;
      if (SENTENCE_END_RE.test(tokens[b - 1])) score -= 0.3;
      else if (CLAUSE_END_RE.test(tokens[b - 1])) score -= 0.15;
      if (!best || score < best.score) best = { b, score };
    }
    if (!best) break;
    cuts.push(best.b);
    prevCut = best.b;
  }
  const chunks = [];
  let from = 0;
  for (const cut of [...cuts, tokens.length]) {
    if (cut > from) chunks.push(tokens.slice(from, cut));
    from = cut;
  }
  const out = [];
  for (const chunk of chunks) {
    if (fitsCue(chunk.join(' '))) out.push(chunk);
    else out.push(...greedyCueChunks(chunk));
  }
  return out;
}

/** Segment text → cue texts that each fit 2 × 42 chars and ≤ 7 s of the segment. */
function splitSegmentForCues(text, durationMs) {
  const tokens = [];
  for (const w of String(text).split(' ').filter(Boolean)) {
    if (charLen(w) > SUBTITLE.maxLineChars) tokens.push(...splitLongWord(w, SUBTITLE.maxLineChars));
    else tokens.push(w);
  }
  if (!tokens.length) return [];
  const byChars = greedyCueChunks(tokens).length;
  const byTime = Math.min(tokens.length, Math.max(1, Math.ceil(durationMs / SUBTITLE.maxCueMs)));
  const n = Math.max(byChars, byTime);
  const chunks = n === 1 ? [tokens] : balancedCueChunks(tokens, n);
  return chunks.map((c) => c.join(' '));
}

function cueSafeSrt(text) {
  return String(text).replace(/-->/g, '→');
}

function cueSafeVtt(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build timed cues (integer ms) following subtitle norms: ≤ 42 chars × 2 lines,
 * 0.7 s ≤ duration ≤ 7 s, sequential and non-overlapping. Text is spread over
 * a segment proportionally to its length (no word timestamps are assumed).
 * `prefixTurns` (SRT) prepends «Hablante N: » to the first cue of each turn.
 */
function buildCues(prep, { prefixTurns = false } = {}) {
  const raw = [];
  const source = prep.meta.legacy
    ? (prep.meta.durationSec && prep.meta.text ? [{ start: 0, end: prep.meta.durationSec, text: prep.meta.text.replace(/\s+/g, ' ').trim() }] : [])
    : prep.cleaned;
  let prevSpeaker;
  for (const seg of source) {
    const label = prep.speakers.show && seg.speaker ? prep.speakers.labels.get(seg.speaker) : null;
    const turnStart = label && label !== prevSpeaker;
    prevSpeaker = label || null;
    const text = prefixTurns && turnStart ? `${label}: ${seg.text}` : seg.text;
    const startMs = Math.round(seg.start * 1000);
    const endMs = Math.max(startMs, Math.round(seg.end * 1000));
    const chunks = splitSegmentForCues(text, endMs - startMs);
    if (!chunks.length) continue;
    const weights = chunks.map((c) => charLen(c) + 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = startMs;
    let acc = 0;
    chunks.forEach((chunk, idx) => {
      acc += weights[idx];
      const boundary = idx === chunks.length - 1 ? endMs : startMs + Math.round(((endMs - startMs) * acc) / totalWeight);
      raw.push({ start: cursor, end: Math.max(cursor, boundary), text: chunk, voice: label });
      cursor = Math.max(cursor, boundary);
    });
  }
  return fixCueTimings(mergeShortCues(raw));
}

function mergeShortCues(cues) {
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = { ...cues[i] };
    if (cue.end - cue.start >= SUBTITLE.minCueMs) { out.push(cue); continue; }
    const prev = out[out.length - 1];
    const next = cues[i + 1];
    if (next && next.voice === cue.voice && fitsCue(`${cue.text} ${next.text}`) && next.end - cue.start <= SUBTITLE.maxCueMs) {
      cues[i + 1] = { ...next, start: cue.start, text: `${cue.text} ${next.text}` };
      continue;
    }
    if (prev && prev.voice === cue.voice && fitsCue(`${prev.text} ${cue.text}`) && cue.end - prev.start <= SUBTITLE.maxCueMs) {
      prev.text = `${prev.text} ${cue.text}`;
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    out.push(cue);
  }
  return out;
}

function fixCueTimings(cues) {
  let prevEnd = 0;
  for (const cue of cues) {
    if (cue.start < prevEnd) cue.start = prevEnd;
    if (cue.end > cue.start + SUBTITLE.maxCueMs) cue.end = cue.start + SUBTITLE.maxCueMs;
    if (cue.end - cue.start < SUBTITLE.minCueMs) cue.end = cue.start + SUBTITLE.minCueMs;
    prevEnd = cue.end;
  }
  return cues;
}

function msClock(ms, sep) {
  const total = Math.max(0, Math.round(ms));
  const milli = total % 1000;
  const secs = Math.floor(total / 1000);
  return `${pad2(Math.floor(secs / HOUR))}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}${sep}${String(milli).padStart(3, '0')}`;
}

function renderSrtFromPrep(prep) {
  const cues = buildCues(prep, { prefixTurns: true });
  if (!cues.length) return '';
  return `${cues.map((cue, idx) => [
    String(idx + 1),
    `${msClock(cue.start, ',')} --> ${msClock(cue.end, ',')}`,
    ...(wrapCue(cueSafeSrt(cue.text)) || [cueSafeSrt(cue.text)]),
  ].join('\n')).join('\n\n')}\n`;
}

function renderVttFromPrep(prep) {
  const cues = buildCues(prep, { prefixTurns: false });
  if (!cues.length) return '';
  const blocks = cues.map((cue) => {
    const lines = (wrapCue(cue.text) || [cue.text]).map(cueSafeVtt);
    if (cue.voice) lines[0] = `<v ${cue.voice.replace(/[<>&]/g, '').trim()}>${lines[0]}`;
    return [`${msClock(cue.start, '.')} --> ${msClock(cue.end, '.')}`, ...lines].join('\n');
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/**
 * SubRip. Accepts a segment list or a whole result. Empty string when there is
 * nothing timed to show (a legacy text-only result without a duration).
 */
function renderSrt(input) {
  const result = Array.isArray(input) ? { segments: input } : input;
  return renderSrtFromPrep(prepare(result));
}

/** WebVTT (with <v Hablante N> voice tags when speakers exist). */
function renderVtt(input) {
  const result = Array.isArray(input) ? { segments: input } : input;
  return renderVttFromPrep(prepare(result));
}

// ── Markdown (→ DOCX via document-service.createDocument) ───────────────────

/**
 * Escape what pandoc's markdown reader would treat as syntax (emphasis, links,
 * raw HTML, math, sub/superscript, headings, code). Production converts with
 * pandoc (backend/Dockerfile); the pure-JS fallback prints the backslashes, so
 * only characters that really are syntax are escaped: an underscore inside a
 * word («clase_final») is literal for pandoc and stays as is.
 */
function escapeMd(text) {
  const chars = Array.from(String(text));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '_') {
      const before = chars[i - 1] || '';
      const after = chars[i + 1] || '';
      out += /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after) ? '_' : '\\_';
    } else if ('\\`*[]<>$^~#'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Transcript text for the body: escaped, with the «[?]» marker kept literal. */
function escapeBody(text) {
  return escapeMd(text).split('\\[?\\]').join(LOW_CONFIDENCE_MARK);
}

/**
 * A paragraph that STARTS like a block construct (list item, numbered list,
 * table row) would change shape in pandoc and in document-service's table
 * pre-pass; escape that first character. Timestamped paragraphs start with
 * «**[» and never need it; legacy plain-text paragraphs might.
 */
function escapeBlockStart(text) {
  return String(text)
    .replace(/^([-+])(\s)/, '\\$1$2')
    .replace(/^(\d{1,9})([.)])(\s)/, '$1\\$2$3')
    .replace(/^\|/, '\\|');
}

/**
 * document-service rebuilds every line that starts with «|» as a table row by
 * splitting on «|» without honoring «\|», so a cell never carries a pipe.
 */
function mdTableRow(cells) {
  return `| ${cells.map((c) => escapeMd(String(c).replace(/\|/g, '/')).replace(/\n+/g, ' ')).join(' | ')} |`;
}

function renderMarkdownFromPrep(prep, { fileName, now, timeZone } = {}) {
  const name = displayName(fileName || prep.meta.fileName) || 'archivo';
  const out = [`# Transcripción — ${escapeMd(name)}`, ''];
  out.push('| Dato | Detalle |', '| --- | --- |');
  for (const [label, value] of headerFields(prep, { fileName, now, timeZone })) out.push(mdTableRow([label, value]));
  out.push('');
  if (prep.chapters.length && !prep.meta.legacy) {
    out.push('## Índice', '', '| N.º | Inicio | Capítulo |', '| --- | --- | --- |');
    prep.chapters.forEach((c, idx) => out.push(mdTableRow([String(idx + 1), formatClock(c.start, prep.longForm), c.title])));
    out.push('');
  }
  out.push('## Transcripción', '');
  if (prep.meta.legacy) {
    for (const p of plainTextParagraphs(prep.meta.text)) out.push(escapeBlockStart(escapeBody(p)), '');
  } else {
    let chapterIdx = 0;
    const items = bodyItems(prep);
    if (!items.length && !prep.meta.failed) out.push(`*${emptyBodyNote(prep)}*`, '');
    for (const item of items) {
      if (item.type === 'gap') {
        // «[a–b · …]» is literal for pandoc: no link definition can match it.
        out.push(`*${gapMarker(item.gap, prep.longForm)}*`, '');
        continue;
      }
      const p = item.paragraph;
      while (chapterIdx < prep.chapters.length && prep.chapters[chapterIdx].start <= p.start + 0.5) {
        out.push(`### ${escapeMd(prep.chapters[chapterIdx].title)}`, '');
        chapterIdx++;
      }
      const label = prep.speakers.show && p.speaker ? prep.speakers.labels.get(p.speaker) : null;
      const lead = `[${formatClock(p.start, prep.longForm)}]${label ? ` ${escapeMd(label)}:` : ''}`;
      out.push(`**${lead}** ${escapeBody(p.text)}`, '');
    }
  }
  const notes = headerNotes(prep);
  if (notes.length) {
    out.push('## Notas', '');
    for (const note of notes) out.push(`- ${escapeBody(note)}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Markdown for a Word document: title «Transcripción — <archivo>», a metadata
 * table, an optional chapter index (`chapters: [{start, title}]`, also used as
 * paragraph breaks and ### headings in the body) and the timestamped body.
 * Paragraphs are separated by blank lines so pandoc keeps one per paragraph.
 */
function renderMarkdown(result, { fileName, chapters, now, timeZone, pauseSec, maxSec } = {}) {
  return renderMarkdownFromPrep(prepare(result, { chapters, pauseSec, maxSec }), { fileName, now, timeZone });
}

// ── pack ────────────────────────────────────────────────────────────────────

const PACK_FORMATS = ['txt', 'srt', 'vtt', 'md'];

/**
 * Render every requested format from ONE preparation pass.
 * @returns {{ txt, srt, vtt, md, stats }} unrequested formats are null.
 * stats = { words, durationSec, language, languageName, coverage, speakers,
 *           segments, paragraphs, gaps, partial, legacy, lowConfidence, cleanup }
 */
function buildTranscriptPack(result, { fileName, formats = PACK_FORMATS, chapters, now, timeZone, pauseSec, maxSec } = {}) {
  const prep = prepare(result, { chapters, pauseSec, maxSec });
  const wanted = new Set((Array.isArray(formats) ? formats : PACK_FORMATS).map((f) => String(f).toLowerCase().replace(/^\./, '')));
  const opts = { fileName, now, timeZone };
  return {
    txt: wanted.has('txt') ? renderTextFromPrep(prep, { ...opts, header: true }) : null,
    srt: wanted.has('srt') ? renderSrtFromPrep(prep) : null,
    vtt: wanted.has('vtt') ? renderVttFromPrep(prep) : null,
    md: (wanted.has('md') || wanted.has('docx')) ? renderMarkdownFromPrep(prep, opts) : null,
    stats: {
      words: prep.words,
      durationSec: prep.meta.durationSec,
      language: languageCode(prep.meta.language) || prep.meta.language,
      languageName: languageNameEs(prep.meta.language),
      coverage: prep.meta.coverage,
      speakers: prep.speakers.count,
      segments: prep.cleaned.length,
      paragraphs: prep.paragraphs.length,
      gaps: prep.meta.gaps.length,
      partial: prep.meta.partial,
      legacy: prep.meta.legacy,
      lowConfidence: prep.lowConfidence,
      cleanup: prep.cleanup,
    },
  };
}

// ── time windows ────────────────────────────────────────────────────────────

/**
 * Segments that overlap [start, end): a segment ending exactly at `start` or
 * starting exactly at `end` is out. Segments keep their original (absolute)
 * times and shape. `start` defaults to 0, `end` to the end of the recording.
 */
function sliceSegments(segments, { start = 0, end = null } = {}) {
  const from = num(start) == null ? 0 : Math.max(0, num(start));
  const to = num(end) == null ? Infinity : num(end);
  return (Array.isArray(segments) ? segments : []).filter((raw) => {
    const seg = normalizeSegment(raw);
    if (!seg) return false;
    const segEnd = seg.end > seg.start ? seg.end : seg.start + 1e-6;
    return segEnd > from && seg.start < to;
  });
}

/**
 * A window of a whole result: sliced segments, gaps clipped to the window,
 * coverage recomputed for it, `range` set (renderers print it as «Tramo»).
 * Times stay absolute so citations match the full recording. Returns null for
 * a result without timestamps (legacy text-only): it cannot be cut by time.
 */
function sliceResult(result, { start = 0, end = null } = {}) {
  const meta = normalizeTranscriptResult(result);
  if (meta.legacy || meta.failed) return null;
  const from = num(start) == null ? 0 : Math.max(0, num(start));
  const to = num(end) == null ? null : num(end);
  const limit = to == null ? Infinity : to;
  const gaps = meta.gaps
    .filter((g) => g.end > from && g.start < limit)
    .map((g) => ({ start: Math.max(g.start, from), end: Math.min(g.end, limit), reason: g.reason }));
  const windowEnd = to == null ? (meta.durationSec || null) : to;
  let coverage = meta.coverage;
  if (windowEnd && windowEnd > from) {
    coverage = Math.max(0, Math.min(1, 1 - sumGapSeconds(gaps, from, windowEnd) / (windowEnd - from)));
  }
  return {
    ok: true,
    segments: sliceSegments(meta.segments, { start: from, end: to }),
    gaps,
    durationSec: meta.durationSec,
    language: meta.language,
    providers: meta.providers,
    engine: meta.engine,
    coverage,
    partial: gaps.length > 0,
    createdAt: meta.createdAt,
    fileName: meta.fileName,
    range: { start: from, end: to },
  };
}

// ── time-range parsing («del minuto 30 al 45») ──────────────────────────────

const UNIT_SECONDS = Object.freeze({
  h: HOUR, hr: HOUR, hrs: HOUR, hora: HOUR, horas: HOUR, hour: HOUR, hours: HOUR,
  m: 60, min: 60, mins: 60, minuto: 60, minutos: 60, minute: 60, minutes: 60,
  s: 1, seg: 1, segs: 1, segundo: 1, segundos: 1, sec: 1, secs: 1, second: 1, seconds: 1,
});
const ARTICLES = new Set(['el', 'la', 'las', 'los', 'the']);
const INTRODUCERS = new Set(['del', 'de', 'desde', 'entre', 'from', 'between']);
const CONNECTORS = new Set(['al', 'a', 'hasta', 'y', '-', 'to', 'and', 'until', 'till', 'through']);
const STRONG_INTRO = new Set(['del', 'desde', 'from', 'entre', 'between']);
const STRONG_CONNECT = new Set(['al', 'hasta', 'y', 'to', 'and', 'until', 'till', 'through']);
const NON_TIME_NOUNS = /^(?:puntos?|paginas?|parrafos?|diapositivas?|laminas?|capitulos?|preguntas?|ejercicios?|items?|lineas?|archivos?|audios?|videos?|grabaciones?|clases?|ideas?|ejemplos?|partes?|pasos?|temas?|personas?|alumnos?|anos?|dias?|pages?|slides?|files?|questions?|lines?)$/;
const FILE_PLURALS = /^(?:audios|videos|archivos|grabaciones|clases|files|pistas|partes|capitulos|documentos)$/;
const DURATION_CONTEXT = /^(?:resumen|resumenes|podcast|presentacion|exposicion|discurso|guion|lectura|charla|clip|cancion|version|explicacion|intervencion|dura|duren|durar|duracion|aproximadamente|aprox|unos|unas|summary|speech|talk|lasting|about|roughly)$/;
const ORDINAL_HOURS = Object.freeze({ primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6, septima: 7, setima: 7, octava: 8, novena: 9, decima: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 });
const MAX_RANGE_SEC = 48 * HOUR;

function foldRangeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—−]/g, '-')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\s*'\s*(\d)/g, '$1:$2');
}

function tokenizeRange(text) {
  return foldRangeText(text).match(/\d+h\d{1,2}(?:m(?:in)?)?|\d{1,3}(?::\d{1,2}){1,2}(?:\.\d+)?|\d+(?:\.\d+)?|[a-z]+|-/g) || [];
}

/**
 * Parse one time value at tokens[i]. Returns null or
 * { sec, value, bare, clock: 2|3|null, unit, pre, raw, next } — `sec` is null
 * for a bare number (its unit is inferred from the other end of the range),
 * `pre` is true when a unit word leads the value («minuto 30»).
 */
function parseRangeValue(tokens, i) {
  let j = i;
  let preUnit = null;
  if (UNIT_SECONDS[tokens[j]] && tokens[j].length > 1 && j + 1 < tokens.length && /^\d/.test(tokens[j + 1])) {
    preUnit = UNIT_SECONDS[tokens[j]];
    j++;
  }
  const pre = preUnit != null;
  const tok = tokens[j];
  if (!tok || !/^\d/.test(tok)) return null;
  let m = /^(\d+)h(\d{1,2})(?:m(?:in)?)?$/.exec(tok);
  if (m) return { sec: Number(m[1]) * HOUR + Number(m[2]) * 60, bare: false, clock: null, unit: HOUR, pre, raw: tok, next: j + 1 };
  m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(tok);
  if (m) {
    let sec;
    let clock;
    if (m[3] != null) {
      sec = Number(m[1]) * HOUR + Number(m[2]) * 60 + Number(m[3]);
      clock = 3;
    } else {
      clock = 2;
      sec = preUnit === HOUR ? Number(m[1]) * HOUR + Number(m[2]) * 60 : Number(m[1]) * 60 + Number(m[2]);
    }
    let next = j + 1;
    if (clock === 2 && preUnit == null && (tokens[next] === 'h' || tokens[next] === 'hora' || tokens[next] === 'horas')) {
      sec = Number(m[1]) * HOUR + Number(m[2]) * 60; // «1:20 h» is h:mm
      next++;
    }
    return { sec, bare: false, clock, unit: preUnit, pre, raw: tok, next };
  }
  const value = Number(tok);
  let next = j + 1;
  let postUnit = null;
  if (UNIT_SECONDS[tokens[next]]) { postUnit = UNIT_SECONDS[tokens[next]]; next++; }
  // «1 h 30 (min)» composite.
  if (postUnit === HOUR && tokens[next] && /^\d{1,2}$/.test(tokens[next]) && Number(tokens[next]) < 60) {
    const minutes = Number(tokens[next]);
    next++;
    if (UNIT_SECONDS[tokens[next]] === 60) next++;
    return { sec: value * HOUR + minutes * 60, bare: false, clock: null, unit: HOUR, pre, raw: tok, next };
  }
  const unit = postUnit || preUnit;
  if (unit) return { sec: value * unit, value, bare: false, clock: null, unit, pre, raw: tok, next };
  return { sec: null, value, bare: true, clock: null, unit: null, pre, raw: tok, next };
}

function skipArticle(tokens, i) {
  return ARTICLES.has(tokens[i]) ? i + 1 : i;
}

/**
 * Hour-aware end (same rule as transcribe-url-tool.resolveRangeEnd): past the
 * hour, an «a:bb» end that would fall before the start is hours:minutes.
 */
function resolveRangeEndSeconds(start, end, rawEnd) {
  if (start == null || end == null || end > start || start < HOUR) return end;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(rawEnd == null ? '' : rawEnd));
  if (!m) return end;
  const asHours = Number(m[1]) * HOUR + Number(m[2]) * 60;
  return asHours > start ? asHours : end;
}

function tryConnectorRange(tokens, i) {
  let j = i;
  let intro = null;
  let article = null;
  if (INTRODUCERS.has(tokens[j])) {
    intro = tokens[j];
    if (ARTICLES.has(tokens[j + 1])) article = tokens[j + 1];
    j = skipArticle(tokens, j + 1);
  }
  const a = parseRangeValue(tokens, j);
  if (!a) return null;
  j = a.next;
  const connector = tokens[j];
  if (!CONNECTORS.has(connector)) return null;
  j = skipArticle(tokens, j + 1);
  const b = parseRangeValue(tokens, j);
  if (!b) return null;
  const hasClock = Boolean(a.clock || b.clock);
  const hasUnit = Boolean(a.unit || b.unit);
  // Without an introducer only a clock («30:00-45:00») or a leading unit word
  // («minuto 30 a 45») names a window; «2 a 3 minutos» is a length.
  if (!intro && !hasClock && !a.pre) return null;
  if (!hasClock && !hasUnit) {
    // Bare numbers («del 30 al 45») mean minutes only with del/desde … al/hasta,
    // and never when they count files («los audios del 1 al 10») or other nouns.
    if (!STRONG_INTRO.has(intro) || !STRONG_CONNECT.has(connector)) return null;
    if (article === 'las') return null; // «entre las 10 y las 12» is a time of day
    if (tokens.slice(0, i).some((t) => FILE_PLURALS.test(t))) return null;
    let k = b.next;
    if (tokens[k] === 'de' || tokens[k] === 'del') k = skipArticle(tokens, k + 1);
    if (NON_TIME_NOUNS.test(tokens[b.next] || '') || NON_TIME_NOUNS.test(tokens[k] || '')) return null;
  }
  if ((intro === 'de' || intro === 'entre' || intro === 'between') && !hasClock && !a.pre) {
    // «un resumen de 2 a 3 minutos» asks for a length, not a window.
    let p = i - 1;
    if (tokens[p] === 'de') p--;
    if (DURATION_CONTEXT.test(tokens[p] || '')) return null;
  }
  const unit = a.unit || b.unit || 60;
  const startSec = a.sec != null ? a.sec : a.value * unit;
  let endSec;
  if (b.sec != null) endSec = b.sec;
  else endSec = b.value * (a.unit || unit);
  // «de la hora 1:30 a la 2» — a clock2 under an hour unit reads h:mm.
  if (b.clock === 2 && a.unit === HOUR && b.unit == null) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(b.raw);
    if (m) endSec = Number(m[1]) * HOUR + Number(m[2]) * 60;
  }
  endSec = resolveRangeEndSeconds(startSec, endSec, b.clock === 2 ? b.raw : null);
  return { start: startSec, end: endSec, next: b.next };
}

function tryFirstN(tokens, i) {
  let j = skipArticle(tokens, i);
  if (!/^(?:primer|primera|primeros|primeras|first)$/.test(tokens[j] || '')) return null;
  j++;
  let count = 1;
  if (tokens[j] && /^\d+(?:\.\d+)?$/.test(tokens[j])) { count = Number(tokens[j]); j++; }
  let factor = 1;
  if (tokens[j] === 'media' || tokens[j] === 'half') { factor = 0.5; j++; if (tokens[j] === 'an') j++; }
  const unit = UNIT_SECONDS[tokens[j]];
  if (!unit || tokens[j].length === 1) return null;
  return { start: 0, end: count * factor * unit };
}

function tryLastN(tokens, i, durationSec) {
  let j = skipArticle(tokens, i);
  if (!/^(?:ultimo|ultima|ultimos|ultimas|last|final|finales)$/.test(tokens[j] || '')) return null;
  j++;
  let count = 1;
  if (tokens[j] && /^\d+(?:\.\d+)?$/.test(tokens[j])) { count = Number(tokens[j]); j++; }
  let factor = 1;
  if (tokens[j] === 'media' || tokens[j] === 'half') { factor = 0.5; j++; }
  const unit = UNIT_SECONDS[tokens[j]];
  if (!unit || tokens[j].length === 1) return null;
  const d = num(durationSec);
  if (!d || d <= 0) return { unresolved: true };
  return { start: Math.max(0, d - count * factor * unit), end: d };
}

function tryOrdinalHour(tokens, i) {
  const j = skipArticle(tokens, i);
  const k = ORDINAL_HOURS[tokens[j]];
  if (!k || !(tokens[j + 1] === 'hora' || tokens[j + 1] === 'hour')) return null;
  return { start: (k - 1) * HOUR, end: k * HOUR };
}

function tryOpenStart(tokens, i) {
  let j = i;
  if (tokens[j] === 'desde' || tokens[j] === 'from') j++;
  else if (tokens[j] === 'a' && tokens[j + 1] === 'partir' && (tokens[j + 2] === 'de' || tokens[j + 2] === 'del')) j += 3;
  else return null;
  j = skipArticle(tokens, j);
  const a = parseRangeValue(tokens, j);
  if (!a || a.bare) return null;
  return { start: a.sec, end: null };
}

function tryOpenEnd(tokens, i) {
  if (tokens[i] !== 'hasta' && tokens[i] !== 'until') return null;
  const j = skipArticle(tokens, i + 1);
  const a = parseRangeValue(tokens, j);
  if (!a || a.bare) return null;
  return { start: 0, end: a.sec };
}

function validRange(range) {
  if (!range || range.start == null || !Number.isFinite(range.start) || range.start < 0) return null;
  if (range.start > MAX_RANGE_SEC) return null;
  if (range.end != null) {
    if (!Number.isFinite(range.end) || range.end <= range.start || range.end > MAX_RANGE_SEC) return null;
  }
  return { start: Math.round(range.start * 1000) / 1000, end: range.end == null ? null : Math.round(range.end * 1000) / 1000 };
}

/**
 * «del minuto 30 al 45» → {start:1800, end:2700} · «de 1:30:00 a 2:00:00» →
 * {5400, 7200} · «del 60 al 1:20» → {3600, 4800} (hour-aware end) · «los
 * primeros 10 minutos» → {0, 600} · «la segunda hora» → {3600, 7200} ·
 * «desde el minuto 30» → {1800, end:null} · «hasta el minuto 10» → {0, 600}.
 * «los últimos 10 minutos» needs `durationSec`. Bare numbers default to
 * minutes. Returns null when the text names no time window.
 */
function parseTimeRange(text, { durationSec } = {}) {
  const tokens = tokenizeRange(text);
  if (!tokens.length) return null;
  for (let i = 0; i < tokens.length; i++) {
    const range = tryConnectorRange(tokens, i);
    if (range) return validRange(range);
  }
  for (let i = 0; i < tokens.length; i++) {
    const range = tryFirstN(tokens, i) || tryOrdinalHour(tokens, i);
    if (range) return validRange(range);
    const last = tryLastN(tokens, i, durationSec);
    if (last) return last.unresolved ? null : validRange(last);
  }
  for (let i = 0; i < tokens.length; i++) {
    const range = tryOpenStart(tokens, i) || tryOpenEnd(tokens, i);
    if (range) return validRange(range);
  }
  return null;
}

module.exports = {
  // main API
  cleanSegments,
  cleanSegmentsDetailed,
  buildParagraphs,
  renderText,
  renderSrt,
  renderVtt,
  renderMarkdown,
  buildTranscriptPack,
  sliceSegments,
  sliceResult,
  parseTimeRange,
  // helpers shared with media-transcript-store and future consumers
  normalizeSegment,
  normalizeTranscriptResult,
  normalizeGaps,
  speakerLabels,
  formatClock,
  formatDurationHuman,
  languageCode,
  languageNameEs,
  stripEngineHeader,
  wrapCue,
  // constants
  SUBTITLE,
  LOW_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_MARK,
  PACK_FORMATS,
};
