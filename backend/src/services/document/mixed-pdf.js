/**
 * Pure helpers for MIXED PDFs — documents where the embedded text layer
 * covers some pages while others are scans/photos (no text layer at all).
 *
 * The old pipeline was all-or-nothing: any text on ANY page meant the whole
 * document was treated as "has text layer" and the scanned pages silently
 * disappeared from the extraction. These helpers let fileProcessor detect
 * the low-text pages, OCR only those, and merge both sources back in page
 * order — the same strategy ChatGPT/Claude use for attached PDFs (text
 * layer + per-page image analysis).
 *
 * Text-layer QUALITY too: a page whose layer is broken (`(cid:NN)` glyphs,
 * U+FFFD, private-use glyphs, mojibake, implausible words) or only carries a
 * stamp/page number repeated on every page («Escaneado con CamScanner»,
 * «Página 3 de 10») is OCR'd like an empty one; when every page needs OCR
 * the document is treated as fully scanned (`planTextLayerOcr`). The plan is
 * bounded (per-page slice and a total budget for the expensive checks, a
 * giant page read in 128 KB steps) and `planTextLayerOcrAsync` yields to the
 * event loop, because uploads are extracted inside the web process.
 *
 * Pure functions, no I/O — unit-tested in isolation.
 */

const ocrQuality = require('../ocr-quality');

const DEFAULT_MIN_PAGE_CHARS = 25;

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function minPageChars() {
  return intFromEnv('SIRAGPT_PDF_PAGE_MIN_CHARS', DEFAULT_MIN_PAGE_CHARS);
}

function mixedOcrEnabled() {
  return process.env.SIRAGPT_PDF_MIXED_OCR !== '0';
}

function mixedOcrMaxPages() {
  return intFromEnv('SIRAGPT_PDF_MIXED_OCR_MAX_PAGES', 40);
}

/**
 * Wall-clock budget for the OCR of a mixed PDF's scanned pages (default
 * 8 min, under the 15-min async extraction budget): pages left when it runs
 * out are marked instead of making the whole extraction — text-layer pages
 * included — time out.
 */
function mixedOcrBudgetMs() {
  const value = intFromEnv('SIRAGPT_PDF_MIXED_OCR_BUDGET_MS', 8 * 60 * 1000);
  return value >= 10_000 ? value : 8 * 60 * 1000;
}

/** Text-layer quality check on (default). SIRAGPT_PDF_TEXT_LAYER_CHECK=0 restores the length-only test. */
function textLayerCheckEnabled() {
  return process.env.SIRAGPT_PDF_TEXT_LAYER_CHECK !== '0';
}

// The word and symbol checks cost ~1 µs per character: they read at most
// this much of each page (the cheap glyph checks read all of it)…
const SCORE_PAGE_SLICE = 4000;

/**
 * …and at most this many characters per document
 * (SIRAGPT_PDF_TEXT_LAYER_SCORE_MAX_CHARS, default 2 000 000 ≈ 2 s of CPU,
 * spread over the event loop by planTextLayerOcrAsync). Past it the pages
 * are sampled with a stride; the others keep the cheap checks only.
 */
function textLayerScoreMaxChars() {
  const value = intFromEnv('SIRAGPT_PDF_TEXT_LAYER_SCORE_MAX_CHARS', 2_000_000);
  return value >= SCORE_PAGE_SLICE ? value : SCORE_PAGE_SLICE;
}

// One planning step reads at most this many characters of a page: a giant
// page (a whole book without form feeds) is several steps, never one long
// synchronous slice.
const STEP_CHARS = 128 * 1024;

// ── Text-layer quality ─────────────────────────────────────────────────────

const CID_RE = /\(cid:\d+\)/g;
const REPLACEMENT_RE = /\uFFFD/g;
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g;
// UTF-8 decoded as Latin-1/CP1252: «Ã¡» (á), «Ã±» (ñ), «Â¿» (¿), «â€œ» (“).
const MOJIBAKE_RE = /Ã[\u0080-\u00BF]|Â[\u00A0-\u00BF]|â€[\u0080-\u00BF\u2018-\u201E\u2122\u0153\u017E\u0178]/g;

function matchLength(text, re, into = { total: 0, count: 0 }) {
  for (const m of String(text).matchAll(re)) { into.total += m[0].length; into.count += 1; }
  return into;
}

// From this share of its glyphs on (scoreTextLayerPage's glyphCodeShare),
// a layer is glyph codes, not text.
const GLYPH_CODE_LAYER_SHARE = 0.5;
const PRIVATE_USE_ANY_RE = /[\uE000-\uF8FF]/;

/** Any glyph code at all? (native scans: ordinary text skips the census). */
function hasGlyphCodes(text) {
  return text.includes('(cid:') || text.includes('\uFFFD') || PRIVATE_USE_ANY_RE.test(text);
}

/**
 * End of the census chunk that starts at `start`: STEP_CHARS on, moved just
 * past the next ASCII space or newline — none of the glyph patterns contains
 * one, so no match is split between two chunks.
 */
