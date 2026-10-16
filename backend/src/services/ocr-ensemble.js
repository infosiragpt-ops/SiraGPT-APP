'use strict';

/**
 * ocr-ensemble — pure helpers that turn several independent OCR reads of the
 * same image into ONE honest transcription.
 *
 * Why
 * ---
 * The vision rungs used to be a «first answer wins» ladder: GLM-OCR or the
 * cloud model was stored at a fixed 95 % confidence, nothing compared it with
 * Tesseract, and a plausible-looking hallucination on a blurry photo became
 * the stored text. Here:
 *
 *  - `reconcile(candidates)` keeps the strongest read as the primary text and
 *    asks every OTHER comparable read to vote on each of its words (Myers diff
 *    over normalised word keys). A word another engine confirms stays as is; a
 *    word another engine read DIFFERENTLY and nobody confirms becomes
 *    `[¿palabra?]` — the disagreement is shown, never guessed away. Words only
 *    one engine saw (the other skipped the line) are kept: they are
 *    unconfirmed, not contradicted. Tesseract only contests numbers, or words
 *    when its overall read agreed well (its local misreads would otherwise
 *    litter good text with markers).
 *  - `calibrateConfidence` replaces the fixed 95: agreement between engines,
 *    minus penalties for loops, truncation, garbage, `[ilegible]` density and
 *    contested words.
 *  - `planBands` / `snapCutsToWhitespace` / `mergeBandTexts`: full-width
 *    horizontal bands for dense or very tall pages (the cloud APIs downscale a
 *    whole 4000-px page until small text is unreadable), cut between text
 *    lines when an ink profile is available, with the overlap de-duplicated.
 *  - `chooseGlmTask`: the GLM-OCR task prompt by image class.
 *
 * Every function is synchronous, deterministic, bounded in CPU/memory and
 * never throws. Nothing here logs (inputs are user content).
 */

const ocrQuality = require('./ocr-quality');

const DIACRITICS_RE = /\p{M}+/gu;

function str(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

// ── Tokens ────────────────────────────────────────────────────────────────

/**
 * Comparison key of one whitespace token: lowercase, accents removed, edge
 * punctuation stripped; numbers compare by their digits only («1.234,56» ≡
 * «1234,56»). Tokens without a letter or digit (|, ---, •) get '' and never
 * vote.
 */
function tokenKey(raw) {
  const core = str(raw).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!core || !/[\p{L}\p{N}]/u.test(core)) return '';
  if (/^[\p{Nd}.,:/-]+$/u.test(core)) return `#${core.replace(/\D/gu, '')}`;
  return core.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();
}

/**
 * Whitespace tokens with their offsets. `[ilegible]` / `[¿…?]` markers are
 * single structural tokens (key '') so they never vote.
 */
function tokenize(text, { maxTokens = 20_000 } = {}) {
  const source = str(text);
  const tokens = [];
  const re = /\[ilegible\]|\[¿[^\]\n]{1,60}?\?\]|\S+/gu;
  let match;
  while ((match = re.exec(source)) && tokens.length < maxTokens) {
    const raw = match[0];
    const marker = raw.startsWith('[ilegible') || raw.startsWith('[¿');
    tokens.push({ raw, start: match.index, end: match.index + raw.length, key: marker ? '' : tokenKey(raw) });
  }
  return tokens;
}

// ── Myers diff (bounded) ──────────────────────────────────────────────────

/**
 * Myers O((N+M)·D) diff over two key arrays. Returns an edit script
 * [{ op:'equal'|'delete'|'insert', a?, b? }] (indices into a / b) or null when
 * the edit distance exceeds `maxD` (the reads are too different to align;
 * memory stays O(maxD²) ints).
 */
function diffKeys(a, b, { maxD = 1500 } = {}) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, Math.max(0, maxD));
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const get = (k) => prev[k + (d - 1)];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: 'equal', a: x - 1, b: y - 1 }); x -= 1; y -= 1; }
    if (down) { ops.push({ op: 'insert', b: y - 1 }); y -= 1; } else { ops.push({ op: 'delete', a: x - 1 }); x -= 1; }
  }
  while (x > 0 && y > 0) { ops.push({ op: 'equal', a: x - 1, b: y - 1 }); x -= 1; y -= 1; }
  return ops.reverse();
}

/**
 * Per-primary-token verdict against one voter: 'confirmed' (same word),
 * 'contested' (the voter read something else in that place) or
 * 'unconfirmed' (the voter has nothing there). Null when not alignable.
 * `rivals[j]` lists the voter keys of the block that contests token j.
 */
