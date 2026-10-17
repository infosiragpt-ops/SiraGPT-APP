'use strict';

/**
 * Engine-agnostic quality of a transcribed piece (contract C4, quality half).
 *
 * Pure: no I/O, no clock, no network. The transcriber feeds it what an engine
 * returned for one piece (text, timed segments) plus the evidence it already
 * has (piece length, voiced seconds measured on demand, the prompt terms) and
 * gets back flags, a score in [0, 1] and, when several hypotheses exist for
 * the same piece, which one to keep.
 *
 * Signals (all comparable ACROSS engines):
 *   - hallucination lexicon: sign-offs / credits only engines write («Gracias
 *     por ver el video», «Subtítulos … Amara.org»), non-speech annotations
 *     («[Música]», «[BLANK_AUDIO]») and prompt echo (a run of the words the
 *     recogniser was primed with) — shared with media-transcript-format;
 *   - compression ratio of the text (> 2.4 on ≥ 200 chars: a decoder loop);
 *   - characters per VOICED second (only with measured voiced seconds):
 *     under 2.5 on ≥ 20 voiced seconds is speech the engine skipped, over 45
 *     is text invented over silence;
 *   - holes: ≥ 30 s without a segment inside a piece whose measured audio is
 *     voiced there (dropped speech);
 *   - empty text on a piece with speech energy (never «covered» on its own).
 * Confidence (avg_logprob, token p) is NOT comparable across engines: it only
 * flags a piece for review and breaks ties between hypotheses of the SAME
 * engine (critic correction «no cross-engine logprob comparison»).
 */

const zlib = require('zlib');

const LOOP_COMPRESSION_RATIO = 2.4;
const LOOP_MIN_CHARS = 200;
const UNDER_CHARS_PER_VOICED_SEC = 2.5;
const UNDER_MIN_VOICED_SEC = 20;
const OVER_CHARS_PER_VOICED_SEC = 45;
const OVER_MIN_CHARS = 300;
// Voiced seconds (energy over ENERGY_THRESHOLD_DB) under which an empty piece
// is plain silence, and over which an empty answer is suspicious.
const SILENT_VOICED_SEC = 1.5;
const ENERGY_VOICED_SEC = 3;
// The energy measurement's threshold: well under the cut threshold (-35 dB),
// so a quiet, far-field voice still counts as sound to be checked.
const ENERGY_THRESHOLD_DB = -50;
const HOLE_MIN_SEC = 30;
const HOLE_VOICED_SEC = 20;
// Per-segment marker (same threshold as media-transcript-format's «[?]»).
const SEGMENT_LOW_CONFIDENCE = 0.4;
// Mean confidence of a piece that asks for a second hypothesis (same engine only).
const PIECE_LOW_CONFIDENCE = 0.35;
const AGREEMENT_OK = 0.7;
const OVERRIDE_MARGIN = 0.25;
const MAX_AGREEMENT_TOKENS = 2500;
const MAX_LOW_CONFIDENCE = 500;
const MERGE_GAP_SEC = 2;
const MAX_NOTES = 12;
const MAX_ENGINES = 12;

const FLAG_PENALTY = Object.freeze({
  empty_with_energy: 0.1,
  hallucination: 0.15,
  loop: 0.35,
  under_transcribed: 0.4,
  over_generated: 0.5,
  dropped_speech: 0.6,
  suspect: 0.6,
  engine_disagreement: 0.6,
  low_confidence: 0.75,
  quiet: 0.5,
  timestamps: 0.9,
});

// Flags derived from an engine's own confidence: never compared across engines.
const CONFIDENCE_FLAGS = new Set(['low_confidence']);
// Flags that make a hypothesis unusable when another one exists.
const HARD_FLAGS = new Set(['empty_with_energy', 'hallucination', 'loop']);
// Flags that ask for another hypothesis (bounded by the job's budget).
const REVIEW_FLAGS = new Set(['empty_with_energy', 'hallucination', 'loop', 'under_transcribed', 'dropped_speech', 'over_generated', 'low_confidence', 'suspect']);

