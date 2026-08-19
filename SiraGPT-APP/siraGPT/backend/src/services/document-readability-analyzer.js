'use strict';

/**
 * document-readability-analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-language readability analyzer. Computes the metrics editors and
 * publishers actually use to flag dense/unreadable prose so the model can
 * adapt its tone to the document's complexity (and warn the user when the
 * source is at PhD-thesis density).
 *
 * Coverage:
 *   - Flesch Reading Ease (English)        — 0..100, higher = easier
 *   - Flesch-Kincaid Grade Level (English) — US grade level estimate
 *   - Fernández-Huerta (Spanish)           — Spanish adaptation of Flesch RE
 *   - Szigriszt-Pazos / INFLESZ (Spanish)  — modern Spanish Flesch variant
 *   - Average sentence length (words/sentence)
 *   - Average word length (chars/word)
 *   - Lexical density (content words / total)
 *   - Polysyllabic-word ratio (≥3 syllables)
 *   - Long-word ratio (≥7 chars)
 *   - Sentence length distribution (short/medium/long buckets)
 *   - Estimated CEFR level for the dominant language (A1..C2)
 *
 * The syllable counters are intentionally heuristic (vowel-group counting
 * with language-specific tweaks). Trade-off: cheap and good enough for
 * "is this document beach-read or thesis-dense" judgements; not suitable
 * for IPA-grade phonetic analysis.
 *
 * Public API:
 *   analyzeReadability(text, opts)        → ReadabilityReport
 *   buildReadabilityForFiles(files)       → { perFile, aggregate }
 *   renderReadabilityBlock(report, opts)  → markdown string
 */

const SCAN_HEAD_BYTES = 80_000;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

// ──────────────────────────────────────────────────────────────────────────
// Tokenisers (light & language-aware)
// ──────────────────────────────────────────────────────────────────────────

function splitSentences(text) {
  // Keep abbreviations from breaking sentences ("Dr.", "Sra.", "S.A.")
  const protectedAbbrev = text
    .replace(/\b([A-Z]\.){2,}/g, (m) => m.replace(/\./g, '∙'))
    .replace(/\b(Dr|Sr|Sra|Srta|Ing|Lic|Mr|Mrs|Ms|Prof|Don|Doña|St|Mt|Av|Bvd|No|Nº|Op|Vol|Ed|Fig|Eq|Cap|Sec|Art)\./gi, '$1∙');
  const sentences = protectedAbbrev
    .split(/[.!?¡¿]+(?:\s+|$)/u)
    .map((s) => s.replace(/∙/g, '.').trim())
    .filter((s) => s.length > 0);
  return sentences;
}

function tokenizeWords(text) {
  // Letters + digits, hyphens preserved within tokens
  return (text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || []);
}

// ──────────────────────────────────────────────────────────────────────────
// Syllable counting (heuristic, language-aware)
// ──────────────────────────────────────────────────────────────────────────

function countSyllablesEnglish(word) {
  if (!word) return 0;
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return Math.max(1, w ? 1 : 0);
  // Trim silent endings
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/g, '');
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]+/g) || [];
  return Math.max(1, groups.length);
}

function countSyllablesSpanish(word) {
  if (!word) return 0;
  const w = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  // Spanish syllables ~= count of vowel groups, with diphthong adjustments
  // Strong vowels (a,e,o) form independent syllables; weak (i,u) merge with strong.
  const groups = w.match(/[aeiou]+/g) || [];
  let syllables = 0;
  for (const group of groups) {
    if (group.length === 1) syllables += 1;
    else if (group.length === 2) {
      // Diphthong vs hiatus: ai/au/ei/eu/oi/ou/ia/ie/io/iu/ua/ue/ui/uo = 1 syllable
      if (/^(ai|au|ei|eu|oi|ou|ia|ie|io|iu|ua|ue|ui|uo)$/.test(group)) syllables += 1;
      else syllables += 2;
    } else {
      // 3+ vowels: count strong ones as nuclei
      const strongs = (group.match(/[aeo]/g) || []).length;
      syllables += Math.max(1, strongs);
    }
  }
  return Math.max(1, syllables);
}

function syllableCounter(language) {
  if (language === 'es' || language === 'pt' || language === 'it') return countSyllablesSpanish;
  return countSyllablesEnglish;
}

// ──────────────────────────────────────────────────────────────────────────
// Language detection (mirrors lib/long-paste.ts but runs in node)
// ──────────────────────────────────────────────────────────────────────────

const LANG_STOPWORDS = {
  es: /\b(?:el|la|los|las|de|que|y|en|un|una|por|con|para|es|son|del|al|este|esta|como|pero|porque|cuando|donde|también|más|sin|sobre|hasta)\b/gi,
  en: /\b(?:the|of|and|to|in|a|is|that|for|on|with|as|at|by|from|this|but|not|are|or|be|have|has|was|were|will|would|can|should|which|when|where|while)\b/gi,
  pt: /\b(?:o|a|os|as|de|que|e|em|um|uma|por|com|para|é|são|do|da|dos|das|este|esta|como|mas|porque|quando|onde|também|mais|sem|sobre|até)\b/gi,
};