function voteAgainst(primaryKeys, voterKeys, opts = {}) {
  const ops = diffKeys(primaryKeys, voterKeys, opts);
  if (!ops) return null;
  const verdict = new Array(primaryKeys.length).fill('unconfirmed');
  const rivals = new Array(primaryKeys.length).fill(null);
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const inserted = block.filter((o) => o.op === 'insert').map((o) => voterKeys[o.b]);
    if (inserted.length && block.some((o) => o.op === 'delete')) {
      for (const o of block) {
        if (o.op === 'delete') { verdict[o.a] = 'contested'; rivals[o.a] = inserted; }
      }
    }
    block = [];
  };
  for (const o of ops) {
    if (o.op === 'equal') { flush(); verdict[o.a] = 'confirmed'; } else block.push(o);
  }
  flush();
  verdict.rivals = rivals;
  return verdict;
}

/**
 * Tesseract misreads glyphs (0/o, l/i, c/e) far more often than it reads a
 * different word: a rival within edit ratio 0.4 of the primary word, or one
 * that is not even word-shaped, is noise and does not contest a word.
 */
function isSubstantiveRival(primaryKey, rivalKeys) {
  const list = Array.isArray(rivalKeys) ? rivalKeys : [];
  if (!list.length) return false;
  for (const rival of list) {
    const distance = ocrQuality.levenshtein(primaryKey, rival, { maxCells: 10_000 });
    const longest = Math.max([...primaryKey].length, [...rival].length) || 1;
    if (distance !== null && distance / longest <= 0.4) return false;
  }
  return list.some((rival) => ocrQuality.isPlausibleLatinWord(rival) || !/^[a-z]+$/u.test(rival));
}

// ── Reconciliation ────────────────────────────────────────────────────────

const ENGINE_KINDS = new Set(['vlm', 'glm', 'tesseract']);

/**
 * Reconcile independent reads of the same image.
 *
 * `candidates`: [{ engine, text, kind: 'vlm'|'glm'|'tesseract' }], the
 * PRIMARY (strongest, complete) read first.
 * Options: `minComparable` (0.35: below it two reads are not of the same
 * text and the weaker one does not vote), `tesseractWordFloor` (0.75: overall
 * agreement Tesseract needs before it may contest words; it always contests
 * numbers), `maxD`.
 *
 * Returns { text, engines, voters, agreement, agreements:[{engine, score,
 * comparable}], tokens, confirmed, contested, uncertainMarked,
 * contestedNumbers, conflict, primary }.
 */
function reconcile(candidates, { minComparable = 0.35, tesseractWordFloor = 0.75, maxD = 1500 } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && str(c.text).trim())
    .map((c) => ({ engine: str(c.engine) || 'ocr', kind: ENGINE_KINDS.has(c.kind) ? c.kind : 'vlm', text: str(c.text) }));
  const empty = {
    text: '', engines: [], voters: 0, agreement: null, agreements: [], tokens: 0, confirmed: 0,
    contested: 0, uncertainMarked: 0, contestedNumbers: 0, conflict: false, primary: null,
  };
  if (list.length === 0) return empty;
  const [primary, ...others] = list;
  const ptoks = tokenize(primary.text);
  const voteIdx = [];
  const pkeys = [];
  ptoks.forEach((t, i) => { if (t.key) { voteIdx.push(i); pkeys.push(t.key); } });

  const agreements = [];
  const verdicts = [];
  for (const other of others) {
    const score = ocrQuality.agreementScore(primary.text, other.text);
    const comparable = Boolean(score.comparable) && score.score >= minComparable;
    agreements.push({ engine: other.engine, kind: other.kind, score: Math.round(score.score * 1000) / 1000, comparable });
    if (!comparable) continue;
    const okeys = tokenize(other.text).map((t) => t.key).filter(Boolean);
    const verdict = voteAgainst(pkeys, okeys, { maxD });
    if (!verdict) continue;
    const wordsMayBeContested = other.kind !== 'tesseract' || score.score >= tesseractWordFloor;
    verdicts.push({ verdict, wordsMayBeContested, tesseract: other.kind === 'tesseract' });
  }

  const comparableScores = agreements.filter((a) => a.comparable).map((a) => a.score);
  const agreement = comparableScores.length
    ? comparableScores.reduce((s, x) => s + x, 0) / comparableScores.length
    : (agreements.length ? Math.max(...agreements.map((a) => a.score)) : null);
  const vlmOthers = agreements.filter((a) => a.kind !== 'tesseract');
  const conflict = vlmOthers.length > 0 && vlmOthers.every((a) => !a.comparable || a.score < 0.5);

  // Word verdicts: confirmed by anyone wins; contested by an eligible voter
  // and confirmed by nobody → uncertain.
  const uncertain = new Set();
  let confirmed = 0;
  let contestedNumbers = 0;
  for (let j = 0; j < pkeys.length; j += 1) {
    const isNumber = pkeys[j].startsWith('#');
    let yes = false;
    let contested = false;
    for (const { verdict, wordsMayBeContested, tesseract } of verdicts) {
      if (verdict[j] === 'confirmed') yes = true;
      else if (verdict[j] === 'contested') {
        if (isNumber) contested = true;
        else if (wordsMayBeContested && (!tesseract || isSubstantiveRival(pkeys[j], verdict.rivals[j]))) contested = true;
      }
    }
    if (yes) confirmed += 1;
    else if (contested) {
      uncertain.add(voteIdx[j]);
      if (isNumber) contestedNumbers += 1;
    }
  }

  const text = uncertain.size ? applyUncertainMarks(primary.text, ptoks, uncertain) : primary.text;
  return {
    text,
    engines: list.map((c) => c.engine),
    voters: 1 + verdicts.length,
    agreement: agreement === null ? null : Math.round(agreement * 1000) / 1000,
    agreements,
    tokens: pkeys.length,
    confirmed,
    contested: uncertain.size,
    uncertainMarked: uncertain.size,
    contestedNumbers,
    conflict,
    primary: primary.engine,
  };
}

