/**
 * natural-speech-engine.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A self-contained, dependency-free "read aloud" engine built entirely on the
 * browser-native Web Speech API (`speechSynthesis`). It is engineered to sound
 * natural, professional and consistent **without depending on any paid,
 * country-locked cloud TTS provider** — it is pure client-side voice
 * engineering.
 *
 * What this engine does that a naive `new SpeechSynthesisUtterance(text)` does
 * NOT:
 *
 *   1. Voice quality scoring — it ranks every voice the platform exposes
 *      (Google / Microsoft Natural / Apple premium / Siri / neural voices)
 *      and always picks the best available one for the detected language,
 *      instead of the OS default robotic voice.
 *
 *   2. Language auto-detection — a fast, allocation-light n-gram + stopword
 *      heuristic that detects the dominant language of the text so the right
 *      voice is chosen even in mixed ES/EN content. No network, no API key.
 *
 *   3. Text normalization for the ear — strips Markdown, fences code blocks
 *      down to a short spoken marker, expands URLs/emails/abbreviations,
 *      verbalizes numbers/symbols, and inserts natural micro-pauses at
 *      punctuation so the delivery has human-like prosody.
 *
 *   4. Sentence-level chunking — long answers are split into sentence-sized
 *      utterances and streamed one after another. This sidesteps the
 *      well-known Chrome/Edge bug where `speechSynthesis` silently stops after
 *      ~15 seconds, and lets us pause/resume cleanly at sentence boundaries.
 *
 *   5. A robust playback controller — play / pause / resume / stop with a
 *      typed event stream (`boundary`, `chunk`, `progress`, `state`, `end`,
 *      `error`) and a watchdog that recovers from the engine stalling.
 *
 * The whole module is framework-agnostic: it never imports React and can be
 * unit tested in isolation. A thin React hook (`useNaturalSpeech`) is provided
 * at the bottom for ergonomic component usage.
 *
 * Design goals: deterministic, defensive (every browser quirk guarded),
 * zero external dependencies, and graceful degradation when the platform
 * exposes only a single low-quality voice.
 */

/* eslint-disable no-bitwise */

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export type SpeechState =
  | "idle"
  | "preparing"
  | "speaking"
  | "paused"
  | "stopped"
  | "error";

export type SupportedLanguage =
  | "es"
  | "en"
  | "pt"
  | "fr"
  | "de"
  | "it"
  | "auto";

export interface SpeechProsody {
  /** Speaking rate. 1 = normal. Range clamped to [0.5, 2]. */
  rate: number;
  /** Pitch. 1 = normal. Range clamped to [0, 2]. */
  pitch: number;
  /** Volume. 1 = full. Range clamped to [0, 1]. */
  volume: number;
}

export interface SpeakOptions {
  /** Force a language; default "auto" runs detection. */
  lang?: SupportedLanguage;
  /** Override prosody for this utterance run. */
  prosody?: Partial<SpeechProsody>;
  /** Force a specific voiceURI (skips scoring). */
  voiceURI?: string;
  /** Max characters per chunk before forcing a split. Default 220. */
  maxChunkChars?: number;
  /** When false, code blocks are spoken verbatim instead of summarized. */
  summarizeCode?: boolean;
}

export interface SpeechEngineEvents {
  state: SpeechState;
  /** 0..1 fraction of chunks completed. */
  progress: number;
  /** Fired as each chunk starts; index is 0-based. */
  chunk: { index: number; total: number; text: string };
  /** Word-boundary callback for karaoke-style highlighting. */
  boundary: { charIndex: number; charLength: number; chunkIndex: number };
  /** Fired once when the whole queue finishes naturally. */
  end: void;
  /** Fired on unrecoverable error. */
  error: { code: string; message: string };
}

type Listener<K extends keyof SpeechEngineEvents> = (
  payload: SpeechEngineEvents[K],
) => void;