// ── text helpers ────────────────────────────────────────────────────────────

let formatModule = null;
function formatHelpers() {
  if (formatModule === null) {
    try { formatModule = require('./media-transcript-format'); } catch { formatModule = false; }
  }
  return formatModule || null;
}

/** Lower-case, no accents, letters and digits only (same folding as the formatter). */
function foldText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Whole-text non-speech annotations (Whisper over silence / music): the text
// is only bracketed / parenthesized groups («[Música de fondo]», «(upbeat
// music)», «[♪]»), optionally wrapped in *…*, each group short (≤ 6 words)
// and naming a non-speech sound; or notes / punctuation alone. Matched on the
// folded text (no accents, «_» → space).
const NON_SPEECH_KEYWORD_RE = /\b(?:blank audio|no speech|nospeech|silence|silent|silencio|musica|musical|music|instrumental|inaudible|aplausos?|applause|ruidos?|noise|sonidos?|sounds?|risas?|laughter|laughs?|laughing|tos|cough(?:s|ing)?|static|estatica|beeps?|pitidos?)\b/;
const MAX_ANNOTATION_WORDS = 6;
const MAX_ANNOTATION_GROUP_CHARS = 120;
const NOTES_RE = /[♪♫]/;
// One step of the whole-text scan (sticky): a group, the no-speech token, or separators.
const ANNOTATION_STEP_RE = new RegExp([
  `\\[([^\\[\\]]{0,${MAX_ANNOTATION_GROUP_CHARS}})\\]`,
  `\\(([^()]{0,${MAX_ANNOTATION_GROUP_CHARS}})\\)`,
  `\\*([^*\\[\\]()]{1,${MAX_ANNOTATION_GROUP_CHARS}})\\*`,
  '<\\|\\s*nospeech\\s*\\|>',
  '[\\s♪♫.…,;:!¡?¿*\\-–—]+',
].join('|'), 'y');

/** One annotation group's inner text: notes only, or ≤ 6 words naming a non-speech sound. */
function isAnnotationGroup(inner) {
  const raw = String(inner || '');
  const words = foldText(raw).split(' ').filter(Boolean);
  if (!words.length) return true; // «[♪]», «( )»
  if (words.length > MAX_ANNOTATION_WORDS) return false;
  return NON_SPEECH_KEYWORD_RE.test(words.join(' '));
}

/** True when the text is only non-speech annotations, notes or punctuation. */
function isNonSpeechText(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  ANNOTATION_STEP_RE.lastIndex = 0;
  let index = 0;
  while (index < value.length) {
    ANNOTATION_STEP_RE.lastIndex = index;
    const match = ANNOTATION_STEP_RE.exec(value);
    if (!match || match[0].length === 0) return false;
    const inner = match[1] ?? match[2] ?? match[3];
    if (inner != null) {
      // *…* around a bracket is a wrapper (scanned on); around words, a group.
      if (!isAnnotationGroup(inner)) return false;
    }
    index += match[0].length;
  }
  return true;
}

// Used only when media-transcript-format cannot be loaded.
const FALLBACK_LEXICON = [
  /^(?:(?:muchas|mil) )?gracias por (?:ver|mirar)(?: (?:el|este) video)?$/,
  /^(?:suscribete|suscribanse)(?: al canal)?$/,
  /^(?:thank you|thanks) for watching$/,
  /amara org/,
];

/** A segment's own confidence in [0, 1]: explicit, else exp(avg_logprob) (verbose_json); null without one. */
function segmentConfidence(seg) {
  const explicit = Number(seg?.confidence);
  if (seg?.confidence != null && Number.isFinite(explicit)) return Math.min(1, Math.max(0, explicit));
  const logprob = Number(seg?.avg_logprob);
  if (seg?.avg_logprob != null && Number.isFinite(logprob)) return Math.min(1, Math.max(0, Math.exp(logprob)));
  return null;
}