/**
 * Rewrite `text` with the uncertain tokens wrapped as `[¿palabra?]`; runs of
 * consecutive uncertain tokens on one line share one marker (≤ 60 chars),
 * edge punctuation stays outside the marker.
 */
function applyUncertainMarks(text, tokens, uncertainIdx) {
  const source = str(text);
  const pieces = [];
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    if (!uncertainIdx.has(i)) { i += 1; continue; }
    let j = i;
    while (
      j + 1 < tokens.length
      && uncertainIdx.has(j + 1)
      && !source.slice(tokens[j].end, tokens[j + 1].start).includes('\n')
      && (tokens[j + 1].end - tokens[i].start) <= 60
    ) j += 1;
    const span = source.slice(tokens[i].start, tokens[j].end);
    const lead = (span.match(/^[^\p{L}\p{N}]*/u) || [''])[0];
    const trail = (span.match(/[^\p{L}\p{N}]*$/u) || [''])[0];
    const core = span.slice(lead.length, span.length - trail.length);
    pieces.push(source.slice(cursor, tokens[i].start));
    pieces.push(core ? `${lead}${ocrQuality.markUncertain(core)}${trail}` : span);
    cursor = tokens[j].end;
    i = j + 1;
  }
  pieces.push(source.slice(cursor));
  return pieces.join('');
}

// ── Confidence ────────────────────────────────────────────────────────────

const SINGLE_ENGINE_BASE = { vlm: 74, glm: 66, tesseract: 55 };

/**
 * Calibrated 0–100 confidence of a vision/ensemble read (never a fixed 95).
 * With two or more voters it starts at 50 + 47 × agreement; a single engine
 * starts at its own prior. Penalties: garbage −30, loop −20, truncated −15,
 * contested numbers −10, `[ilegible]` density (×60) and contested words (×40).
 */
function calibrateConfidence({
  agreement = null,
  voters = 1,
  kind = 'vlm',
  garbage = false,
  loop = false,
  truncated = false,
  illegibleRatio = 0,
  uncertainShare = 0,
  contestedNumbers = 0,
} = {}) {
  let score = (voters >= 2 && Number.isFinite(agreement))
    ? 50 + 47 * Math.max(0, Math.min(1, agreement))
    : (SINGLE_ENGINE_BASE[kind] || SINGLE_ENGINE_BASE.vlm);
  if (garbage) score -= 30;
  if (loop) score -= 20;
  if (truncated) score -= 15;
  if (contestedNumbers > 0) score -= 10;
  score -= Math.max(0, Math.min(1, Number(illegibleRatio) || 0)) * 60;
  score -= Math.max(0, Math.min(1, Number(uncertainShare) || 0)) * 40;
  return Math.max(5, Math.min(97, Math.round(score)));
}

/** 'alta' (≥ 85), 'media' (≥ 60), 'baja'. */
function confidenceLevel(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return null;
  if (value >= 85) return 'alta';
  if (value >= 60) return 'media';
  return 'baja';
}

// ── Engine labels (provider ids → words a person reads) ────────────────────