function censusChunkEnd(source, start) {
  const end = start + STEP_CHARS;
  if (end >= source.length) return source.length;
  const gap = /[ \n]/.exec(source.slice(end, end + 256));
  return gap ? end + gap.index + 1 : end;
}

// Reasons only the word/symbol checks (the budgeted, `deep` ones) can give.
const DEEP_REASONS = new Set(['implausible_words', 'symbol_noise', 'letter_storm']);

function* scoreSteps(text, { deep = true } = {}) {
  const source = String(text || '');
  // The glyph census reads the whole page, one STEP_CHARS chunk per step.
  let nonSpace = 0;
  const cid = { total: 0, count: 0 };
  const fffd = { total: 0, count: 0 };
  const pua = { total: 0, count: 0 };
  const moji = { total: 0, count: 0 };
  for (let start = 0; start < source.length;) {
    const end = censusChunkEnd(source, start);
    const chunk = start === 0 && end === source.length ? source : source.slice(start, end);
    nonSpace += chunk.replace(/\s+/g, '').length;
    matchLength(chunk, CID_RE, cid);
    matchLength(chunk, REPLACEMENT_RE, fffd);
    matchLength(chunk, PRIVATE_USE_RE, pua);
    matchLength(chunk, MOJIBAKE_RE, moji);
    start = end;
    if (start < source.length) yield;
  }
  const result = { chars: nonSpace, garbled: false, reasons: [], cidRatio: 0, replacementRatio: 0, privateUseRatio: 0, glyphCodeShare: 0, wordRatio: null };
  if (nonSpace === 0) return result;
  result.cidRatio = cid.total / nonSpace;
  // Each (cid:NN), U+FFFD or private-use glyph is one glyph with no text.
  result.glyphCodeShare = (cid.count + fffd.count + pua.count) / (nonSpace - cid.total + cid.count);
  result.replacementRatio = fffd.count / nonSpace;
  result.privateUseRatio = pua.count / nonSpace;
  if (cid.count >= 3 && result.cidRatio > 0.05) result.reasons.push('cid_glyphs');
  if (fffd.count >= 3 && result.replacementRatio > 0.02) result.reasons.push('replacement_chars');
  if (pua.count >= 3 && result.privateUseRatio > 0.05) result.reasons.push('private_use_glyphs');
  if (moji.count >= 3 && moji.total / nonSpace > 0.02) result.reasons.push('mojibake');
  if (!deep) {
    result.garbled = result.reasons.length > 0;
    return result;
  }
  const sample = source.length > SCORE_PAGE_SLICE ? source.slice(0, SCORE_PAGE_SLICE) : source;
  const clean = sample.replace(CID_RE, ' ').replace(PRIVATE_USE_RE, ' ').replace(REPLACEMENT_RE, ' ');
  result.wordRatio = ocrQuality.dictionaryWordRatio(clean, { minTokens: 20 });
  if (result.wordRatio !== null && result.wordRatio < 0.25) result.reasons.push('implausible_words');
  if (clean.replace(/\s+/g, '').length >= 40) {
    const assessment = ocrQuality.assessText(clean);
    if (assessment.symbolRatio > 0.35) result.reasons.push('symbol_noise');
    if (assessment.singleLetterRatio !== null && assessment.singleLetterRatio > 0.6) result.reasons.push('letter_storm');
  }
  result.garbled = result.reasons.length > 0;
  return result;
}

/**
 * Is this page's text layer broken? Returns { chars, garbled, reasons,
 * cidRatio, replacementRatio, privateUseRatio, glyphCodeShare (the share of
 * its glyphs that are codes: about 1 for a broken-font page), wordRatio }. Conservative on
 * purpose: numeric tables, code and short pages are never called garbled by
 * the word check (it needs ≥ 20 Latin words and < 25 % plausible ones).
 * The glyph checks read the whole page; the word/symbol checks read its
 * first SCORE_PAGE_SLICE characters, and none at all with `deep: false`.
 */
function scoreTextLayerPage(text, opts = {}) {
  return runSync(scoreSteps(text, opts));
}