/**
 * One timed segment → 'speech' | 'annotation' | 'lexicon' | 'echo' (hard:
 * never speech) | 'soft' (a lone «Gracias» / one prompt word / a segment the
 * engine itself rated as probably silence, that needs a second opinion) |
 * 'empty'.
 */
function classifySegment(seg, promptIndex = null) {
  const text = String(seg?.text || '').trim();
  if (!text) return 'empty';
  if (isNonSpeechText(text)) return 'annotation';
  // Whisper's own «this was probably silence» (no_speech_prob > 0.6 with a
  // low avg_logprob): the engine's signal about itself, never compared.
  const noSpeech = Number(seg?.no_speech_prob);
  const logprob = Number(seg?.avg_logprob);
  if (seg?.no_speech_prob != null && Number.isFinite(noSpeech) && noSpeech > 0.6
    && seg?.avg_logprob != null && Number.isFinite(logprob) && logprob < -1) return 'soft';
  const fmt = formatHelpers();
  const confidence = segmentConfidence(seg);
  const shaped = {
    start: Number(seg.start) || 0,
    end: Number(seg.end) || 0,
    text,
    ...(confidence != null ? { confidence } : {}),
  };
  if (fmt && typeof fmt.hallucinationKind === 'function') {
    let kind = null;
    try { kind = fmt.hallucinationKind(shaped); } catch { kind = null; }
    if (kind === 'lexicon') return 'lexicon';
    if (kind) return 'soft';
  } else if (FALLBACK_LEXICON.some((re) => re.test(foldText(text)))) {
    return 'lexicon';
  }
  if (promptIndex && fmt && typeof fmt.promptEchoKind === 'function') {
    let kind = null;
    try { kind = fmt.promptEchoKind(shaped, promptIndex); } catch { kind = null; }
    if (kind === 'pattern') return 'echo';
    if (kind) return 'soft';
  }
  return 'speech';
}

/** The formatter's prompt-echo index for these terms, or null. */
function buildPromptIndex(terms) {
  const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return null;
  const fmt = formatHelpers();
  if (!fmt || typeof fmt.promptEchoIndex !== 'function') return null;
  try { return fmt.promptEchoIndex(list); } catch { return null; }
}

/** Raw bytes ÷ deflated bytes of the text (Whisper's loop signal), or null under LOOP_MIN_CHARS. */
function compressionRatio(text) {
  const value = String(text || '');
  if (value.length < LOOP_MIN_CHARS) return null;
  const raw = Buffer.from(value, 'utf8');
  const packed = zlib.deflateSync(raw);
  return packed.length ? Math.round((raw.length / packed.length) * 1000) / 1000 : null;
}

/** Duration-weighted mean confidence of segments that carry one, or null. */
function meanConfidence(segments) {
  let weight = 0;
  let total = 0;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const c = segmentConfidence(seg);
    if (c == null) continue;
    const length = Math.max(0.5, (Number(seg.end) || 0) - (Number(seg.start) || 0));
    weight += length;
    total += c * length;
  }
  return weight > 0 ? Math.round((total / weight) * 1000) / 1000 : null;
}

// ── silencedetect → voiced seconds ──────────────────────────────────────────

/**
 * ffmpeg silencedetect stderr + piece length → { voicedSec, silences }.
 * A trailing «silence_start» without its end runs to the end of the piece.
 * Silences are piece-relative and capped (2000).
 */
function voicedFromSilencedetect(stderr, durationSec) {
  const duration = Number(durationSec);
  if (!(duration > 0)) return { voicedSec: null, silences: [] };
  const silences = [];
  let start = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const begin = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (begin) { start = Math.max(0, Number(begin[1])); continue; }
    const finish = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (finish && start != null) {
      const end = Math.min(duration, Number(finish[1]));
      if (end > start && silences.length < 2000) silences.push({ start, end });
      start = null;
    }
  }
  if (start != null && start < duration && silences.length < 2000) silences.push({ start, end: duration });
  let silent = 0;
  let cursor = 0;
  for (const s of silences.slice().sort((a, b) => a.start - b.start)) {
    const from = Math.max(cursor, s.start);
    if (s.end > from) silent += s.end - from;
    cursor = Math.max(cursor, s.end);
  }
  return { voicedSec: Math.round(Math.max(0, duration - silent) * 1000) / 1000, silences };
}

