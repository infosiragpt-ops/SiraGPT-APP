'use strict';

/**
 * ocr-quality — pure, dependency-free text checks for OCR output.
 *
 * Every function here is synchronous, deterministic and never throws on bad
 * input (null/undefined/non-strings are treated as ''). None of them logs:
 * the inputs are user content, and the OCR pipeline must never write
 * transcript or OCR text to the process log.
 *
 * What lives here
 * ---------------
 * - Unicode-aware usefulness gate. The old engine counted only
 *   [A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9], so a perfect Cyrillic, CJK, Arabic or Greek
 *   read scored 0 useful characters and was thrown away. Letters and numbers
 *   of every script count now; CJK ideographs/kana/hangul count double (one
 *   glyph carries roughly a word); short math («√2», «x²=4») is legible.
 * - Garbage gate: word plausibility (stopwords of es/en/pt/fr/it/de plus a
 *   phonotactic check), symbol density, single-letter token storms and
 *   mixed-script tokens (Latin+Cyrillic confusables).
 * - Repetition-loop detection for small VLMs that loop at temperature 0
 *   (the same line ≥4× in a row at the END of the text, or a periodic tail
 *   of ≥5 repeats); legitimate repeats in the middle (receipt items, table
 *   rows, form fields) are not loops.
 * - Agreement between two independent reads (word multiset F1 + bounded
 *   character similarity) and digit agreement (numbers one engine read must
 *   appear in the other).
 * - The `[ilegible]` / `[¿palabra?]` convention: normalisation of the many
 *   spellings a model emits, counting, stripping, and marking low-confidence
 *   Tesseract words instead of inventing them.
 */

const ILLEGIBLE_MARK = '[ilegible]';

// ── Script classification ────────────────────────────────────────────────

const RE_CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

// Mathematical glyphs that make a very short read legible on their own
// (√2, x²=4, ∑, ≈ 3,14). Sm covers + = < > ± × ÷ √ ∑ ∫ ≈ ≤ ≥ ∞ … but also
// | ~ ¬, which are Tesseract noise far more often than math: excluded.
const RE_MATH_SYMBOL = /(?![|~¬])[\p{Sm}^]/u;

const SCRIPT_TESTS = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['cjk', RE_CJK_CHAR],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
];