// «Hoja 3», «Folio 34» are page counters too (scans, notarial copies).
const PAGE_NUMBER_LINE_RE = /^(?:[-–—\s]*#[-–—\s]*|p[aá]g(?:ina)?\.?\s*#(?:\s*(?:de|of|\/)\s*#)?|page\s*#(?:\s*(?:of|\/)\s*#)?|(?:hoja|folio)\s*#(?:\s*(?:de|\/)\s*#)?|#\s*(?:de|of|\/)\s*#)$/i;

/**
 * A text-layer line as compared across pages: lowercase, whitespace
 * collapsed. Digits are KEPT: on short form PDFs the data lines («Nota final:
 * 10» / «Nota final: 14», amounts, dates, IDs) differ only in their numbers,
 * and those numbers are the content. Only page-number lines are compared
 * with their digits normalised (isPageNumberLine).
 */
function normalizeLayerLine(line) {
  return String(line || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** «Página 3 de 10», «- 4 -», «Page 2 of 9», «3/10». */
function isPageNumberLine(line) {
  const n = normalizeLayerLine(line).replace(/\d+/g, '#');
  return Boolean(n) && PAGE_NUMBER_LINE_RE.test(n);
}

// Headers, footers and stamps are short lines; a full sentence repeated
// across pages is content (a form, a repeated clause), never boilerplate.
const MAX_BOILERPLATE_LINE = 80;
// A raw line longer than this can never collapse to a ≤ 80-char line, even
// with `-layout` padding: it is skipped before it is normalised.
const MAX_RAW_LAYER_LINE = 4096;

/** Each line of `text` to `visit`, with a step (yield) every STEP_CHARS characters. */
function* eachLine(text, visit) {
  const source = String(text || '');
  let start = 0;
  let sinceStep = 0;
  for (;;) {
    const cut = source.indexOf('\n', start);
    const end = cut === -1 ? source.length : cut;
    visit(source.slice(start, end));
    if (cut === -1) return;
    sinceStep += end - start + 1;
    start = cut + 1;
    if (sinceStep >= STEP_CHARS) {
      sinceStep = 0;
      yield;
    }
  }
}

/** Count every short line once per page (a generator: one step per page or STEP_CHARS). */
function* countLayerLines(list, counts) {
  for (const p of list) {
    const seen = new Set();
    yield* eachLine(p.text, (line) => {
      if (line.length > MAX_RAW_LAYER_LINE) return;
      const n = normalizeLayerLine(line);
      if (n.length < 2 || n.length > MAX_BOILERPLATE_LINE || seen.has(n)) return;
      seen.add(n);
      counts.set(n, (counts.get(n) || 0) + 1);
    });
    yield;
  }
}

function boilerplateFromCounts(counts, pageCount) {
  const out = new Set();
  const threshold = Math.max(2, Math.ceil(pageCount * 0.6));
  for (const [line, count] of counts) if (count >= threshold) out.add(line);
  return out;
}

function runSync(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Drain a planning generator, yielding to the event loop (setImmediate)
 * every `everyPages` steps or `sliceMs` of work, whichever comes first.
 */
async function runYielding(steps, { everyPages = 20, sliceMs = 10 } = {}) {
  let sliceStart = Date.now();
  let count = 0;
  let step = steps.next();
  while (!step.done) {
    count += 1;
    if (count >= everyPages || Date.now() - sliceStart >= sliceMs) {
      await new Promise((resolve) => setImmediate(resolve));
      count = 0;
      sliceStart = Date.now();
    }
    step = steps.next();
  }
  return step.value;
}

/**
 * Lines repeated VERBATIM on most pages (≥ 2 pages and ≥ 60 % of them):
 * headers, footers, scanner stamps (≤ 80 chars). Lines that differ in their
 * numbers are different lines (form data); page numbers are recognised by
 * isPageNumberLine instead.
 */
function boilerplateLines(pages = []) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && Number.isInteger(p.page));
  if (list.length < 2) return new Set();
  const counts = new Map();
  runSync(countLayerLines(list, counts));
  return boilerplateFromCounts(counts, list.length);
}

/**
 * A short page's lines outside boilerplate and page numbers: { chars, lines
 * (normalised), template (the page also carries a boilerplate line),
 * templateChars }.
 */
function residualOf(text, boilerplate = new Set()) {
  const out = { chars: 0, lines: [], template: false, templateChars: 0 };
  for (const line of String(text || '').split('\n')) {
    const n = normalizeLayerLine(line);
    if (!n || isPageNumberLine(n)) continue;
    if (boilerplate.has(n)) {
      out.template = true;
      out.templateChars += line.trim().length;
      continue;
    }
    out.chars += line.trim().length;
    out.lines.push(n);
  }
  return out;
}

/** Characters of a page outside boilerplate and page-number lines. */
function residualChars(text, boilerplate = new Set()) {
  return residualOf(text, boilerplate).chars;
}

// A word of three letters or more (a name, a course): counters, dates,
// file names like «scan_0001.jpg» compared without their digits are not.
const WORD_RUN_RE = /\p{L}{3,}/u;

const isMergeDataItem = (item) => item.template && item.lines.some((l) => WORD_RUN_RE.test(l));
const mergeSignature = (item) => item.lines.map((l) => l.replace(/\d+/g, '#')).join('\n');

/**
 * Merge or form data, not a stamp: a mail-merge PDF (one certificate per
 * page, the same template and a different name) leaves a short residual on
 * every page, but that residual is DIFFERENT on most of them. `items` are
 * { residual lines, template } per templated page. True when at least half
 * of them (and ≥ 2) carry a word on top of a shared template, and those
 * residuals — compared without their digits — are mostly unique.
 *
 * Trade-off, on purpose: a residual that differs ONLY in its digits is never
 * merge data. A scanner's counter, timestamp or file name looks exactly like
 * a receipt number, and calling a scan «text» loses the whole page, while a
 * digital receipt read by OCR keeps its content (and a partial OCR splices
 * its layer back: spliceTextLayerIntoOcr).
 *
 * `duplicates`: how many items may be the second (third…) part of a page
 * already counted (pdf-parse blocks beyond one per page). The data items
 * then stand for at least `data − duplicates` pages, and only those pages
 * count towards the share: the halves of ONE page are never two pages.
 */
function looksLikeMergeData(items = [], { total = items.length, duplicates = 0 } = {}) {
  const data = items.filter(isMergeDataItem);
  const dataPages = data.length - Math.max(0, duplicates);
  if (dataPages < 2 || dataPages < Math.ceil(total * 0.5)) return false;
  const signatures = new Set(data.map(mergeSignature));
  return signatures.size >= Math.max(2, Math.ceil(data.length * 0.5));
}

/**
 * The stamp candidates that are merge data, page by page. The document must
 * look like a merge (looksLikeMergeData over the thin pages AND their
 * templated `siblings` — the same form, over 200 chars only because of
 * `-layout` padding or a longer name — with `total` the document's page
 * count, so most of its pages are the form), and the candidate's own residual
 * must carry a word and be unique among them. A candidate left with the
 * template alone (a scanned insert carrying the footer) stays a stamp.
 */
function mergeDataPages(candidates, siblings, { total }) {
  const items = candidates.concat(siblings);
  const pages = new Set();
  if (!looksLikeMergeData(items, { total })) return pages;
  const seen = new Map();
  for (const item of items.filter(isMergeDataItem)) {
    const signature = mergeSignature(item);
    seen.set(signature, (seen.get(signature) || 0) + 1);
  }
  for (const item of candidates) {
    if (isMergeDataItem(item) && seen.get(mergeSignature(item)) === 1) pages.add(item.page);
  }
  return pages;
}

// Scanner metadata, not content: tokens without a letter (counters, dates,
// times), file names («scan_0051.jpg», «IMG_20261015_1032») and am/pm.
const FILE_NAME_TOKEN_RE = /\.(?:jpe?g|png|tiff?|bmp|gif|heic|webp|pdf)$/i;
function isContentToken(token) {
  // «(cid:12)» spells no word: glyph codes are stripped first.
  const bare = token.includes('(cid:') ? token.replace(CID_RE, '') : token;
  if (!/\p{L}/u.test(bare) || FILE_NAME_TOKEN_RE.test(token)) return false;
  if (token.includes('_') && /\d/.test(token)) return false;
  return !/^[ap]\.?m\.?$/i.test(token);
}

/** Does a residual (residualOf) carry anything beyond boilerplate, page numbers and scanner metadata? */
function residualHasContent(residual) {
  return residual.lines.some((line) => line.split(' ').some(isContentToken));
}

// Templated pages up to this size are compared as merge siblings.
const MAX_SIBLING_PAGE = 2000;

// Extrapolating the word/symbol verdict to unsampled pages needs a sample
// of at least this many pages, this share of them garbled.
const MIN_EXTRAPOLATION_SAMPLE = 10;
const EXTRAPOLATION_RATIO = 0.8;

function* planSteps(pages, { minChars = minPageChars(), maxScoreChars = textLayerScoreMaxChars() } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && Number.isInteger(p.page));
  const reasons = {};
  const counts = { short: 0, garbled: 0, stampOnly: 0 };
  if (list.length === 0) return { kind: 'text', ocrPages: [], reasons, counts, emptyLayerPages: [] };
  let boilerplate = new Set();
  if (list.length >= 2) {
    const lineCounts = new Map();
    yield* countLayerLines(list, lineCounts);
    boilerplate = boilerplateFromCounts(lineCounts, list.length);
  }
  // Expensive checks within the budget: every page when it fits, otherwise
  // a stride across the whole document (not only its first pages).
  let candidateChars = 0;
  for (const p of list) {
    const length = String(p.text || '').trim().length;
    if (length >= minChars) candidateChars += Math.min(length, SCORE_PAGE_SLICE);
  }
  const stride = candidateChars > maxScoreChars ? Math.ceil(candidateChars / maxScoreChars) : 1;
  let candidateIndex = 0;
  let scoredChars = 0;
  // The sample: deep-scored pages the glyph checks passed (deepScored) and
  // how many of them the word/symbol checks failed (deepGarbled); `shallow`
  // are the pages that only got the glyph checks and passed them.
  let deepScored = 0;
  let deepGarbled = 0;
  const shallow = [];
  const stampCandidates = [];
  const siblings = [];
  // Planned pages whose layer is nothing but boilerplate, page numbers,
  // scanner metadata or glyph codes ((cid:NN), private-use glyphs, U+FFFD):
  // a partial OCR does not splice them back as «content».
  const emptyLayerPages = [];
  for (const p of list) {
    yield;
    const trimmed = String(p.text || '').trim();
    if (trimmed.length < minChars) {
      reasons[p.page] = 'short';
      counts.short += 1;
      if (trimmed && !residualHasContent(residualOf(trimmed, boilerplate))) emptyLayerPages.push(p.page);
      continue;
    }
    const cost = Math.min(trimmed.length, SCORE_PAGE_SLICE);
    const deep = candidateIndex % stride === 0 && scoredChars + cost <= maxScoreChars;
    candidateIndex += 1;
    if (deep) scoredChars += cost;
    const score = yield* scoreSteps(trimmed, { deep });
    if (deep && score.reasons.every((r) => DEEP_REASONS.has(r))) {
      deepScored += 1;
      if (score.garbled) deepGarbled += 1;
    } else if (!deep && !score.garbled) {
      shallow.push(p.page);
    }
    if (score.garbled) {
      reasons[p.page] = 'garbled';
      counts.garbled += 1;
      if (score.glyphCodeShare >= GLYPH_CODE_LAYER_SHARE) emptyLayerPages.push(p.page);
      continue;
    }
    // Pages up to MAX_SIBLING_PAGE that are mostly template are the same
    // form as the stamp candidates (merge siblings).
    if (trimmed.length < 200 || (trimmed.length < MAX_SIBLING_PAGE && boilerplate.size > 0)) {
      const residual = residualOf(trimmed, boilerplate);
      if (trimmed.length < 200 && residual.chars < minChars) stampCandidates.push({ page: p.page, ...residual });
      else if (residual.template && residual.chars <= residual.templateChars) siblings.push(residual);
    }
  }
  // Short pages whose only residual is a name or other per-page data are a
  // form, and their exact text layer stays (no OCR). The share is taken
  // over the WHOLE document: a mail-merge is mostly the form, while a scan
  // whose pages are mostly empty, or a long text with a few scanned inserts
  // (the running header plus «ANEXO A», «Firma …»), is not — its inserts
  // are still read.
  const merged = mergeDataPages(stampCandidates, siblings, { total: list.length });
  for (const item of stampCandidates) {
    if (merged.has(item.page)) continue;
    reasons[item.page] = 'stamp_only';
    counts.stampOnly += 1;
    if (!residualHasContent(item)) emptyLayerPages.push(item.page);
  }
  // Past the budget the sample stands for the pages it skipped: when the
  // word/symbol checks fail on most sampled pages, the unsampled ones get
  // the same verdict (no extra CPU) — a layer garbled everywhere stays a
  // scanned document instead of every other page kept as gibberish.
  if (shallow.length && deepScored >= MIN_EXTRAPOLATION_SAMPLE && deepGarbled / deepScored >= EXTRAPOLATION_RATIO) {
    for (const page of shallow) {
      if (reasons[page] || merged.has(page)) continue;
      reasons[page] = 'garbled';
      counts.garbled += 1;
    }
  }
  const ocrPages = Object.keys(reasons).map(Number).sort((a, b) => a - b);
  const kind = ocrPages.length === 0 ? 'text' : ocrPages.length === list.length ? 'scanned' : 'mixed';
  emptyLayerPages.sort((a, b) => a - b);
  return { kind, ocrPages, reasons, counts, emptyLayerPages };
}

/**
 * Which pages of a text-layer PDF still need OCR, and why:
 *   - `short`: under `minChars` (scans, image-only pages);
 *   - `garbled`: the layer is broken (scoreTextLayerPage; past the
 *     scoring budget, an unsampled page takes the sample's verdict when
 *     ≥ 80 % of ≥ 10 sampled pages failed the word/symbol checks);
 *   - `stamp_only`: only boilerplate/page numbers (< 200 chars in total),
 *     unless its residual is per-page data on a shared template
 *     (mergeDataPages: names on a mail-merge, centred or not).
 * `kind`: 'text' (none), 'mixed' (some) or 'scanned' (all — «every page is
 * short» is a scanned document, not a text layer). `emptyLayerPages`: the
 * planned pages whose layer is only boilerplate, page numbers and scanner
 * metadata, or mostly glyph codes (a broken font: glyphCodeShare ≥ ½) —
 * not worth keeping when OCR does not read them. Options:
 * `minChars`, `maxScoreChars` (budget of the expensive checks).
 */
function planTextLayerOcr(pages = [], opts = {}) {
  return runSync(planSteps(pages, opts));
}

/**
 * planTextLayerOcr that yields to the event loop every ~20 pages (or 10 ms
 * of work): a 2000-page book never blocks the web process in one slice.
 * Extra options: `everyPages`, `sliceMs`.
 */
async function planTextLayerOcrAsync(pages = [], opts = {}) {
  return runYielding(planSteps(pages, opts), opts);
}

const TEMPLATE_LINE = Symbol('template');

/**
 * pdf-parse's text in blocks that each lie within ONE page. pdf-parse writes
 * «\n\n» before every page, and any run of two or more newlines holds a split
 * point, so no block reaches across a page boundary. A page that holds a
 * blank line of its own (pdf.js turns an empty text item into one) just
 * splits into several blocks: there are then more blocks than pages, never
 * fewer. Null when there are fewer (text joined some other way, with «\n»).
 */
function pdfParsePageBlocks(source, pagesCount) {
  const body = source.startsWith('\n\n') ? source.slice(2) : source;
  const blocks = body.split('\n\n');
  return blocks.length >= pagesCount ? blocks : null;
}

/**
 * Whole-document variant for pdf-parse text: the text is only stamps / page
 * numbers repeated across `numPages` pages — not per-page data on a shared
 * template (looksLikeMergeData).
 *
 * `pages` (optional): the text of each page, as pdf-parse rendered it
 * (`text` is «\n\n» + pages joined by «\n\n»). With them every page is one
 * item and a line is a template line when it is on ≥ 60 % of the pages
 * (counted once per page, as the planner does): a signature and a seal on
 * ONE page of a scan are one item, even when an empty text item put a blank
 * line between them.
 *
 * Without them the residual lines are grouped by block (pdfParsePageBlocks:
 * each block lies within one page), and an item is templated only by a
 * template line in its own block. A page can split into several blocks, so
 * every block beyond one per page may be part of a page already counted
 * (looksLikeMergeData `duplicates`). Trade-off, on purpose: certificates with
 * a blank line inside every page are not merge data from the joined text
 * alone and get OCR'd (still read); calling a scan «text» would lose its
 * page. Without blocks (fewer than pages), every residual line stands for a
 * page, and the text can only be merge data when it has at least one worded
 * residual line per page.
 */
function isStampOnlyText(text, numPages = 1, { minChars = minPageChars(), pages = null } = {}) {
  const source = String(text || '');
  const pagesCount = Math.max(1, Number(numPages) || 1);
  if (source.trim().length >= 300 * pagesCount) return false;
  const perPage = Array.isArray(pages) && pages.length === pagesCount ? pages.map((page) => String(page || '')) : null;
  const countLine = (map, line, seen) => {
    if (line.length > MAX_RAW_LAYER_LINE) return;
    const n = normalizeLayerLine(line);
    if (!n || n.length > MAX_BOILERPLATE_LINE || (seen && seen.has(n))) return;
    if (seen) seen.add(n);
    map.set(n, (map.get(n) || 0) + 1);
  };
  const lines = source.split('\n');
  // Every occurrence counts for the stamp verdict, as before: a stamp line
  // printed twice on a few pages of a scan is still a template.
  const counts = new Map();
  for (const line of lines) countLine(counts, line, null);
  // The merge-data items count a line once per page, as the planner does.
  let pageCounts = counts;
  if (perPage) {
    pageCounts = new Map();
    for (const page of perPage) {
      const seen = new Set();
      for (const line of page.split('\n')) countLine(pageCounts, line, seen);
    }
  }
  const threshold = Math.max(2, Math.ceil(pagesCount * 0.6));
  // A line: null (skipped: blank, page number, giant), TEMPLATE_LINE or
  // the residual line, normalised.
  const classifyWith = (map) => (line) => {
    if (line.length > MAX_RAW_LAYER_LINE) return null;
    const n = normalizeLayerLine(line);
    if (!n || isPageNumberLine(n)) return null;
    return pagesCount >= 2 && map.get(n) >= threshold ? TEMPLATE_LINE : n;
  };
  const classify = classifyWith(counts);
  const classifyItem = classifyWith(pageCounts);
  let residual = 0;
  let template = false;
  const residualLines = [];
  for (const line of lines) {
    // A giant line is content: counted, never normalised.
    if (line.length > MAX_RAW_LAYER_LINE) { residual += line.length; continue; }
    const n = classify(line);
    if (n === null) continue;
    if (n === TEMPLATE_LINE) { template = true; continue; }
    residual += line.trim().length;
    residualLines.push(n);
  }
  if (residual >= minChars * pagesCount) return false;
  const itemOf = (chunk) => {
    const item = { lines: [], template: false };
    for (const line of chunk.split('\n')) {
      const n = classifyItem(line);
      if (n === TEMPLATE_LINE) item.template = true;
      else if (n !== null) item.lines.push(n);
    }
    return item;
  };
  if (perPage) return !looksLikeMergeData(perPage.map(itemOf), { total: pagesCount });
  const blocks = pdfParsePageBlocks(source, pagesCount);
  if (blocks) {
    return !looksLikeMergeData(blocks.map(itemOf), { total: pagesCount, duplicates: blocks.length - pagesCount });
  }
  if (residualLines.filter((line) => WORD_RUN_RE.test(line)).length < pagesCount) return true;
  return !looksLikeMergeData(residualLines.map((line) => ({ lines: [line], template })), { total: pagesCount });
}

/**
 * Pages whose text layer is empty or negligible (likely scans/images).
 * `pages` is the streaming-pdf page list: [{ page, text }].
 */
function findLowTextPages(pages = [], minChars = minPageChars()) {
  return pages
    .filter(p => p && Number.isInteger(p.page) && (!p.text || p.text.trim().length < minChars))
    .map(p => p.page);
}

/**
 * A document is "mixed" when SOME pages have a usable text layer and some
 * don't. Fully-scanned documents (no text anywhere) are handled by the
 * existing whole-document OCR path, not here.
 */
function isMixedPdf(pages = [], minChars = minPageChars()) {
  if (!Array.isArray(pages) || pages.length === 0) return false;
  const low = findLowTextPages(pages, minChars);
  return low.length > 0 && low.length < pages.length;
}

/**
 * Merge text-layer pages with OCR'd pages, in page order. `ocrPages` is
 * the result of ocrEngine.extractPdfPagesSubset().pages.
 *
 * Without `opts` (legacy): pages under `minChars` take their OCR text; pages
 * with neither text layer nor OCR text are omitted (true blanks).
 * With `opts.ocrTargets` (the pages planned for OCR, e.g. garbled or
 * stamp-only pages too) those pages take their OCR text when there is one;
 * `opts.markUnread` marks every planned page nobody could read
 * (`[página N — no legible: …]`, `[página N sin OCR: límite]`) and flags
 * low-confidence OCR pages and broken layers kept as a last resort, so
 * nothing disappears silently. `opts.reasons`: { page: 'short'|'garbled'|… }.
 * Returns { text, ocrPagesUsed, unreadPages }.
 */
function mergeMixedPdfText(pages = [], ocrPages = [], minChars = minPageChars(), opts = {}) {
  const all = new Map((ocrPages || []).filter((p) => p && Number.isInteger(p.page)).map((p) => [p.page, p]));
  const ocrByPage = new Map(
    [...all.values()]
      .filter(p => p && p.text && String(p.text).trim())
      .map(p => [p.page, p]),
  );
  const targets = opts && Array.isArray(opts.ocrTargets) ? new Set(opts.ocrTargets) : null;
  const reasons = (opts && opts.reasons) || {};
  const markUnread = Boolean(opts && opts.markUnread);
  const blocks = [];
  const unreadPages = [];
  let ocrPagesUsed = 0;
  for (const p of pages) {
    if (!p || !Number.isInteger(p.page)) continue;
    const layerText = (p.text || '').trim();
    const planned = targets ? targets.has(p.page) : layerText.length < minChars;
    if (!planned) {
      blocks.push(`\n[page ${p.page}]\n${p.text}`);
    } else if (ocrByPage.has(p.page)) {
      const ocr = ocrByPage.get(p.page);
      ocrPagesUsed += 1;
      const note = markUnread && ocr.lowConfidence
        ? `[página ${p.page} — lectura poco fiable (confianza ${Math.round(Number(ocr.confidence) || 0)} %): verifícala con el original]\n`
        : '';
      blocks.push(`\n[page ${p.page} — OCR]\n${note}${ocr.text}`);
    } else if (layerText.length > 0) {
      // OCR gave nothing better — keep the layer rather than drop the page.
      const note = markUnread && reasons[p.page] === 'garbled'
        ? `[página ${p.page} — la capa de texto parece dañada y el OCR no pudo leerla: puede contener errores]\n`
        : '';
      blocks.push(`\n[page ${p.page}]\n${note}${p.text}`);
    } else if (markUnread) {
      const ocr = all.get(p.page);
      // A page the engine found blank is not «unread».
      if (!ocr || ocr.reason !== 'blank') unreadPages.push(p.page);
      // The engine's own marker says WHY (blank page, vision page cap, no
      // time left, local OCR unavailable…); older results only carry a reason.
      blocks.push(`\n[page ${p.page}]\n${ocr
        ? (typeof ocr.marker === 'string' && ocr.marker ? ocr.marker : ocrQuality.unreadablePageMarker(p.page, ocr.reason))
        : ocrQuality.pageCapMarker(p.page, p.page, 'límite')}`);
    }
  }
  return { text: blocks.join(''), ocrPagesUsed, unreadPages };
}

/**
 * The pages of a layer that hold nothing but boilerplate, page numbers and
 * scanner metadata, or mostly glyph codes (planTextLayerOcr's
 * `emptyLayerPages`, for callers without a plan). Only short pages can be
 * the former; a garbled layer of mojibake or odd words never is.
 */
function emptyLayerPagesOf(list, planReasons = {}) {
  const boilerplate = boilerplateLines(list);
  const out = [];
  for (const p of list) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    if (hasGlyphCodes(text) && scoreTextLayerPage(text, { deep: false }).glyphCodeShare >= GLYPH_CODE_LAYER_SHARE) {
      out.push(p.page);
      continue;
    }
    if (text.length >= 200 || planReasons[p.page] === 'garbled') continue;
    if (!residualHasContent(residualOf(text, boilerplate))) out.push(p.page);
  }
  return out;
}