export interface ScoredVoice {
  voice: SpeechSynthesisVoice;
  score: number;
  reasons: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Constants — tuned by hand for natural, professional delivery
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROSODY: SpeechProsody = {
  // Slightly under 1.0 reads as more deliberate / professional than the
  // browser default which tends to feel rushed on long technical answers.
  rate: 0.98,
  pitch: 1.0,
  volume: 1.0,
};

/** Per-language micro tweaks so the same text feels right across languages. */
const LANG_PROSODY: Record<string, Partial<SpeechProsody>> = {
  es: { rate: 1.0, pitch: 1.0 },
  en: { rate: 0.98, pitch: 1.0 },
  pt: { rate: 0.99, pitch: 1.0 },
  fr: { rate: 0.97, pitch: 1.02 },
  de: { rate: 0.95, pitch: 0.99 },
  it: { rate: 1.0, pitch: 1.01 },
};

/** Chrome/Edge silently stop after ~15s; keep chunks well under that. */
const DEFAULT_MAX_CHUNK_CHARS = 220;

/** Watchdog: if no progress for this long while "speaking", nudge the engine. */
const WATCHDOG_INTERVAL_MS = 4000;

/** Chrome bug workaround: resume() must be pinged periodically or it pauses. */
const KEEPALIVE_INTERVAL_MS = 12000;

// ────────────────────────────────────────────────────────────────────────────
// Voice quality scoring
// ────────────────────────────────────────────────────────────────────────────

/**
 * Substrings that strongly indicate a high-quality neural / premium voice.
 * These are deliberately brand markers (not country names) so we stay
 * country-agnostic and just pick the best engineering available.
 */
const PREMIUM_VOICE_MARKERS: Array<{ rx: RegExp; bonus: number; tag: string }> = [
  { rx: /\bnatural\b/i, bonus: 60, tag: "natural" },
  { rx: /\bneural\b/i, bonus: 58, tag: "neural" },
  { rx: /\bpremium\b/i, bonus: 50, tag: "premium" },
  { rx: /\benhanced\b/i, bonus: 45, tag: "enhanced" },
  { rx: /\bonline\b/i, bonus: 30, tag: "online" },
  { rx: /\bgoogle\b/i, bonus: 40, tag: "google" },
  { rx: /\bmicrosoft\b/i, bonus: 22, tag: "microsoft" },
  { rx: /\bsiri\b/i, bonus: 48, tag: "siri" },
  { rx: /\b(multilingual|wavenet|studio|journey|polyglot)\b/i, bonus: 55, tag: "advanced" },
];

/** Markers of a low-quality, robotic legacy voice — penalized. */
const LEGACY_VOICE_MARKERS: Array<{ rx: RegExp; penalty: number; tag: string }> = [
  { rx: /\b(compact|eloquence|fred|albert|zarvox|trinoids|cellos|bahh|boing|bubbles|deranged|hysterical|pipe organ|whisper|bad news|good news|wobble)\b/i, penalty: 70, tag: "legacy/novelty" },
  { rx: /\b(espeak|festival|pico)\b/i, penalty: 50, tag: "open-robotic" },
];

/**
 * Score a single voice for a target language. Higher is better. The scoring is
 * intentionally explainable — every component appends a reason — so behaviour
 * can be debugged and unit tested deterministically.
 */
export function scoreVoice(
  voice: SpeechSynthesisVoice,
  targetLang: string,
): ScoredVoice {
  const reasons: string[] = [];
  let score = 0;

  const voiceLang = (voice.lang || "").toLowerCase().replace("_", "-");
  const base = targetLang.toLowerCase().split("-")[0];

  // Language match is the dominant factor.
  if (voiceLang === targetLang.toLowerCase()) {
    score += 100;
    reasons.push("exact-locale");
  } else if (voiceLang.split("-")[0] === base) {
    score += 80;
    reasons.push("language-match");
  } else if (voiceLang.startsWith("en")) {
    // English is the safest universal fallback for technical content.
    score += 12;
    reasons.push("english-fallback");
  } else {
    score -= 40;
    reasons.push("language-mismatch");
  }

  // Local voices are lower-latency and never fail offline; nudge them up a
  // touch, but not enough to beat a clearly premium remote voice.
  if (voice.localService) {
    score += 6;
    reasons.push("local-service");
  }

  // Default platform voice gets a tiny nudge as a sane tiebreak.
  if (voice.default) {
    score += 4;
    reasons.push("platform-default");
  }

  const name = voice.name || "";
  for (const { rx, bonus, tag } of PREMIUM_VOICE_MARKERS) {
    if (rx.test(name)) {
      score += bonus;
      reasons.push(`+${tag}`);
    }
  }
  for (const { rx, penalty, tag } of LEGACY_VOICE_MARKERS) {
    if (rx.test(name)) {
      score -= penalty;
      reasons.push(`-${tag}`);
    }
  }

  return { voice, score, reasons };
}

/**
 * Rank all voices for a language and return them best-first. Stable sort keeps
 * platform ordering as the final tiebreak so results are deterministic.
 */
export function rankVoices(
  voices: SpeechSynthesisVoice[],
  targetLang: string,
): ScoredVoice[] {
  return voices
    .map((v, i) => ({ scored: scoreVoice(v, targetLang), i }))
    .sort((a, b) => b.scored.score - a.scored.score || a.i - b.i)
    .map((x) => x.scored);
}

// ────────────────────────────────────────────────────────────────────────────
// Language detection — fast, allocation-light heuristic (no network)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Stopword fingerprints per language. Detection counts weighted hits of these
 * short, high-frequency tokens. This is robust for the conversational/technical
 * text this engine reads and costs microseconds.
 */
const LANG_STOPWORDS: Record<string, string[]> = {
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "por", "con", "para", "es", "se", "no", "su", "al", "lo", "como", "más", "pero", "este", "esta", "está", "tú", "usted", "porque", "también", "puede"],
  en: ["the", "of", "and", "to", "in", "is", "you", "that", "it", "he", "was", "for", "on", "are", "with", "as", "his", "they", "be", "at", "this", "have", "from", "or", "had", "but", "what", "can", "your", "which"],
  pt: ["o", "a", "os", "as", "de", "que", "e", "em", "um", "uma", "por", "com", "para", "é", "se", "não", "seu", "ao", "como", "mais", "mas", "este", "esta", "está", "você", "porque", "também", "pode"],
  fr: ["le", "la", "les", "de", "que", "et", "en", "un", "une", "pour", "avec", "est", "se", "ne", "pas", "son", "au", "comme", "plus", "mais", "ce", "cette", "vous", "parce", "aussi", "peut"],
  de: ["der", "die", "das", "und", "zu", "in", "ist", "den", "von", "mit", "sich", "auf", "für", "nicht", "ein", "eine", "als", "auch", "wie", "aber", "dass", "kann", "werden", "wird"],
  it: ["il", "la", "le", "di", "che", "e", "in", "un", "una", "per", "con", "è", "si", "non", "suo", "al", "come", "più", "ma", "questo", "questa", "anche", "può", "perché"],
};