/** Voiced seconds of [start, end] given piece-relative silences. */
function voicedWithin(silences, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return 0;
  let silent = 0;
  for (const s of Array.isArray(silences) ? silences : []) {
    const a = Math.max(start, s.start);
    const b = Math.min(end, s.end);
    if (b > a) silent += b - a;
  }
  return Math.max(0, length - silent);
}

/** Stretches ≥ HOLE_MIN_SEC with no segment inside a timed piece. */
function timestampHoles(segments, durationSec) {
  const duration = Number(durationSec) || 0;
  const timed = (Array.isArray(segments) ? segments : [])
    .filter((s) => Number.isFinite(Number(s?.start)) && Number.isFinite(Number(s?.end)) && String(s?.text || '').trim())
    .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
    .sort((a, b) => a.start - b.start);
  if (!timed.length || !(duration > 0)) return [];
  const holes = [];
  let cursor = 0;
  for (const seg of timed) {
    if (seg.start - cursor >= HOLE_MIN_SEC) holes.push({ start: cursor, end: seg.start });
    cursor = Math.max(cursor, seg.end);
  }
  if (duration - cursor >= HOLE_MIN_SEC) holes.push({ start: cursor, end: duration });
  return holes;
}

// ── one hypothesis ──────────────────────────────────────────────────────────

/**
 * Assess one hypothesis of a piece.
 * @param {object} input { text, segments, durationSec, voicedSec?, silences?,
 *   promptIndex? | promptTerms?, timed? }
 * @returns {{ flags: string[], score: number, empty: boolean, hardOnly: boolean,
 *   suspectOnly: boolean, speechText: string, chars: number, compressionRatio: number|null,
 *   meanConfidence: number|null, charsPerVoicedSec: number|null, holes: Array,
 *   needsEnergy: boolean, kinds: object, spans: Array<{start,end,reason}> }}
 */