function engineLabel(provider) {
  const p = str(provider).toLowerCase();
  if (!p) return 'OCR';
  if (p === 'tesseract') return 'Tesseract (local)';
  if (p.startsWith('ollama:')) return /glm/.test(p) ? 'GLM-OCR (local)' : 'modelo local';
  if (p.startsWith('gemini') || p.includes('gemini')) return 'Gemini';
  if (p.startsWith('xai') || p.includes('grok')) return 'Grok';
  if (p.startsWith('openrouter')) return 'OpenRouter';
  if (p.startsWith('meta') || p.includes('muse')) return 'Meta';
  if (p.startsWith('openai') || p.includes('gpt')) return 'OpenAI';
  if (p.startsWith('anthropic') || p.includes('claude')) return 'Claude';
  if (p.startsWith('vision-doc:')) return engineLabel(p.slice('vision-doc:'.length));
  return 'OCR';
}

/** «GLM-OCR (local) + Gemini» from 'ollama:glm-ocr+gemini:gemini-3.5-flash'. */
function describeEngines(provider) {
  const labels = [];
  for (const part of str(provider).split('+')) {
    const label = engineLabel(part.trim());
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(' + ') || 'OCR';
}

// ── Bands (tiling for the vision rungs) ───────────────────────────────────

/**
 * Full-width horizontal bands for a page of `width`×`height`. A band is about
 * `width / targetAspect` tall (a landscape strip the vision APIs keep at a
 * readable scale), at most `maxBands`, overlapping by `overlap`. Returns []
 * when one band would cover the page.
 */
function planBands(width, height, { maxBands = 4, overlap = 0.06, targetAspect = 2 } = {}) {
  const w = Math.floor(Number(width) || 0);
  const h = Math.floor(Number(height) || 0);
  if (w <= 0 || h <= 0) return [];
  const bandTarget = Math.max(200, w / Math.max(0.5, targetAspect));
  // round(): a page only slightly taller than one band stays whole.
  const n = Math.max(1, Math.min(Math.max(1, Math.floor(maxBands)), Math.round(h / bandTarget)));
  if (n <= 1) return [];
  const base = h / n;
  const ov = Math.round(base * Math.max(0, Math.min(0.3, overlap)));
  const bands = [];
  for (let i = 0; i < n; i += 1) {
    const top = Math.max(0, Math.round(i * base) - (i > 0 ? ov : 0));
    const bottom = Math.min(h, Math.round((i + 1) * base) + (i < n - 1 ? ov : 0));
    bands.push({ left: 0, top, width: w, height: Math.max(1, bottom - top) });
  }
  return bands;
}

/**
 * Move each internal band boundary to the emptiest row (least ink) within
 * ±`window` of it, so cuts fall between text lines. `rowInk[y]` is the ink
 * of row y at the same scale as the bands; the overlap is kept (smaller) as
 * a safety margin. Bands are returned untouched when the profile is unusable.
 */
function snapCutsToWhitespace(bands, rowInk, { window = 0.15, keepOverlap = 0.02 } = {}) {
  if (!Array.isArray(bands) || bands.length < 2) return bands || [];
  const ink = rowInk && typeof rowInk.length === 'number' ? rowInk : null;
  if (!ink || ink.length < 10) return bands;
  const h = ink.length;
  const cuts = [];
  for (let i = 0; i < bands.length - 1; i += 1) {
    const planned = Math.round((bands[i].top + bands[i].height + bands[i + 1].top) / 2);
    const span = Math.max(4, Math.round((bands[i].height) * window));
    let best = planned;
    let bestInk = Infinity;
    for (let y = Math.max(1, planned - span); y <= Math.min(h - 2, planned + span); y += 1) {
      const value = Number(ink[y]) || 0;
      if (value < bestInk || (value === bestInk && Math.abs(y - planned) < Math.abs(best - planned))) {
        bestInk = value;
        best = y;
      }
    }
    cuts.push(best);
  }
  const width = bands[0].width;
  const out = [];
  let top = 0;
  for (let i = 0; i <= cuts.length; i += 1) {
    const bottom = i < cuts.length ? cuts[i] : h;
    const pad = Math.round((bottom - top) * keepOverlap);
    const t = Math.max(0, top - (i > 0 ? pad : 0));
    const b = Math.min(h, bottom + (i < cuts.length ? pad : 0));
    if (b - t >= 1) out.push({ left: 0, top: t, width, height: b - t });
    top = bottom;
  }
  return out.length === bands.length ? out : bands;
}

function isOnlyMarkers(line) {
  return !ocrQuality.stripIllegibleMarkers(line).replace(/[\s\p{P}]/gu, '');
}

/**
 * Same line read twice at a band seam? Exact on the comparison form, or —
 * for lines long enough to judge — near-identical with the SAME numbers
 * («línea 4» and «línea 5» are different lines).
 */
function sameSeamLine(a, b, minSimilarity) {
  const na = ocrQuality.normalizeForComparison(a);
  const nb = ocrQuality.normalizeForComparison(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) < 15) return false;
  const digits = ocrQuality.digitAgreement(a, b);
  if (digits.comparable && digits.score < 1) return false;
  const sim = ocrQuality.charSimilarity(a, b);
  return sim !== null && sim >= minSimilarity;
}