/** Diacritic / character-class hints that disambiguate close languages. */
const LANG_CHAR_HINTS: Array<{ lang: string; rx: RegExp; weight: number }> = [
  { lang: "es", rx: /[¿¡ñ]/g, weight: 3 },
  { lang: "pt", rx: /[ãõ]|ç/g, weight: 3 },
  { lang: "fr", rx: /[àâçéèêëîïôûùü]/g, weight: 1 },
  { lang: "de", rx: /[äöüß]/g, weight: 3 },
  { lang: "it", rx: /\b(gli|della|degli|nell|sull)\b/gi, weight: 2 },
];

const SUPPORTED_DETECT_LANGS: SupportedLanguage[] = ["es", "en", "pt", "fr", "de", "it"];

/**
 * Detect the dominant language of `text`. Returns a 2-letter code, defaulting
 * to "en" when the signal is too weak (e.g. a bare code snippet or number).
 */
export function detectLanguage(text: string): SupportedLanguage {
  const sample = (text || "").slice(0, 4000).toLowerCase();
  if (!sample.trim()) return "en";

  const tokens = sample.match(/[a-zà-ÿñ]+/gi) || [];
  if (tokens.length === 0) return "en";

  const scores: Record<string, number> = { es: 0, en: 0, pt: 0, fr: 0, de: 0, it: 0 };

  // Stopword frequency, weighted by how distinctive each hit is.
  const stopSets: Record<string, Set<string>> = {};
  for (const lang of SUPPORTED_DETECT_LANGS) {
    stopSets[lang] = new Set(LANG_STOPWORDS[lang]);
  }
  for (const tok of tokens) {
    for (const lang of SUPPORTED_DETECT_LANGS) {
      if (stopSets[lang].has(tok)) scores[lang] += 1;
    }
  }

  // Character-class hints break ties between similar Romance languages.
  for (const hint of LANG_CHAR_HINTS) {
    const matches = sample.match(hint.rx);
    if (matches) scores[hint.lang] += matches.length * hint.weight;
  }

  // Normalize by token count so long text doesn't always win for ES/EN.
  let best: SupportedLanguage = "en";
  let bestScore = -Infinity;
  for (const lang of SUPPORTED_DETECT_LANGS) {
    const normalized = scores[lang] / Math.sqrt(tokens.length);
    if (normalized > bestScore) {
      bestScore = normalized;
      best = lang;
    }
  }

  // Too weak a signal → safe default.
  if (bestScore < 0.05) return "en";
  return best;
}