function assessHypothesis(input = {}) {
  const promptIndex = input.promptIndex || (input.promptTerms ? buildPromptIndex(input.promptTerms) : null);
  const duration = Number(input.durationSec) > 0 ? Number(input.durationSec) : null;
  const voiced = input.voicedSec == null || !Number.isFinite(Number(input.voicedSec)) ? null : Math.max(0, Number(input.voicedSec));
  const rawSegments = (Array.isArray(input.segments) ? input.segments : []).filter((s) => String(s?.text || '').trim());
  const text = String(input.text || '').trim();
  const segments = rawSegments.length ? rawSegments : (text ? [{ start: 0, end: duration || 0, text }] : []);
  const kinds = { speech: 0, annotation: 0, lexicon: 0, echo: 0, soft: 0 };
  const speech = [];
  const soft = [];
  for (const seg of segments) {
    const kind = classifySegment(seg, promptIndex);
    if (kind === 'empty') continue;
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind === 'speech') speech.push(String(seg.text).trim());
    else if (kind === 'soft') soft.push(String(seg.text).trim());
  }
  const speechText = speech.join(' ').trim();
  const softText = soft.join(' ').trim();
  const chars = speechText.length + softText.length;
  const empty = chars === 0 && kinds.lexicon === 0 && kinds.echo === 0;
  const hardOnly = chars === 0 && (kinds.lexicon > 0 || kinds.echo > 0);
  const suspectOnly = !speechText && softText.length > 0;
  const ratio = compressionRatio(speechText || softText);
  const confidence = meanConfidence(rawSegments);
  const flags = [];
  const spans = [];
  const whole = duration ? { start: 0, end: duration } : null;
  const energetic = voiced == null ? null : voiced >= ENERGY_VOICED_SEC;
  let needsEnergy = false;
  if (empty || hardOnly) {
    if (energetic === true) flags.push(hardOnly ? 'hallucination' : 'empty_with_energy');
    else if (energetic == null) needsEnergy = true;
  } else if (suspectOnly) {
    flags.push('suspect');
    if (whole) spans.push({ ...whole, reason: 'hallucination', flag: 'suspect' });
    if (voiced == null) needsEnergy = true;
  }
  if (ratio != null && ratio > LOOP_COMPRESSION_RATIO) {
    flags.push('loop');
    if (whole) spans.push({ ...whole, reason: 'loop', flag: 'loop' });
  }
  let charsPerVoicedSec = null;
  if (voiced != null && voiced > 0 && chars > 0) charsPerVoicedSec = Math.round((chars / voiced) * 100) / 100;
  if (!empty && !hardOnly && voiced != null) {
    if (voiced >= UNDER_MIN_VOICED_SEC && charsPerVoicedSec != null && charsPerVoicedSec < UNDER_CHARS_PER_VOICED_SEC) {
      flags.push('under_transcribed');
      if (whole) spans.push({ ...whole, reason: 'under_transcribed', flag: 'under_transcribed' });
    } else if (chars >= OVER_MIN_CHARS && charsPerVoicedSec != null && charsPerVoicedSec > OVER_CHARS_PER_VOICED_SEC) {
      flags.push('over_generated');
      if (whole) spans.push({ ...whole, reason: 'hallucination', flag: 'over_generated' });
    }
  } else if (!empty && !hardOnly && duration && duration >= 60 && chars / duration < 1) {
    // Sparse for its length: only measured evidence can say whether speech was skipped.
    needsEnergy = true;
  }
  const holes = input.timed === false ? [] : timestampHoles(rawSegments, duration);
  if (holes.length && !empty && !hardOnly) {
    if (Array.isArray(input.silences) && voiced != null) {
      for (const hole of holes) {
        // Never more voiced seconds in a hole than in the whole piece.
        if (Math.min(voiced, voicedWithin(input.silences, hole.start, hole.end)) >= HOLE_VOICED_SEC) {
          if (!flags.includes('dropped_speech')) flags.push('dropped_speech');
          spans.push({ start: hole.start, end: hole.end, reason: 'dropped_speech', flag: 'dropped_speech' });
        }
      }
    } else if (voiced == null) {
      needsEnergy = true;
    }
  }
  if (confidence != null && confidence < PIECE_LOW_CONFIDENCE && chars > 0) flags.push('low_confidence');
  return {
    flags,
    score: scoreFromFlags(flags),
    // What a choice BETWEEN engines may use: no confidence-derived penalty
    // (a logprob is only comparable within the same engine).
    agnosticScore: scoreFromFlags(flags.filter((f) => !CONFIDENCE_FLAGS.has(f))),
    empty,
    hardOnly,
    suspectOnly,
    speechText,
    chars,
    compressionRatio: ratio,
    meanConfidence: confidence,
    charsPerVoicedSec,
    voicedSec: voiced,
    holes,
    needsEnergy,
    kinds,
    spans,
  };
}

function scoreFromFlags(flags) {
  let score = 1;
  for (const flag of new Set(Array.isArray(flags) ? flags : [])) {
    const penalty = FLAG_PENALTY[flag];
    if (penalty != null) score *= penalty;
  }
  return Math.round(Math.max(0.05, Math.min(1, score)) * 1000) / 1000;
}

/** Whether these flags ask for another hypothesis. */
function needsReview(assessment) {
  return Boolean(assessment && assessment.flags.some((f) => REVIEW_FLAGS.has(f)));
}

/** Text says nothing (empty, annotations, sign-offs or prompt echo only). */
function saysNothing(assessment) {
  return Boolean(assessment && (assessment.empty || assessment.hardOnly));
}

function isHard(assessment) {
  if (!assessment) return true;
  if (assessment.empty || assessment.hardOnly) return true;
  return assessment.flags.some((f) => HARD_FLAGS.has(f));
}

// ── agreement between hypotheses ────────────────────────────────────────────