/**
 * Join band transcriptions top to bottom, dropping the lines the overlap
 * repeated (the longest run of near-identical lines at the seam) and
 * marker-only lines at a seam (a glyph cut by the band edge).
 */
function mergeBandTexts(texts, { seamLines = 6, minSimilarity = 0.82 } = {}) {
  const parts = (Array.isArray(texts) ? texts : []).map((t) => str(t).replace(/\s+$/u, ''));
  const out = [];
  for (let idx = 0; idx < parts.length; idx += 1) {
    let lines = parts[idx].split('\n');
    if (idx > 0) {
      while (lines.length && (!lines[0].trim() || isOnlyMarkers(lines[0]))) lines = lines.slice(1);
      while (out.length && (!out[out.length - 1].trim() || isOnlyMarkers(out[out.length - 1]))) out.pop();
      const tail = [];
      for (let i = out.length - 1; i >= 0 && tail.length < seamLines; i -= 1) {
        if (out[i].trim()) tail.unshift({ i, line: out[i] });
      }
      const head = lines.filter((l) => l.trim()).slice(0, seamLines);
      let drop = 0;
      for (let k = Math.min(tail.length, head.length); k >= 1; k -= 1) {
        let all = true;
        for (let q = 0; q < k; q += 1) {
          if (!sameSeamLine(tail[tail.length - k + q].line, head[q], minSimilarity)) { all = false; break; }
        }
        if (all) { drop = k; break; }
      }
      if (drop > 0) {
        // Remove the first `drop` non-blank lines (and the blanks between them).
        let removed = 0;
        const kept = [];
        for (const line of lines) {
          if (removed < drop) {
            if (line.trim()) removed += 1;
            continue;
          }
          kept.push(line);
        }
        lines = kept;
      }
    }
    out.push(...lines);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── GLM task by image class ───────────────────────────────────────────────

/**
 * GLM-OCR task prompt for an image: 'table' when the local read is mostly
 * table rows (≥ 4 lines, ≥ 60 % of them with ≥ 3 cells), 'formula' for a
 * short, math-dense read, else 'text'. The whole-page default stays 'text'
 * because a table prompt drops the prose around a table.
 */
function chooseGlmTask({ text = '', imageType = null } = {}) {
  const source = str(text);
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 4) {
    // Markdown/pipe rows, or (OCR text has its column spacing collapsed) a
    // grid of numeric columns: ≥ 3 cells of which ≥ 2 are numbers.
    const pipeRows = lines.filter((l) => ocrQuality.isTableRow(l) || l.split('|').filter((c) => c.trim()).length >= 3).length;
    if (pipeRows / lines.length >= 0.6) return 'table';
    if (lines.length >= 6) {
      const numericRows = lines.filter((l) => {
        const cells = l.split(/\s+/u).filter(Boolean);
        const numbers = cells.filter((c) => /^[$€S/.-]*\d[\d.,:%/-]*$/u.test(c)).length;
        return cells.length >= 3 && numbers >= 2;
      }).length;
      if (numericRows / lines.length >= 0.8) return 'table';
    }
  }
  const useful = ocrQuality.usefulCharCount(source);
  const math = ocrQuality.mathSymbolCount(source);
  if (lines.length > 0 && lines.length <= 8 && math >= 2 && math / Math.max(1, useful + math) >= 0.15) return 'formula';
  if (imageType === 'chart_diagram' && !source.trim()) return 'text';
  return 'text';
}

module.exports = {
  tokenKey,
  tokenize,
  diffKeys,
  voteAgainst,
  isSubstantiveRival,
  reconcile,
  applyUncertainMarks,
  calibrateConfidence,
  confidenceLevel,
  engineLabel,
  describeEngines,
  planBands,
  snapCutsToWhitespace,
  mergeBandTexts,
  chooseGlmTask,
};