function str(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function scriptOf(ch) {
  if (!RE_LETTER_OR_NUMBER.test(ch)) return null;
  if (/\p{N}/u.test(ch)) return 'number';
  for (const [name, re] of SCRIPT_TESTS) {
    if (re.test(ch)) return name;
  }
  return 'other';
}

/**
 * Per-script character census. `letters` excludes numbers; `dominant` is the
 * letter script with the most characters (null when there are no letters).
 */
function scriptProfile(text) {
  const counts = {
    latin: 0, cyrillic: 0, greek: 0, arabic: 0, hebrew: 0, cjk: 0,
    devanagari: 0, thai: 0, other: 0, number: 0,
  };
  let math = 0;
  let punctuation = 0;
  let symbols = 0;
  let nonSpace = 0;
  for (const ch of str(text)) {
    if (/\s/u.test(ch)) continue;
    nonSpace += 1;
    const script = scriptOf(ch);
    if (script) {
      counts[script] += 1;
      continue;
    }
    if (RE_MATH_SYMBOL.test(ch)) math += 1;
    else if (/\p{P}/u.test(ch)) punctuation += 1;
    else if (/\p{S}/u.test(ch)) symbols += 1;
  }
  let dominant = null;
  let best = 0;
  for (const [name] of SCRIPT_TESTS) {
    if (counts[name] > best) { best = counts[name]; dominant = name; }
  }
  if (!dominant && counts.other > 0) dominant = 'other';
  const letters = nonSpace - counts.number - math - punctuation - symbols;
  return { counts, letters, numbers: counts.number, math, punctuation, symbols, nonSpace, dominant };
}

/**
 * Useful characters: letters and numbers of ANY script, CJK weighted ×2.
 * This is the count compared against OCR_MIN_USEFUL_CHARS. Implemented with
 * one native `replace` per class (no per-char loop, no match array) because
 * it also runs over multi-megabyte PDF transcriptions.
 */
const RE_NOT_LETTER_OR_NUMBER_G = /[^\p{L}\p{N}]+/gu;
const RE_NOT_CJK_G = /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const RE_NOT_MATH_G = /[^\p{Sm}^]+|[|~¬]/gu;

function usefulCharCount(text) {
  const source = str(text);
  if (!source) return 0;
  const useful = source.replace(RE_NOT_LETTER_OR_NUMBER_G, '').length;
  if (useful === 0) return 0;
  return useful + source.replace(RE_NOT_CJK_G, '').length;
}

function mathSymbolCount(text) {
  const source = str(text);
  return source ? source.replace(RE_NOT_MATH_G, '').length : 0;
}

/**
 * A short read is still legible when it carries at least `minChars` useful
 * characters, or when it is math: one math symbol plus anything that makes
 * at least two meaningful glyphs («√2», «x²», «π»).
 */
function isLegibleShort({ usefulChars = 0, mathSymbols = 0 } = {}, minChars = 3) {
  const useful = Number(usefulChars) || 0;
  const math = Number(mathSymbols) || 0;
  if (useful >= Math.max(1, minChars)) return true;
  return math >= 1 && useful >= 1 && useful + math >= 2;
}

// ── Word plausibility ─────────────────────────────────────────────────────

const STOPWORDS = new Set(`
de la que el en y a los se del las un por con no una su para es al lo como más mas o pero sus le ha me si sin sobre este ya entre
cuando todo esta ser son dos también tambien fue había habia era muy años hasta desde está mi porque qué sólo solo han yo hay vez
puede todos así asi nos ni parte tiene él uno donde bien tiempo mismo ese ahora cada e vida otro después despues te otros aunque esa
eso hace otra durante siempre día dia tanto ella tres sí dijo sido gran según segun menos antes estado contra sino forma caso nada hacer
estaba poco estos mayor ante unos les algo hacia ellos hecho mucho mientras además ademas quien esto están estan pues hoy lugar mejor
nuevo decir algunos entonces todas días dias debe cómo casi toda tal luego medio va estas sea nunca aquí aqui ver usted ustedes
nuestro nuestra nosotros mí tu tú allí alli eran estar unas través mis modo algunas todavía esos muchas alguna dar don da cual cuál
the of and to in a is that for it as was with be by on not he i this are or his from at which but have an they you were her she there
been one all we their has would when if so no will my more can who what about out up them some could other into its then two time
only do may than these any like also our after first well new just over how most me should because each where those such very did
your much made many before through back years must where while does here between both under never same another being us
um uma os as em por para com não nao que se na no da do das dos ao aos pelo pela pelos pelas mais mas foi são sao ser está esta
também tambem já ja muito há ha sua seu suas seus ele ela eles elas isso este esta quando onde como sobre entre até ate depois sem
le les des du un une et est dans en pour pas qui que sur au aux avec ce cette ces il elle ils elles sont été ete ont fait plus par ne
se sa son ses leur leurs nous vous mais ou où comme tout tous très tres bien aussi être etre avoir
il lo gli i una uno di da in con su per tra fra che non è e sono come più anche ma questo questa del della dei delle nel nella
der die das und ist im zu den von mit sich des auf für fur nicht ein eine als auch es an er hat aus bei wie dem nach wird sind
oder um noch zum zur so wenn nur kann über uber
`.split(/\s+/).filter(Boolean));

const LATIN_VOWEL_RE = /[aeiouyáéíóúàèìòùâêîôûäëïöüãõåæøœāēīōū]/u;
const LATIN_CONSONANT_RUN_RE = /[bcdfghjklmnñpqrstvwxzß]{6,}/u;
const TRIPLE_LETTER_RE = /(\p{L})\1\1/u;
const SINGLE_LETTER_WORDS = new Set(['a', 'e', 'o', 'u', 'y', 'i', 'à', 'é', 'ó']);

function stripTokenEdges(token) {
  return token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

/**
 * Is this Latin token shaped like a real word? Not a dictionary lookup — a
 * phonotactic sanity check that real words in es/en/pt/fr/it/de pass and
 * Tesseract noise («IIl», «rnmw», «tHe», «aaaa», «xqzpt») fails.
 */
function isPlausibleLatinWord(raw) {
  const token = stripTokenEdges(str(raw));
  if (!token) return false;
  if (!/^\p{Script=Latin}+$/u.test(token)) return false;
  const lower = token.toLowerCase();
  const isUpper = token === token.toUpperCase();
  const isCapitalized = token[0] === token[0].toUpperCase() && token.slice(1) === token.slice(1).toLowerCase();
  const isLower = token === lower;
  if (!isUpper && !isCapitalized && !isLower) return false; // «tHe», «aBc»
  if (STOPWORDS.has(lower)) return true;
  if (token.length === 1) return SINGLE_LETTER_WORDS.has(lower) || token === 'I';
  if (token.length > 30) return false;
  if (TRIPLE_LETTER_RE.test(lower)) return false;
  if (isUpper && token.length <= 5) return true; // acronyms: DNI, PDF, SRL, UPN
  if (!LATIN_VOWEL_RE.test(lower)) return false;
  if (LATIN_CONSONANT_RUN_RE.test(lower)) return false;
  if (lower.length >= 4) {
    let vowels = 0;
    for (const ch of lower) if (LATIN_VOWEL_RE.test(ch)) vowels += 1;
    const ratio = vowels / [...lower].length;
    if (ratio < 0.1 || ratio > 0.85) return false;
  }
  return true;
}

function latinWordTokens(text, cap = 200_000) {
  const sample = str(text).slice(0, cap);
  const tokens = [];
  for (const rawToken of sample.split(/\s+/u)) {
    if (!rawToken) continue;
    for (const part of rawToken.split(/[-'’]/u)) {
      const token = stripTokenEdges(part);
      if (token && /^\p{L}+$/u.test(token) && /\p{Script=Latin}/u.test(token)) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Share of Latin word tokens that are dictionary-valid (a known function
 * word of es/en/pt/fr/it/de, or a plausibly shaped word). Returns null when
 * there are fewer than `minTokens` Latin words: not enough evidence to judge
 * (short reads, numbers-only, or non-Latin scripts are never penalised).
 */
function dictionaryWordRatio(text, { minTokens = 6 } = {}) {
  const tokens = latinWordTokens(text);
  if (tokens.length < minTokens) return null;
  let valid = 0;
  for (const token of tokens) if (isPlausibleLatinWord(token)) valid += 1;
  return valid / tokens.length;
}

function stopwordRatio(text, { minTokens = 6 } = {}) {
  const tokens = latinWordTokens(text);
  if (tokens.length < minTokens) return null;
  let hits = 0;
  for (const token of tokens) if (STOPWORDS.has(token.toLowerCase())) hits += 1;
  return hits / tokens.length;
}

// ── Repetition loops ──────────────────────────────────────────────────────

function hasLetterOrDigit(value) {
  return RE_LETTER_OR_NUMBER.test(str(value));
}

// Markdown table structure (what VLMs and the cloud OCR prompt emit).
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/u.test(str(line));
}

function isTableSeparator(line) {
  const text = str(line);
  return text.includes('|') && /^[\s|:-]+$/u.test(text) && /-{3,}/u.test(text);
}

const FILL_RUN_RE = /[_…·]{3,}|\.{3,}|-{4,}|={4,}/u;
const FILL_CHAR_RE = /[_…·.\-=]/u;

/**
 * A form field or leader line («Firma: ________», «Fecha: ..........»):
 * a run of fill characters that makes up a good share of the line. Forms
 * repeat these legitimately, so they never count as a loop.
 */
function isFormFieldLine(line) {
  const text = str(line);
  if (!FILL_RUN_RE.test(text)) return false;
  let fill = 0;
  let nonSpace = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    nonSpace += 1;
    if (FILL_CHAR_RE.test(ch)) fill += 1;
  }
  return nonSpace > 0 && fill / nonSpace >= 0.25;
}

function linesOfUnit(unit) {
  // Rotate the periodic unit so it starts at a line boundary, then list its
  // non-blank lines.
  const k = unit.indexOf('\n');
  if (k < 0) return null;
  const rotated = unit.slice(k + 1) + unit.slice(0, k + 1);
  return rotated.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Detect the repetition loop small VLMs fall into at temperature 0.
 *
 * Two shapes:
 *  - `line`: the same non-trivial line (≥3 letters) repeated in a row
 *    (blank lines between copies ignored). A run that reaches the END of the
 *    text (a last copy cut mid-line included) is the signature of a model
 *    looping until num_predict: `minLineRepeats` (4) copies are enough, or
 *    `minTableRowRepeats` (8) for Markdown table rows. A run in the MIDDLE
 *    of the text is legitimate content (receipt items, identical rows)
 *    unless it is long (`minMidLineRepeats`, 8) AND covers at least
 *    `midLineShare` (half) of the non-blank lines; even then the text after
 *    the run is kept. Form-field / leader lines («Firma: ______») never count.
 *  - `tail`: the text ends in a periodic run — a unit of 1…`maxPeriod`
 *    characters repeated `minTailRepeats` times or more — typical of a model
 *    that kept emitting the same phrase until num_predict. Units made only of
 *    table rows need `minTableRowRepeats`; units made only of form fields,
 *    or without any letter or digit (dot leaders, table rules), never count.
 *
 * Returns { looping, kind, repeats, unitLength, start, position, kept }
 * where `kept` is the text without the extra copies (the text before the
 * loop plus ONE copy of the repeated unit, and for a mid-text run the text
 * after it), so the caller can keep the legible read instead of discarding.
 */
function detectRepetitionLoop(text, {
  minLineRepeats = 4,
  minLineLetters = 3,
  minTableRowRepeats = 8,
  minMidLineRepeats = 8,
  midLineShare = 0.5,
  minTailRepeats = 5,
  minTailChars = 40,
  maxPeriod = 300,
  maxScanChars = 60_000,
} = {}) {
  const none = { looping: false, kind: null, repeats: 0, unitLength: 0, start: -1, position: null, kept: str(text) };
  const source = str(text);
  if (!source.trim()) return none;

  // 1) runs of identical lines
  const items = [];
  let offset = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line) items.push({ text: line, start: offset, end: offset + rawLine.length });
    offset += rawLine.length + 1;
  }
  for (let i = 0; i < items.length;) {
    let j = i + 1;
    while (j < items.length && items[j].text === items[i].text) j += 1;
    const count = j - i;
    const line = items[i].text;
    let reachesEnd = j === items.length;
    if (!reachesEnd && j === items.length - 1 && count >= 2) {
      // The last copy cut mid-line by the token limit.
      const last = items[j].text;
      if (last.length < line.length && line.startsWith(last)) reachesEnd = true;
    }
    const letters = (line.match(/\p{L}/gu) || []).length;
    if (count >= 2 && letters >= minLineLetters && !isFormFieldLine(line)) {
      const needAtEnd = isTableRow(line) ? minTableRowRepeats : minLineRepeats;
      const atEnd = reachesEnd && count >= needAtEnd;
      const middle = !atEnd && count >= minMidLineRepeats && count / items.length >= midLineShare;
      if (atEnd || middle) {
        const head = source.slice(0, items[i].end);
        return {
          looping: true,
          kind: 'line',
          repeats: count,
          unitLength: line.length,
          start: items[i].start,
          position: atEnd ? 'end' : 'middle',
          kept: atEnd
            ? head.replace(/\s+$/u, '')
            : (head + source.slice(items[j - 1].end)).replace(/\s+$/u, ''),
        };
      }
    }
    i = j;
  }

  // 2) periodic tail
  const scanStart = Math.max(0, source.length - maxScanChars);
  const tail = source.slice(scanStart).replace(/\s+$/u, '');
  const n = tail.length;
  for (let p = 1; p <= Math.min(maxPeriod, Math.floor(n / 2)); p += 1) {
    let run = 0;
    for (let i = n - 1; i - p >= 0; i -= 1) {
      if (tail[i] === tail[i - p]) run += 1;
      else break;
    }
    // run matching chars ⇒ the last (run + p) chars are periodic with period p.
    const covered = run + p;
    const repeats = Math.floor(covered / p);
    // Very short units («jajaja», «no no no») are legitimate in chat
    // screenshots unless they run on far longer than a human would type;
    // a unit without letters (rows of zeros) needs a model-length run too.
    const unit = tail.slice(n - p);
    const unitLetters = (unit.match(/\p{L}/gu) || []).length;
    const minCovered = p <= 3 ? Math.max(200, minTailChars) : minTailChars;
    let minRepeats = unitLetters >= 2 ? minTailRepeats : Math.max(20, minTailRepeats);
    const unitLines = linesOfUnit(unit);
    if (unitLines && unitLines.length > 0) {
      if (unitLines.every(isFormFieldLine)) continue;
      if (unitLines.every((l) => isTableRow(l) || isTableSeparator(l) || isFormFieldLine(l))) {
        minRepeats = Math.max(minRepeats, minTableRowRepeats);
      }
    }
    if (repeats >= minRepeats && covered >= minCovered) {
      if (!hasLetterOrDigit(unit)) continue;
      const loopStart = n - covered;
      return {
        looping: true,
        kind: 'tail',
        repeats,
        unitLength: p,
        start: scanStart + loopStart,
        position: 'end',
        kept: (source.slice(0, scanStart) + tail.slice(0, loopStart + p)).replace(/\s+$/u, ''),
      };
    }
  }
  return none;
}

// ── Agreement between two reads ───────────────────────────────────────────

function normalizeForComparison(text) {
  return stripIllegibleMarkers(str(text))
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’´`]/gu, "'")
    .replace(/[“”«»]/gu, '"')
    .replace(/[‐-―]/gu, '-')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s*[-*•]\s+/gmu, '')
    .replace(/\|/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function comparisonTokens(text) {
  const normalized = normalizeForComparison(text);
  const tokens = [];
  for (const chunk of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    if (RE_CJK_CHAR.test(chunk)) {
      // No spaces in CJK: every ideograph/kana/hangul is its own token.
      let buffer = '';
      for (const ch of chunk) {
        if (RE_CJK_CHAR.test(ch)) {
          if (buffer) { tokens.push(buffer); buffer = ''; }
          tokens.push(ch);
        } else {
          buffer += ch;
        }
      }
      if (buffer) tokens.push(buffer);
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

function multisetIntersection(a, b) {
  const counts = new Map();
  for (const token of b) counts.set(token, (counts.get(token) || 0) + 1);
  let inter = 0;
  for (const token of a) {
    const left = counts.get(token) || 0;
    if (left > 0) { inter += 1; counts.set(token, left - 1); }
  }
  return inter;
}

/** Order-insensitive word overlap (F1 over token multisets), 0..1 or null. */
function wordAgreement(a, b) {
  const ta = comparisonTokens(a);
  const tb = comparisonTokens(b);
  if (ta.length === 0 && tb.length === 0) return null;
  if (ta.length === 0 || tb.length === 0) return 0;
  const inter = multisetIntersection(ta, tb);
  const precision = inter / tb.length;
  const recall = inter / ta.length;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

/**
 * Levenshtein distance with two rows of memory. Returns null when the DP
 * table would exceed `maxCells` (bounded CPU: 4M cells ≈ a few ms).
 */
function levenshtein(a, b, { maxCells = 4_000_000 } = {}) {
  const s = [...str(a)];
  const t = [...str(b)];
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  if (s.length * t.length > maxCells) return null;
  let prev = new Uint32Array(t.length + 1);
  let curr = new Uint32Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    const si = s[i - 1];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = si === t[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev; prev = curr; curr = swap;
  }
  return prev[t.length];
}

/** 1 − normalised edit distance on the comparison form, or null if too big. */
function charSimilarity(a, b, opts = {}) {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na && !nb) return null;
  if (!na || !nb) return 0;
  const distance = levenshtein(na, nb, opts);
  if (distance === null) return null;
  const longest = Math.max([...na].length, [...nb].length);
  return longest > 0 ? Math.max(0, 1 - distance / longest) : 1;
}

/**
 * Agreement between two independent reads of the same image. `score` blends
 * order-insensitive word overlap (robust to column order) with character
 * similarity when the texts are small enough to align; `comparable` is false
 * when either side has no tokens (an empty read agrees with nothing).
 */
function agreementScore(a, b, opts = {}) {
  const wordF1 = wordAgreement(a, b);
  const chars = charSimilarity(a, b, opts);
  const digits = digitAgreement(a, b);
  const comparable = wordF1 !== null && comparisonTokens(a).length > 0 && comparisonTokens(b).length > 0;
  let score = 0;
  if (wordF1 === null && chars === null) score = 0;
  else if (chars === null) score = wordF1 || 0;
  else if (wordF1 === null) score = chars;
  else score = 0.6 * wordF1 + 0.4 * chars;
  return { score, wordF1, charSimilarity: chars, digitAgreement: digits.score, comparable };
}

// ── Digits ────────────────────────────────────────────────────────────────

function numberTokens(text) {
  const out = [];
  const matches = stripIllegibleMarkers(str(text)).match(/\p{Nd}+(?:[.,:/-]\p{Nd}+)*/gu) || [];
  for (const raw of matches) {
    // Compare digit sequences only: «1.234,56» and «1234,56» are the same
    // number read by two engines with different separator fidelity.
    const digits = raw.replace(/\D/gu, '');
    if (digits) out.push(digits);
  }
  return out;
}

/**
 * Do the numbers of `reference` appear in `candidate`? Numbers matter more
 * than words (amounts, dates, IDs): a VLM that «fixes» a digit is worse than
 * one that drops a word. Returns { score (F1), recall, precision,
 * referenceCount, candidateCount, missing } — `missing` lists reference
 * numbers absent from the candidate (content: never log it).
 */
function digitAgreement(reference, candidate) {
  const ref = numberTokens(reference);
  const cand = numberTokens(candidate);
  if (ref.length === 0 && cand.length === 0) {
    return { score: 1, recall: 1, precision: 1, referenceCount: 0, candidateCount: 0, missing: [], comparable: false };
  }
  const inter = multisetIntersection(ref, cand);
  const recall = ref.length ? inter / ref.length : 1;
  const precision = cand.length ? inter / cand.length : 1;
  const score = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  const counts = new Map();
  for (const token of cand) counts.set(token, (counts.get(token) || 0) + 1);
  const missing = [];
  for (const token of ref) {
    const left = counts.get(token) || 0;
    if (left > 0) counts.set(token, left - 1);
    else if (missing.length < 20) missing.push(token);
  }
  return { score, recall, precision, referenceCount: ref.length, candidateCount: cand.length, missing, comparable: true };
}

// ── [ilegible] convention ─────────────────────────────────────────────────

const ILLEGIBLE_VARIANT_RE = /[[(<{]\s*(?:(?:texto|palabras?|text|word|words|fragmento)\s+)?(?:ilegibles?|illegible|unreadable|unclear|indescifrables?|no\s+legibles?|unintelligible|inintelegibles?)(?:\s*[:\-–][^\]\)>}\n]{0,40})?\s*[\])>}]/giu;
const UNCERTAIN_RE = /\[¿([^\]\n]{1,60}?)\?\]/gu;

/**
 * Unify the spellings a model or a human uses for unreadable text
 * («[illegible]», «(ilegible)», «[texto ilegible]», «[unreadable: firma]»)
 * into `[ilegible]`, and collapse runs of consecutive markers into one.
 */
function normalizeIllegibleMarkers(text) {
  return str(text)
    .replace(ILLEGIBLE_VARIANT_RE, ILLEGIBLE_MARK)
    .replace(/\[ilegible\](?:[ \t]*\[ilegible\])+/gu, ILLEGIBLE_MARK);
}

/** `[¿palabra?]`: a word the reader saw but could not confirm. */
function markUncertain(word) {
  const clean = str(word).replace(/[[\]¿?]/gu, '').trim();
  return clean ? `[¿${clean}?]` : ILLEGIBLE_MARK;
}

function countIllegible(text) {
  const source = normalizeIllegibleMarkers(text);
  const illegible = (source.match(/\[ilegible\]/gu) || []).length;
  const uncertain = (source.match(UNCERTAIN_RE) || []).length;
  return { illegible, uncertain, total: illegible + uncertain };
}

/** Remove `[ilegible]` markers and unwrap `[¿palabra?]` (for comparisons). */
function stripIllegibleMarkers(text) {
  return normalizeIllegibleMarkers(text)
    .replace(/\[ilegible\]/gu, ' ')
    .replace(UNCERTAIN_RE, '$1');
}

/** Markers / (markers + word tokens). 0 when there is nothing. */
function illegibleRatio(text) {
  const { total } = countIllegible(text);
  const words = comparisonTokens(text).length;
  return total + words > 0 ? total / (total + words) : 0;
}

/**
 * Build honest text from Tesseract words: a word under `minConfidence`
 * becomes `[ilegible]` (consecutive ones collapse into one marker); with
 * `uncertainBelow`, words under that confidence become `[¿palabra?]`.
 * `words`: [{ text, confidence (0–100), line? }] — a change of `line`
 * starts a new output line. Returns { text, illegible, uncertain, words }.
 */
function markIllegible(words, { minConfidence = 30, uncertainBelow = null } = {}) {
  const list = Array.isArray(words) ? words : [];
  const lines = [];
  let current = [];
  let currentLine = null;
  let illegible = 0;
  let uncertain = 0;
  let total = 0;
  const flush = () => {
    if (current.length) lines.push(current.join(' '));
    current = [];
  };
  for (const word of list) {
    const text = str(word && word.text).trim();
    if (!text) continue;
    total += 1;
    const line = word && word.line !== undefined ? word.line : null;
    if (currentLine !== null && line !== null && line !== currentLine) flush();
    if (line !== null) currentLine = line;
    const confidence = Number(word && word.confidence);
    const known = Number.isFinite(confidence);
    if (known && confidence < minConfidence) {
      illegible += 1;
      if (current[current.length - 1] !== ILLEGIBLE_MARK) current.push(ILLEGIBLE_MARK);
      continue;
    }
    if (known && uncertainBelow !== null && confidence < uncertainBelow && hasLetterOrDigit(text)) {
      uncertain += 1;
      current.push(markUncertain(text));
      continue;
    }
    current.push(text);
  }
  flush();
  return { text: lines.join('\n'), illegible, uncertain, words: total };
}

const PAGE_REASON_ES = {
  too_little_text: 'sin texto legible',
  empty_or_placeholder: 'sin texto legible',
  low_confidence: 'lectura poco fiable',
  local_ocr_timeout: 'tiempo agotado',
  timeout: 'tiempo agotado',
  budget: 'tiempo agotado',
  render_failed: 'no se pudo abrir la página',
  decode_failed: 'no se pudo abrir la página',
  aborted: 'lectura cancelada',
};

function pageReasonEs(reason) {
  const key = str(reason).trim();
  if (PAGE_REASON_ES[key]) return PAGE_REASON_ES[key];
  if (/timeout|tiempo/i.test(key)) return 'tiempo agotado';
  return 'sin texto legible';
}

/** `[página 3 — no legible: sin texto legible]` */
function unreadablePageMarker(page, reason) {
  return `[página ${page} — no legible: ${pageReasonEs(reason)}]`;
}

/** `[páginas 31–40 sin OCR: límite]` (or `[página 31 sin OCR: límite]`). */
function pageCapMarker(from, to, reason = 'límite') {
  const why = str(reason) || 'límite';
  if (!to || to <= from) return `[página ${from} sin OCR: ${why}]`;
  return `[páginas ${from}–${to} sin OCR: ${why}]`;
}

// ── Garbage gate ──────────────────────────────────────────────────────────

const ORDINARY_PUNCTUATION_RE = /[.,;:!?¿¡()"'«»\-–—/%°#*[\]&@$€£]/u;
const LATEX_MATH_RE = /\$\$[\s\S]{1,4000}?\$\$|\\\[[\s\S]{1,4000}?\\\]|\\\([^\n]{1,1000}?\\\)|\$[^$\n]{1,300}\$/gu;

/**
 * Odd symbols (neither math nor ordinary punctuation) over the non-space
 * characters. When the text is a Markdown table (≥2 table rows, one with a
 * letter or digit) the `|` cell borders and `:---:` separator rows are not
 * counted; a stray `|` in prose still is. LaTeX math spans and form-field
 * leaders (`____`) are skipped.
 */
function oddSymbolCensus(source) {
  const text = str(source).replace(LATEX_MATH_RE, ' ');
  const lines = text.split('\n');
  let tableRows = 0;
  let tableRowsWithContent = 0;
  for (const line of lines) {
    if (isTableSeparator(line)) tableRows += 1;
    else if (isTableRow(line)) {
      tableRows += 1;
      if (RE_LETTER_OR_NUMBER.test(line)) tableRowsWithContent += 1;
    }
  }
  const table = tableRows >= 2 && tableRowsWithContent >= 1;
  let odd = 0;
  let nonSpace = 0;
  for (const line of lines) {
    let scan = line;
    if (table) {
      if (isTableSeparator(line)) continue;
      if (isTableRow(line)) scan = line.replace(/\|/gu, ' ');
    }
    // Form-field leaders («Firma: ________») are layout, not noise.
    scan = scan.replace(/[_…·]{3,}/gu, ' ');
    for (const ch of scan) {
      if (/\s/u.test(ch)) continue;
      nonSpace += 1;
      if (/[\p{S}\p{P}]/u.test(ch) && !RE_MATH_SYMBOL.test(ch) && !ORDINARY_PUNCTUATION_RE.test(ch)) odd += 1;
    }
  }
  return { odd, nonSpace, table };
}

/**
 * One-call assessment of an OCR read. Never judges what it cannot: wordRatio
 * is null for short or non-Latin text, and only symbol storms / loops can
 * flag those.
 * Returns { usefulChars, mathSymbols, legibleShort, dominantScript,
 *   wordRatio, stopwordRatio, symbolRatio, singleLetterRatio,
 *   mixedScriptRatio, loop, garbageLikely, reasons }.
 */
function assessText(text, { minShortChars = 3 } = {}) {
  const source = str(text);
  const profile = scriptProfile(source);
  const usefulChars = usefulCharCount(source);
  const mathSymbols = profile.math;
  const reasons = [];

  const wordRatio = dictionaryWordRatio(source);
  const stopRatio = stopwordRatio(source);
  const tokens = latinWordTokens(source);
  const singleLetter = tokens.filter((t) => [...t].length === 1).length;
  const singleLetterRatio = tokens.length >= 8 ? singleLetter / tokens.length : null;

  // Garbage symbols: punctuation/symbols that are neither math nor ordinary
  // sentence punctuation. Markdown table structure and LaTeX math (both
  // emitted by VLMs on purpose) are not noise.
  const census = oddSymbolCensus(source);
  const symbolRatio = census.nonSpace > 0 ? census.odd / census.nonSpace : 0;

  let mixed = 0;
  let wordish = 0;
  for (const raw of source.split(/\s+/u)) {
    const token = stripTokenEdges(raw);
    if (!token || !/\p{L}/u.test(token)) continue;
    wordish += 1;
    const scripts = new Set();
    for (const ch of token) {
      const s = scriptOf(ch);
      if (s && s !== 'number') scripts.add(s);
    }
    if (scripts.size >= 2 && !scripts.has('cjk')) mixed += 1;
  }
  const mixedScriptRatio = wordish >= 4 ? mixed / wordish : 0;

  const loop = detectRepetitionLoop(source);

  if (wordRatio !== null && wordRatio < 0.4) reasons.push('implausible_words');
  if (census.nonSpace >= 20 && symbolRatio > 0.3) reasons.push('symbol_noise');
  if (singleLetterRatio !== null && singleLetterRatio > 0.45) reasons.push('letter_storm');
  if (mixedScriptRatio > 0.2) reasons.push('mixed_script');
  if (loop.looping) reasons.push('repetition_loop');

  return {
    usefulChars,
    mathSymbols,
    legibleShort: isLegibleShort({ usefulChars, mathSymbols }, minShortChars),
    dominantScript: profile.dominant,
    wordRatio,
    stopwordRatio: stopRatio,
    symbolRatio,
    singleLetterRatio,
    mixedScriptRatio,
    loop: { looping: loop.looping, kind: loop.kind, repeats: loop.repeats },
    garbageLikely: reasons.length > 0,
    reasons,
  };
}

module.exports = {
  ILLEGIBLE_MARK,
  scriptProfile,
  usefulCharCount,
  mathSymbolCount,
  isLegibleShort,
  isPlausibleLatinWord,
  dictionaryWordRatio,
  stopwordRatio,
  detectRepetitionLoop,
  isTableRow,
  isTableSeparator,
  isFormFieldLine,
  oddSymbolCensus,
  normalizeForComparison,
  wordAgreement,
  levenshtein,
  charSimilarity,
  agreementScore,
  digitAgreement,
  normalizeIllegibleMarkers,
  markUncertain,
  countIllegible,
  stripIllegibleMarkers,
  illegibleRatio,
  markIllegible,
  unreadablePageMarker,
  pageCapMarker,
  pageReasonEs,
  assessText,
};