/**
 * Word-level agreement of two transcripts in [0, 1]: 1 − edit distance over
 * the longer token list (≈ 1 − WER). Both empty → 1; one empty → 0. Lists are
 * capped (MAX_AGREEMENT_TOKENS) so the O(n·m) cost stays bounded.
 */
function wordAgreement(a, b) {
  const x = foldText(a).split(' ').filter(Boolean).slice(0, MAX_AGREEMENT_TOKENS);
  const y = foldText(b).split(' ').filter(Boolean).slice(0, MAX_AGREEMENT_TOKENS);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  let prev = new Int32Array(y.length + 1);
  let curr = new Int32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    curr[0] = i;
    const xi = x[i - 1];
    for (let j = 1; j <= y.length; j++) {
      const cost = xi === y[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev; prev = curr; curr = swap;
  }
  const distance = prev[y.length];
  return Math.round(Math.max(0, 1 - distance / Math.max(x.length, y.length)) * 1000) / 1000;
}

/**
 * Pick one hypothesis of a piece. candidates: [{ engineKey, order,
 * assessment, ... }] (order 0 = the ladder's first answer).
 *   - Hypotheses that say nothing / loop are dropped while another one has
 *     usable text; when every one says nothing, the first answer stays and
 *     `confirmedEmpty` tells whether two of them agree on it.
 *   - Two usable hypotheses that agree (≥ 0.7 word agreement) confirm each
 *     other: the higher score of the pair wins.
 *   - Without agreement, the first answer stays unless another one scores
 *     clearly better (≥ 0.25), and the piece is marked `disagreement`.
 *   - Confidence breaks a tie ONLY between hypotheses of the same engine.
 * Returns { chosen, disagreement, confirmedEmpty, agreement }.
 */
function chooseHypothesis(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.assessment);
  if (!list.length) return { chosen: null, disagreement: false, confirmedEmpty: false, agreement: null };
  const ordered = list.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const original = ordered[0];
  // Among hypotheses that say nothing, keep the one that is truly empty (or
  // only an annotation) over an invented sign-off / prompt echo.
  const quietest = (pool) => pool.find((c) => c.assessment.empty) || pool.find((c) => saysNothing(c.assessment)) || pool[0];
  // A lone «Gracias» / one prompt word against «nothing heard»: the classic
  // silence hallucination. Nothing was said.
  const nothingish = (a) => saysNothing(a) || a.suspectOnly;
  if (ordered.length >= 2 && ordered.every((c) => nothingish(c.assessment)) && ordered.some((c) => saysNothing(c.assessment))) {
    return { chosen: quietest(ordered), disagreement: false, confirmedEmpty: true, agreement: null };
  }
  const usable = ordered.filter((c) => !isHard(c.assessment));
  if (!usable.length) {
    const silent = ordered.filter((c) => saysNothing(c.assessment));
    if (silent.length === ordered.length) {
      return { chosen: quietest(ordered), disagreement: false, confirmedEmpty: silent.length >= 2, agreement: null };
    }
    // Some text exists but every text is flagged (a loop, …): keep the best scoring one.
    const withText = ordered.filter((c) => !saysNothing(c.assessment));
    const best = withText.reduce((acc, c) => ((c.assessment.agnosticScore ?? c.assessment.score) > (acc.assessment.agnosticScore ?? acc.assessment.score) ? c : acc), withText[0]);
    return { chosen: best, disagreement: false, confirmedEmpty: false, agreement: null };
  }
  if (usable.length === 1) return { chosen: usable[0], disagreement: false, confirmedEmpty: false, agreement: null };
  const textOf = (c) => c.assessment.speechText || c.text || '';
  let bestPair = null;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const agreement = wordAgreement(textOf(usable[i]), textOf(usable[j]));
      if (!bestPair || agreement > bestPair.agreement) bestPair = { a: usable[i], b: usable[j], agreement };
    }
  }
  const scoreOf = (c) => (c.assessment.agnosticScore != null ? c.assessment.agnosticScore : c.assessment.score);
  const better = (a, b) => {
    const delta = scoreOf(a) - scoreOf(b);
    if (Math.abs(delta) >= 0.05) return delta > 0 ? a : b;
    if (a.engineKey && a.engineKey === b.engineKey) {
      const ca = a.assessment.meanConfidence;
      const cb = b.assessment.meanConfidence;
      if (ca != null && cb != null && ca !== cb) return ca > cb ? a : b;
    }
    return (a.order || 0) <= (b.order || 0) ? a : b;
  };
  if (bestPair && bestPair.agreement >= AGREEMENT_OK) {
    return { chosen: better(bestPair.a, bestPair.b), disagreement: false, confirmedEmpty: false, agreement: bestPair.agreement };
  }
  const top = usable.reduce((acc, c) => better(c, acc), usable[0]);
  let chosen = top;
  if (top !== original && usable.includes(original) && scoreOf(top) - scoreOf(original) < OVERRIDE_MARGIN) chosen = original;
  // Only two CLEAN readings that differ are a disagreement; a flagged one
  // (skipped speech, invented text…) replaced by a clean one is a repair.
  const clean = usable.filter((c) => !hasReviewFlag(c.assessment));
  return { chosen, disagreement: clean.length >= 2, confirmedEmpty: false, agreement: bestPair ? bestPair.agreement : null };
}