/** Map a 2-letter language to a concrete BCP-47 tag for voice matching. */
export function languageToLocale(lang: SupportedLanguage): string {
  switch (lang) {
    case "es":
      return "es-ES";
    case "en":
      return "en-US";
    case "pt":
      return "pt-BR";
    case "fr":
      return "fr-FR";
    case "de":
      return "de-DE";
    case "it":
      return "it-IT";
    default:
      return "en-US";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Text normalization — make written text sound right when spoken
// ────────────────────────────────────────────────────────────────────────────

/** Common abbreviations expanded for natural pronunciation (bilingual). */
const ABBREVIATIONS: Array<{ rx: RegExp; es: string; en: string }> = [
  { rx: /\be\.?g\.?\b/gi, es: "por ejemplo", en: "for example" },
  { rx: /\bi\.?e\.?\b/gi, es: "es decir", en: "that is" },
  { rx: /\betc\.?\b/gi, es: "etcétera", en: "et cetera" },
  { rx: /\bvs\.?\b/gi, es: "versus", en: "versus" },
  { rx: /\bapprox\.?\b/gi, es: "aproximadamente", en: "approximately" },
  { rx: /\bdept\.?\b/gi, es: "departamento", en: "department" },
  { rx: /\bp\.?ej\.?\b/gi, es: "por ejemplo", en: "for example" },
];

/** Spoken names for symbols, so "C# & .NET" doesn't read as gibberish. */
const SYMBOL_WORDS: Record<string, { es: string; en: string }> = {
  "&": { es: " y ", en: " and " },
  "%": { es: " por ciento ", en: " percent " },
  "@": { es: " arroba ", en: " at " },
  "#": { es: " almohadilla ", en: " hash " },
  "+": { es: " más ", en: " plus " },
  "=": { es: " igual a ", en: " equals " },
  "€": { es: " euros ", en: " euros " },
  $: { es: " dólares ", en: " dollars " },
  "→": { es: " lleva a ", en: " leads to " },
  "×": { es: " por ", en: " times " },
};

/**
 * Convert Markdown + technical text into clean spoken prose.
 * - Code fences become a short marker (or are kept if summarizeCode=false).
 * - Inline code, links, emphasis, headings are flattened.
 * - URLs/emails are spoken as a short human phrase, not character soup.
 * - Symbols and a few abbreviations are verbalized.
 */
export function normalizeForSpeech(
  raw: string,
  lang: SupportedLanguage,
  opts: { summarizeCode?: boolean } = {},
): string {
  if (!raw) return "";
  const isEs = lang === "es";
  const summarizeCode = opts.summarizeCode !== false;
  let t = raw;

  // 1. Code fences.
  if (summarizeCode) {
    t = t.replace(/```[\s\S]*?```/g, () =>
      isEs ? ". Bloque de código. " : ". Code block. ",
    );
  } else {
    t = t.replace(/```(\w+)?\n?/g, " ");
  }

  // 2. Inline code → drop backticks, keep the token.
  t = t.replace(/`([^`]+)`/g, "$1");

  // 3. Images ![alt](url) → just the alt text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 4. Links [label](url) → label.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // 5. Bare URLs → spoken phrase. We don't read the path char-by-char.
  t = t.replace(/https?:\/\/(www\.)?([^\s/]+)\S*/gi, (_m, _w, host) =>
    isEs ? ` enlace a ${host} ` : ` link to ${host} `,
  );

  // 6. Emails → "name at domain".
  t = t.replace(/([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})/gi, (_m, user, domain) =>
    isEs ? ` ${user} arroba ${domain} ` : ` ${user} at ${domain} `,
  );

  // 7. Headings / blockquotes / list bullets → plain text + a pause.
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, ". ");
  t = t.replace(/^\s*\d+\.\s+/gm, ". ");

  // 8. Tables → strip pipes (we can't read columns sensibly).
  t = t.replace(/\|/g, " ");
  t = t.replace(/^[\s:|-]{3,}$/gm, " ");

  // 9. Emphasis / strikethrough markers.
  t = t.replace(/(\*\*|__|\*|_|~~)/g, "");

  // 10. Abbreviations.
  for (const ab of ABBREVIATIONS) {
    t = t.replace(ab.rx, isEs ? ab.es : ab.en);
  }

  // 11. Symbols.
  for (const [sym, word] of Object.entries(SYMBOL_WORDS)) {
    t = t.split(sym).join(isEs ? word.es : word.en);
  }

  // 12. Collapse runs of punctuation that would create awkward pauses.
  t = t.replace(/([.!?]){2,}/g, "$1");
  t = t.replace(/[•►▪◦·]/g, ", ");

  // 13. Whitespace + stray markdown artifacts.
  t = t.replace(/\\([*_`~#])/g, "$1");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{2,}/g, ". ");
  t = t.replace(/\n/g, ", ");
  t = t.replace(/\s+([.,;:!?])/g, "$1");
  t = t.replace(/([.,;:!?]){2,}/g, "$1");

  return t.trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Sentence chunking — split into utterance-sized pieces at natural boundaries
// ────────────────────────────────────────────────────────────────────────────

/**
 * Split normalized text into chunks no larger than `maxChars`, preferring to
 * break at sentence terminators, then at clause boundaries, and only as a last
 * resort at a word boundary. Abbreviation-style false sentence ends ("Dr.",
 * "Sr.", numbered "1.") are avoided by a light look-around.
 */
export function chunkText(text: string, maxChars = DEFAULT_MAX_CHUNK_CHARS): string[] {
  const clean = (text || "").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // First pass: sentence segmentation. Keep the terminator with the sentence.
  const sentenceRx = /[^.!?…]+[.!?…]+(?:["'”’)\]]+)?|\S[^.!?…]*$/g;
  const rawSentences = clean.match(sentenceRx) || [clean];

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(trimmed);
    buffer = "";
  };

  for (const sentenceRaw of rawSentences) {
    const sentence = sentenceRaw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      // Sentence itself too long — flush buffer, then split this sentence.
      flush();
      chunks.push(...splitLongSentence(sentence, maxChars));
      continue;
    }

    if ((buffer + " " + sentence).trim().length > maxChars) {
      flush();
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  flush();

  return chunks.filter(Boolean);
}

/**
 * Break a single over-long sentence: prefer clause boundaries (comma, semicolon,
 * colon, dash), then fall back to greedy word packing.
 */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  const clauses = sentence.split(/(?<=[,;:—–-])\s+/);
  let buffer = "";

  const flush = () => {
    const t = buffer.trim();
    if (t) out.push(t);
    buffer = "";
  };

  for (const clause of clauses) {
    if (clause.length > maxChars) {
      flush();
      out.push(...packWords(clause, maxChars));
      continue;
    }
    if ((buffer + " " + clause).trim().length > maxChars) {
      flush();
      buffer = clause;
    } else {
      buffer = buffer ? `${buffer} ${clause}` : clause;
    }
  }
  flush();
  return out;
}

/** Last-resort greedy word packer for a clause with no internal punctuation. */
function packWords(clause: string, maxChars: number): string[] {
  const words = clause.split(/\s+/);
  const out: string[] = [];
  let buffer = "";
  for (const word of words) {
    if ((buffer + " " + word).trim().length > maxChars) {
      if (buffer) out.push(buffer.trim());
      // A single word longer than maxChars (rare) is emitted as-is.
      buffer = word;
    } else {
      buffer = buffer ? `${buffer} ${word}` : word;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Tiny typed event emitter
// ────────────────────────────────────────────────────────────────────────────

class Emitter {
  private map = new Map<keyof SpeechEngineEvents, Set<Function>>();

  on<K extends keyof SpeechEngineEvents>(event: K, fn: Listener<K>): () => void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(fn as Function);
    return () => this.off(event, fn);
  }

  off<K extends keyof SpeechEngineEvents>(event: K, fn: Listener<K>): void {
    this.map.get(event)?.delete(fn as Function);
  }

  emit<K extends keyof SpeechEngineEvents>(event: K, payload: SpeechEngineEvents[K]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as Listener<K>)(payload);
      } catch {
        /* listener errors must never break the engine */
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Voice cache — getVoices() is async-populated on Chrome via voiceschanged
// ────────────────────────────────────────────────────────────────────────────

let voiceCache: SpeechSynthesisVoice[] = [];
let voicesReady = false;
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis || null;
}

/** Is the Web Speech synthesis API available in this environment? */
export function isSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * Resolve the list of voices. On Chrome the list is empty on first call and
 * populated asynchronously via the `voiceschanged` event, so we wait (with a
 * timeout) the first time and cache the result thereafter.
 */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);

  const immediate = s.getVoices();
  if (immediate && immediate.length > 0) {
    voiceCache = immediate;
    voicesReady = true;
    return Promise.resolve(immediate);
  }
  if (voicesReady && voiceCache.length > 0) return Promise.resolve(voiceCache);
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    const finish = (list: SpeechSynthesisVoice[]) => {
      if (settled) return;
      settled = true;
      voiceCache = list;
      voicesReady = list.length > 0;
      voicesPromise = null;
      resolve(list);
    };

    const onChange = () => {
      const list = s.getVoices();
      if (list && list.length > 0) {
        s.removeEventListener("voiceschanged", onChange);
        finish(list);
      }
    };
    s.addEventListener("voiceschanged", onChange);

    // Poll as a fallback for browsers that don't fire voiceschanged reliably.
    const started = Date.now();
    const poll = window.setInterval(() => {
      const list = s.getVoices();
      if (list && list.length > 0) {
        window.clearInterval(poll);
        s.removeEventListener("voiceschanged", onChange);
        finish(list);
      } else if (Date.now() - started > timeoutMs) {
        window.clearInterval(poll);
        s.removeEventListener("voiceschanged", onChange);
        finish(s.getVoices() || []);
      }
    }, 100);
  });

  return voicesPromise;
}

/** Pick the best voice for a locale, or null when none are available. */
export function pickBestVoice(
  voices: SpeechSynthesisVoice[],
  locale: string,
  forcedURI?: string,
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (forcedURI) {
    const forced = voices.find((v) => v.voiceURI === forcedURI);
    if (forced) return forced;
  }
  const ranked = rankVoices(voices, locale);
  return ranked.length ? ranked[0].voice : voices[0];
}

// ────────────────────────────────────────────────────────────────────────────
// The engine
// ────────────────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class NaturalSpeechEngine {
  private emitter = new Emitter();
  private queue: string[] = [];
  private index = 0;
  private current: SpeechSynthesisUtterance | null = null;
  private _state: SpeechState = "idle";
  private prosody: SpeechProsody = { ...DEFAULT_PROSODY };
  private activeVoice: SpeechSynthesisVoice | null = null;
  private activeLang: SupportedLanguage = "en";
  private watchdog: number | null = null;
  private keepalive: number | null = null;
  private lastBoundaryAt = 0;
  private runToken = 0; // invalidates stale async callbacks across stop/restart

  // ── event API ──────────────────────────────────────────────────────────
  on<K extends keyof SpeechEngineEvents>(event: K, fn: Listener<K>): () => void {
    return this.emitter.on(event, fn);
  }

  get state(): SpeechState {
    return this._state;
  }

  get isActive(): boolean {
    return this._state === "speaking" || this._state === "paused" || this._state === "preparing";
  }

  get currentVoice(): SpeechSynthesisVoice | null {
    return this.activeVoice;
  }

  get detectedLanguage(): SupportedLanguage {
    return this.activeLang;
  }

  private setState(next: SpeechState): void {
    if (this._state === next) return;
    this._state = next;
    this.emitter.emit("state", next);
  }

  /**
   * Begin reading `text` aloud. Resolves immediately after kicking off the
   * first chunk; progress is reported via events. Any in-flight speech is
   * cancelled first.
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    if (!isSpeechSupported()) {
      this.emitter.emit("error", { code: "unsupported", message: "Web Speech API not available" });
      this.setState("error");
      throw new Error("Web Speech API not available");
    }

    this.cancel(); // tear down any previous run
    const token = ++this.runToken;
    this.setState("preparing");

    // Resolve language + prosody.
    const requested = options.lang && options.lang !== "auto" ? options.lang : null;
    const lang = requested || detectLanguage(text);
    this.activeLang = lang;
    const locale = languageToLocale(lang);
    this.prosody = mergeProsody(lang, options.prosody);

    // Normalize + chunk.
    const normalized = normalizeForSpeech(text, lang, { summarizeCode: options.summarizeCode });
    this.queue = chunkText(normalized, options.maxChunkChars || DEFAULT_MAX_CHUNK_CHARS);
    this.index = 0;

    if (this.queue.length === 0) {
      this.setState("idle");
      this.emitter.emit("end", undefined);
      return;
    }

    // Resolve the best voice (async on Chrome).
    const voices = await loadVoices();
    if (token !== this.runToken) return; // superseded while awaiting voices
    this.activeVoice = pickBestVoice(voices, locale, options.voiceURI);

    this.startKeepalive();
    this.speakChunk(token);
  }

  private speakChunk(token: number): void {
    const s = synth();
    if (!s || token !== this.runToken) return;
    if (this.index >= this.queue.length) {
      this.finishNaturally();
      return;
    }

    const text = this.queue[this.index];
    const utt = new SpeechSynthesisUtterance(text);
    if (this.activeVoice) {
      utt.voice = this.activeVoice;
      utt.lang = this.activeVoice.lang;
    } else {
      utt.lang = languageToLocale(this.activeLang);
    }
    utt.rate = this.prosody.rate;
    utt.pitch = this.prosody.pitch;
    utt.volume = this.prosody.volume;

    const chunkIndex = this.index;

    utt.onstart = () => {
      if (token !== this.runToken) return;
      this.setState("speaking");
      this.lastBoundaryAt = Date.now();
      this.emitter.emit("chunk", { index: chunkIndex, total: this.queue.length, text });
      this.startWatchdog(token);
    };

    utt.onboundary = (ev) => {
      if (token !== this.runToken) return;
      this.lastBoundaryAt = Date.now();
      this.emitter.emit("boundary", {
        charIndex: ev.charIndex ?? 0,
        charLength: (ev as any).charLength ?? 0,
        chunkIndex,
      });
    };

    utt.onend = () => {
      if (token !== this.runToken) return;
      this.index += 1;
      this.emitter.emit("progress", this.queue.length ? this.index / this.queue.length : 1);
      if (this.index < this.queue.length && this._state !== "paused") {
        // Small natural breath between chunks; also lets Chrome settle.
        window.setTimeout(() => this.speakChunk(token), 60);
      } else if (this.index >= this.queue.length) {
        this.finishNaturally();
      }
    };

    utt.onerror = (ev) => {
      if (token !== this.runToken) return;
      const reason = (ev as any).error || "synthesis-error";
      // "interrupted"/"canceled" are expected when the user stops; not errors.
      if (reason === "interrupted" || reason === "canceled") return;
      this.stopWatchdog();
      this.stopKeepalive();
      this.setState("error");
      this.emitter.emit("error", { code: String(reason), message: `TTS failed: ${reason}` });
    };

    this.current = utt;
    try {
      s.speak(utt);
    } catch (err: any) {
      this.setState("error");
      this.emitter.emit("error", { code: "speak-threw", message: err?.message || "speak() threw" });
    }
  }

  private finishNaturally(): void {
    this.stopWatchdog();
    this.stopKeepalive();
    this.current = null;
    this.setState("idle");
    this.emitter.emit("progress", 1);
    this.emitter.emit("end", undefined);
  }

  /** Pause playback; resumable from the same position. */
  pause(): void {
    const s = synth();
    if (!s || this._state !== "speaking") return;
    try {
      s.pause();
    } catch {
      /* ignore */
    }
    this.stopWatchdog();
    this.setState("paused");
  }

  /** Resume after pause. */
  resume(): void {
    const s = synth();
    if (!s || this._state !== "paused") return;
    try {
      s.resume();
    } catch {
      /* ignore */
    }
    this.setState("speaking");
    this.startWatchdog(this.runToken);
  }

  /** Toggle between play and pause; (re)starts from `text` if idle. */
  toggle(text?: string, options?: SpeakOptions): void {
    if (this._state === "speaking") {
      this.pause();
    } else if (this._state === "paused") {
      this.resume();
    } else if (text != null) {
      void this.speak(text, options);
    }
  }

  /** Hard stop and reset. Safe to call any time. */
  cancel(): void {
    this.runToken += 1; // invalidate pending async callbacks
    this.stopWatchdog();
    this.stopKeepalive();
    const s = synth();
    if (s) {
      try {
        s.cancel();
      } catch {
        /* ignore */
      }
    }
    this.current = null;
    this.queue = [];
    this.index = 0;
    if (this._state !== "idle" && this._state !== "error") {
      this.setState("stopped");
    }
  }

  /** Release all listeners + stop audio. Call on component unmount. */
  destroy(): void {
    this.cancel();
    this.emitter.clear();
  }

  // ── watchdog: recover from Chrome's "stuck after 15s" stall ─────────────
  private startWatchdog(token: number): void {
    this.stopWatchdog();
    this.watchdog = window.setInterval(() => {
      if (token !== this.runToken || this._state !== "speaking") return;
      const s = synth();
      if (!s) return;
      const stalled = Date.now() - this.lastBoundaryAt > WATCHDOG_INTERVAL_MS;
      // If the engine claims to be neither speaking nor pending but we think we
      // are mid-utterance, it has silently died — re-kick the current chunk.
      if (stalled && !s.speaking && !s.pending && this._state === "speaking") {
        this.speakChunk(token);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog != null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  // ── keepalive: Chrome pauses long synthesis unless pinged ───────────────
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = window.setInterval(() => {
      const s = synth();
      if (!s) return;
      if (this._state === "speaking" && s.speaking && !s.paused) {
        // The classic Chrome resume() ping. Harmless on other browsers.
        try {
          s.pause();
          s.resume();
        } catch {
          /* ignore */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive != null) {
      window.clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }
}

function mergeProsody(
  lang: SupportedLanguage,
  override?: Partial<SpeechProsody>,
): SpeechProsody {
  const langTweak = LANG_PROSODY[lang] || {};
  const merged: SpeechProsody = {
    rate: override?.rate ?? langTweak.rate ?? DEFAULT_PROSODY.rate,
    pitch: override?.pitch ?? langTweak.pitch ?? DEFAULT_PROSODY.pitch,
    volume: override?.volume ?? langTweak.volume ?? DEFAULT_PROSODY.volume,
  };
  return {
    rate: clamp(merged.rate, 0.5, 2),
    pitch: clamp(merged.pitch, 0, 2),
    volume: clamp(merged.volume, 0, 1),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Module-level singleton — one audio context for the whole app, so starting
// playback on message B automatically stops message A.
// ────────────────────────────────────────────────────────────────────────────

let singleton: NaturalSpeechEngine | null = null;

export function getNaturalSpeechEngine(): NaturalSpeechEngine {
  if (!singleton) singleton = new NaturalSpeechEngine();
  return singleton;
}

export default getNaturalSpeechEngine;