function detectLanguage(text) {
  const sample = text.slice(0, 4_000);
  let best = { lang: 'en', score: 0 };
  for (const [lang, re] of Object.entries(LANG_STOPWORDS)) {
    const matches = sample.match(re);
    const score = matches ? matches.length : 0;
    if (score > best.score) best = { lang, score };
  }
  return best.score >= 4 ? best.lang : 'en';
}

// ──────────────────────────────────────────────────────────────────────────
// Score computations
// ──────────────────────────────────────────────────────────────────────────

function fleschReadingEase(words, sentences, syllables) {
  if (words === 0 || sentences === 0) return 0;
  return Number((206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)).toFixed(1));
}

function fleschKincaidGrade(words, sentences, syllables) {
  if (words === 0 || sentences === 0) return 0;
  return Number((0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59).toFixed(1));
}

function fernandezHuerta(words, sentences, syllables) {
  if (words === 0 || sentences === 0) return 0;
  return Number((206.84 - 60 * (syllables / words) - 1.02 * (words / sentences)).toFixed(1));
}

function szigrisztPazos(words, sentences, syllables) {
  if (words === 0 || sentences === 0) return 0;
  return Number((206.835 - (62.3 * syllables) / words - words / sentences).toFixed(1));
}

function easeToCefrEN(ease) {
  if (ease >= 90) return 'A1 (Beginner)';
  if (ease >= 80) return 'A2 (Elementary)';
  if (ease >= 70) return 'B1 (Intermediate)';
  if (ease >= 60) return 'B2 (Upper-intermediate)';
  if (ease >= 50) return 'C1 (Advanced)';
  if (ease >= 0) return 'C2 (Proficient)';
  return 'C2+ (Highly technical)';
}

function easeToCefrES(ease) {
  if (ease >= 80) return 'A1-A2 (Muy fácil)';
  if (ease >= 70) return 'B1 (Fácil)';
  if (ease >= 60) return 'B2 (Normal)';
  if (ease >= 50) return 'C1 (Algo difícil)';
  if (ease >= 30) return 'C2 (Difícil)';
  return 'C2+ (Muy difícil)';
}

function bucketSentenceLengths(sentences) {
  const buckets = { short: 0, medium: 0, long: 0, veryLong: 0 };
  for (const s of sentences) {
    const w = tokenizeWords(s).length;
    if (w <= 10) buckets.short += 1;
    else if (w <= 20) buckets.medium += 1;
    else if (w <= 35) buckets.long += 1;
    else buckets.veryLong += 1;
  }
  return buckets;
}

// ──────────────────────────────────────────────────────────────────────────
// Public extractor
// ──────────────────────────────────────────────────────────────────────────

function analyzeReadability(text, opts = {}) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return {
      language: 'en',
      words: 0,
      sentences: 0,
      syllables: 0,
      avgWordsPerSentence: 0,
      avgCharsPerWord: 0,
      lexicalDensity: 0,
      polysyllabicRatio: 0,
      longWordRatio: 0,
      sentenceBuckets: { short: 0, medium: 0, long: 0, veryLong: 0 },
      scores: {},
      cefr: 'unknown',
      verdict: 'no-content',
    };
  }
  const head = safe.slice(0, SCAN_HEAD_BYTES);
  const language = opts.language || detectLanguage(head);
  const syllableCount = syllableCounter(language);

  const sentences = splitSentences(head);
  const words = tokenizeWords(head);
  const totalWords = words.length;
  const totalSentences = sentences.length || 1;

  let totalSyllables = 0;
  let polysyllabic = 0;
  let longWords = 0;
  for (const w of words) {
    const syl = syllableCount(w);
    totalSyllables += syl;
    if (syl >= 3) polysyllabic += 1;
    if (w.length >= 7) longWords += 1;
  }

  const avgWordsPerSentence = Number((totalWords / totalSentences).toFixed(1));
  const avgCharsPerWord = totalWords === 0 ? 0 : Number((words.reduce((acc, w) => acc + w.length, 0) / totalWords).toFixed(2));
  const polysyllabicRatio = totalWords === 0 ? 0 : Number((polysyllabic / totalWords).toFixed(3));
  const longWordRatio = totalWords === 0 ? 0 : Number((longWords / totalWords).toFixed(3));

  // Lexical density: content words (anything that is not a stopword) / total
  const stopwordRe = LANG_STOPWORDS[language] || LANG_STOPWORDS.en;
  const stopwordHits = (head.match(stopwordRe) || []).length;
  const lexicalDensity = totalWords === 0 ? 0 : Number(((totalWords - stopwordHits) / totalWords).toFixed(3));

  const scores = {};
  if (language === 'en') {
    scores.fleschReadingEase = fleschReadingEase(totalWords, totalSentences, totalSyllables);
    scores.fleschKincaidGrade = fleschKincaidGrade(totalWords, totalSentences, totalSyllables);
  } else if (language === 'es' || language === 'pt' || language === 'it') {
    scores.fernandezHuerta = fernandezHuerta(totalWords, totalSentences, totalSyllables);
    scores.szigrisztPazos = szigrisztPazos(totalWords, totalSentences, totalSyllables);
  } else {
    scores.fleschReadingEase = fleschReadingEase(totalWords, totalSentences, totalSyllables);
  }

  let cefr;
  if (language === 'es' || language === 'pt' || language === 'it') {
    cefr = easeToCefrES(scores.fernandezHuerta || scores.fleschReadingEase || 0);
  } else {
    cefr = easeToCefrEN(scores.fleschReadingEase || 0);
  }

  let verdict = 'medium';
  const ease = scores.fleschReadingEase ?? scores.fernandezHuerta ?? 50;
  if (ease >= 70) verdict = 'easy';
  else if (ease >= 50) verdict = 'medium';
  else if (ease >= 30) verdict = 'hard';
  else verdict = 'very-hard';

  return {
    language,
    words: totalWords,
    sentences: totalSentences,
    syllables: totalSyllables,
    avgWordsPerSentence,
    avgCharsPerWord,
    lexicalDensity,
    polysyllabicRatio,
    longWordRatio,
    sentenceBuckets: bucketSentenceLengths(sentences),
    scores,
    cefr,
    verdict,
  };
}

function buildReadabilityForFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const perFile = [];
  let combinedText = '';
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report: analyzeReadability(text) });
    if (combinedText.length < 64_000) combinedText += `\n${text.slice(0, 12_000)}`;
  }
  return {
    perFile,
    aggregate: analyzeReadability(combinedText),
  };
}

const VERDICT_BADGE = {
  easy: '🟢',
  medium: '🟡',
  hard: '🟠',
  'very-hard': '🔴',
  'no-content': '⚪',
};

function renderReadabilityBlock(report, opts = {}) {
  if (!report) return '';
  const aggregate = report.aggregate || report;
  if (!aggregate || aggregate.words === 0) return '';
  const lines = [];
  const title = opts.title || 'READABILITY';
  lines.push(`## ${title} ${VERDICT_BADGE[aggregate.verdict] || ''} ${aggregate.verdict.toUpperCase()}`);

  const scoreList = Object.entries(aggregate.scores).map(([k, v]) => `${k}: ${v}`).join(' · ');
  lines.push(`**Language:** ${aggregate.language} · **CEFR:** ${aggregate.cefr} · ${scoreList}`);
  lines.push(`**Words:** ${aggregate.words.toLocaleString()} · **Sentences:** ${aggregate.sentences.toLocaleString()} · **Avg words/sentence:** ${aggregate.avgWordsPerSentence} · **Avg chars/word:** ${aggregate.avgCharsPerWord} · **Polysyllabic:** ${(aggregate.polysyllabicRatio * 100).toFixed(1)}% · **Lexical density:** ${(aggregate.lexicalDensity * 100).toFixed(1)}%`);
  const b = aggregate.sentenceBuckets;
  lines.push(`**Sentence-length distribution:** short (≤10w) ${b.short} · medium (11-20) ${b.medium} · long (21-35) ${b.long} · very long (>35) ${b.veryLong}`);

  // Adaptation hint
  let hint;
  if (aggregate.verdict === 'easy') hint = 'Source is plain language. Match the tone — short sentences, concrete words, minimal jargon.';
  else if (aggregate.verdict === 'medium') hint = 'Source is mainstream prose. Mirror the register; explain acronyms and technical terms briefly when first used.';
  else if (aggregate.verdict === 'hard') hint = 'Source is dense/specialised. Quote precise terminology, but break long sentences in your reply for the user.';
  else hint = 'Source is highly technical. Quote verbatim for accuracy, then paraphrase in plain language for the reader. Use bullet structure to lower cognitive load.';
  lines.push(`**Tone hint:** ${hint}`);

  if (report.perFile && report.perFile.length > 1) {
    lines.push('### Per-file readability');
    for (const p of report.perFile) {
      const r = p.report;
      lines.push(`- **${p.file}** (${VERDICT_BADGE[r.verdict]} ${r.verdict}) — ${r.language}, ${r.words.toLocaleString()} words, ${r.cefr}`);
    }
  }
  return lines.join('\n\n');
}

module.exports = {
  analyzeReadability,
  buildReadabilityForFiles,
  renderReadabilityBlock,
  _internal: {
    splitSentences,
    tokenizeWords,
    countSyllablesEnglish,
    countSyllablesSpanish,
    detectLanguage,
    fleschReadingEase,
    fleschKincaidGrade,
    fernandezHuerta,
    szigrisztPazos,
    bucketSentenceLengths,
  },
};