function hasReviewFlag(assessment) {
  return Boolean(assessment && assessment.flags.some((f) => REVIEW_FLAGS.has(f) && !CONFIDENCE_FLAGS.has(f)));
}

// ── job report ──────────────────────────────────────────────────────────────

function qualityLevel(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s >= 0.85) return 'alta';
  if (s >= 0.6) return 'media';
  return 'baja';
}

/** Sort and merge spans with the same reason that touch (≤ 2 s apart); bounded. */
function mergeSpans(spans) {
  const valid = (Array.isArray(spans) ? spans : [])
    .map((s) => ({ start: Number(s?.start), end: Number(s?.end), reason: String(s?.reason || 'low_confidence').slice(0, 60) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end >= s.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const out = [];
  for (const span of valid) {
    const last = out.length ? out[out.length - 1] : null;
    const sameReason = last && last.reason === span.reason;
    if (sameReason && span.start <= last.end + MERGE_GAP_SEC) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    if (out.length >= MAX_LOW_CONFIDENCE) break;
    out.push({ ...span });
  }
  return out.map((s) => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000, reason: s.reason }));
}

/** Absolute spans of segments whose own confidence is under the «[?]» threshold. */
function lowConfidenceSegmentSpans(segments) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const c = Number(seg?.confidence);
    if (seg?.confidence == null || !Number.isFinite(c) || c >= SEGMENT_LOW_CONFIDENCE) continue;
    out.push({ start: Number(seg.start) || 0, end: Number(seg.end) || 0, reason: 'low_confidence' });
    if (out.length >= MAX_LOW_CONFIDENCE * 2) break;
  }
  return out;
}

function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The C4 quality report of a whole job.
 * @param {object} input {
 *   pieces: [{ start, end, covered, score, lowConfidence: [{start,end,reason}],
 *              engine, disagreement?, confirmedEmpty?, unconfirmedEmpty?,
 *              reviewed? (at least one alternative hypothesis ANSWERED) }],
 *   segments (absolute, final), escalations (alternative-hypothesis attempts,
 *   failed ones included), reviewedPieces? (default: pieces with `reviewed`),
 *   basicLocalOnly?, capBasicLevel?, extraNotes? }
 * @returns {{ score, level, lowConfidence, escalations, enginesUsed, notes }}
 */