const STOP_REASON_ES = {
  budget: 'tiempo agotado',
  aborted: 'lectura cancelada',
  char_cap: 'límite de caracteres',
  page_cap: 'límite',
};

/**
 * A full-page OCR that stopped early (time budget, page/char cap, cancel) or
 * could not read some pages must not throw away what the PDF's own text
 * layer had for them. Rebuilds the document in page order:
 *   - a page OCR read (or found blank) keeps its OCR block
 *     (`pageBlock(result)`, the engine's own `[page N]` format by default);
 *   - any other page whose text layer has content keeps that layer under a
 *     «sin OCR» note (`splicedPages`);
 *   - a page with neither keeps the engine's marker, and the run of pages
 *     the OCR never reached collapses into one `[páginas N–M sin OCR: …]`.
 *     A layer of boilerplate, page numbers and scanner metadata only
 *     («Escaneado con CamScanner», «Página 51 de 300») counts as none, and
 *     so does a layer that is mostly glyph codes ((cid:NN), private-use
 *     glyphs, U+FFFD: glyphCodeShare ≥ ½) — both are the plan's
 *     `emptyLayerPages`. A mojibake or implausible-word layer is still
 *     text, kept under the «dañado» note.
 * `layerPages`: [{ page, text }]; `ocrPages`: the engine's per-page results
 * [{ page, text, reason, blank, … }]; `opts.totalPages`, `opts.stopReason`
 * (the engine's partialReason), `opts.reasons` (the text-layer plan: a
 * `garbled` layer is flagged as possibly wrong), `opts.emptyLayerPages`
 * (the plan's; computed here when absent). Returns { text, splicedPages }.
 */