function summarizeQuality(input = {}) {
  const pieces = Array.isArray(input.pieces) ? input.pieces : [];
  let weight = 0;
  let total = 0;
  const spans = [];
  const engines = [];
  let disagreements = 0;
  let confirmedEmpty = 0;
  let unconfirmedEmpty = 0;
  let uncertain = 0;
  let reviewedCount = 0;
  for (const piece of pieces) {
    const length = Math.max(0, (Number(piece.end) || 0) - (Number(piece.start) || 0)) || 1;
    const score = piece.covered ? Math.max(0, Math.min(1, Number(piece.score) || 0)) : 0;
    weight += length;
    total += score * length;
    if (piece.covered && Array.isArray(piece.lowConfidence)) spans.push(...piece.lowConfidence);
    if (piece.covered && piece.engine && !engines.includes(piece.engine) && engines.length < MAX_ENGINES) engines.push(piece.engine);
    if (piece.disagreement) disagreements++;
    if (piece.confirmedEmpty) confirmedEmpty++;
    if (piece.unconfirmedEmpty) unconfirmedEmpty++;
    if (piece.reviewed) reviewedCount++;
    if (piece.covered && !piece.reviewed && Number(piece.score) < 0.85) uncertain++;
  }
  spans.push(...lowConfidenceSegmentSpans(input.segments));
  const score = weight > 0 ? Math.round((total / weight) * 1000) / 1000 : null;
  let level = qualityLevel(score);
  const notes = [];
  // `escalations` counts attempts (failed ones too); the note counts pieces
  // that really got another reading.
  const escalations = Math.max(0, Math.round(Number(input.escalations) || 0));
  const explicitReviewed = Number(input.reviewedPieces);
  const reviewed = input.reviewedPieces != null && Number.isFinite(explicitReviewed)
    ? Math.max(0, Math.round(explicitReviewed))
    : reviewedCount;
  if (input.basicLocalOnly) {
    if (level === 'alta' && input.capBasicLevel !== false) level = 'media';
    notes.push('Transcrito con el motor local básico: revisa nombres propios y términos técnicos.');
  }
  if (reviewed > 0) notes.push(`Revisé ${pluralize(reviewed, 'tramo dudoso', 'tramos dudosos')} con otro motor o con el audio realzado.`);
  if (disagreements > 0) notes.push(`En ${pluralize(disagreements, 'tramo', 'tramos')} los motores no coincidieron; quedaron marcados como dudosos.`);
  if (confirmedEmpty > 0) notes.push('Hubo tramos con ruido o música sin voz reconocible (lo confirmé con una segunda lectura).');
  if (unconfirmedEmpty > 0) notes.push('Hubo tramos con sonido en los que no se reconoció voz; quedaron marcados como poco audibles.');
  if (uncertain > 0 && !reviewed) notes.push(`${pluralize(uncertain, 'tramo quedó', 'tramos quedaron')} con señales de baja calidad que no se pudieron revisar.`);
  for (const note of Array.isArray(input.extraNotes) ? input.extraNotes : []) if (note && !notes.includes(note)) notes.push(String(note));
  return {
    score,
    level,
    lowConfidence: mergeSpans(spans),
    escalations,
    enginesUsed: engines,
    notes: notes.slice(0, MAX_NOTES).map((n) => n.slice(0, 300)),
  };
}

module.exports = {
  // assessment
  assessHypothesis,
  classifySegment,
  isNonSpeechText,
  buildPromptIndex,
  compressionRatio,
  meanConfidence,
  segmentConfidence,
  scoreFromFlags,
  needsReview,
  saysNothing,
  isHard,
  timestampHoles,
  voicedFromSilencedetect,
  voicedWithin,
  foldText,
  // hypotheses
  wordAgreement,
  chooseHypothesis,
  // report
  summarizeQuality,
  qualityLevel,
  mergeSpans,
  lowConfidenceSegmentSpans,
  // constants
  LOOP_COMPRESSION_RATIO,
  SILENT_VOICED_SEC,
  ENERGY_VOICED_SEC,
  ENERGY_THRESHOLD_DB,
  SEGMENT_LOW_CONFIDENCE,
  PIECE_LOW_CONFIDENCE,
  AGREEMENT_OK,
  HARD_FLAGS,
  REVIEW_FLAGS,
  CONFIDENCE_FLAGS,
};