function spliceTextLayerIntoOcr(layerPages = [], ocrPages = [], opts = {}) {
  const list = (layerPages || []).filter((p) => p && Number.isInteger(p.page));
  const planReasons = opts.reasons || {};
  const empty = new Set(Array.isArray(opts.emptyLayerPages) ? opts.emptyLayerPages : emptyLayerPagesOf(list, planReasons));
  const layer = new Map(list.filter((p) => !empty.has(p.page)).map((p) => [p.page, String(p.text || '').trim()]));
  const ocr = new Map((ocrPages || []).filter((p) => p && Number.isInteger(p.page)).map((p) => [p.page, p]));
  const pageBlock = typeof opts.pageBlock === 'function'
    ? opts.pageBlock
    : (p) => `[page ${p.page}]\n${p.text ? p.text : (p.marker || ocrQuality.unreadablePageMarker(p.page, p.reason))}`;
  const why = STOP_REASON_ES[opts.stopReason] || 'límite';
  let last = Number(opts.totalPages) || 0;
  for (const page of [...layer.keys(), ...ocr.keys()]) if (page > last) last = page;
  const blocks = [];
  const splicedPages = [];
  let notReachedFrom = null;
  const flush = (to) => {
    if (notReachedFrom === null) return;
    blocks.push(ocrQuality.pageCapMarker(notReachedFrom, to, why));
    notReachedFrom = null;
  };
  for (let page = 1; page <= last; page += 1) {
    const read = ocr.get(page);
    // A page OCR read — or found blank — keeps the engine's block.
    if (read && ((read.text && String(read.text).trim()) || read.blank)) {
      flush(page - 1);
      blocks.push(pageBlock(read));
      continue;
    }
    const layerText = layer.get(page) || '';
    if (layerText) {
      flush(page - 1);
      splicedPages.push(page);
      const kept = planReasons[page] === 'garbled'
        ? 'se conserva el texto incrustado del PDF, que parece dañado: puede contener errores'
        : 'se conserva el texto incrustado del PDF';
      const note = read
        ? `[página ${page} — el OCR no pudo leerla (${ocrQuality.pageReasonEs(read.reason)}): ${kept}]`
        : `[página ${page} sin OCR: ${why} — ${kept}]`;
      blocks.push(`[page ${page}]\n${note}\n${layerText}`);
    } else if (read) {
      flush(page - 1);
      blocks.push(pageBlock(read));
    } else if (notReachedFrom === null) {
      notReachedFrom = page;
    }
  }
  flush(last);
  return { text: blocks.join('\n\n'), splicedPages };
}

module.exports = {
  DEFAULT_MIN_PAGE_CHARS,
  minPageChars,
  mixedOcrEnabled,
  mixedOcrMaxPages,
  mixedOcrBudgetMs,
  textLayerCheckEnabled,
  textLayerScoreMaxChars,
  findLowTextPages,
  isMixedPdf,
  mergeMixedPdfText,
  spliceTextLayerIntoOcr,
  scoreTextLayerPage,
  boilerplateLines,
  residualChars,
  planTextLayerOcr,
  planTextLayerOcrAsync,
  looksLikeMergeData,
  isStampOnlyText,
};
