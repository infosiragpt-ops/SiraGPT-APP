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
 * the document is treated as fully scanned (`planTextLayerOcr`).
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

// ── Text-layer quality ─────────────────────────────────────────────────────

const CID_RE = /\(cid:\d+\)/g;
const REPLACEMENT_RE = /\uFFFD/g;
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g;
// UTF-8 decoded as Latin-1/CP1252: «Ã¡» (á), «Ã±» (ñ), «Â¿» (¿), «â€œ» (“).
const MOJIBAKE_RE = /Ã[\u0080-\u00BF]|Â[\u00A0-\u00BF]|â€[\u0080-\u00BF\u2018-\u201E\u2122\u0153\u017E\u0178]/g;

function matchLength(text, re) {
  let total = 0;
  let count = 0;
  for (const m of String(text).matchAll(re)) { total += m[0].length; count += 1; }
  return { total, count };
}

/**
 * Is this page's text layer broken? Returns { chars, garbled, reasons,
 * cidRatio, replacementRatio, privateUseRatio, wordRatio }. Conservative on
 * purpose: numeric tables, code and short pages are never called garbled by
 * the word check (it needs ≥ 20 Latin words and < 25 % plausible ones).
 */
function scoreTextLayerPage(text) {
  const source = String(text || '');
  const nonSpace = source.replace(/\s+/g, '').length;
  const result = { chars: nonSpace, garbled: false, reasons: [], cidRatio: 0, replacementRatio: 0, privateUseRatio: 0, wordRatio: null };
  if (nonSpace === 0) return result;
  const cid = matchLength(source, CID_RE);
  const fffd = matchLength(source, REPLACEMENT_RE);
  const pua = matchLength(source, PRIVATE_USE_RE);
  const moji = matchLength(source, MOJIBAKE_RE);
  result.cidRatio = cid.total / nonSpace;
  result.replacementRatio = fffd.count / nonSpace;
  result.privateUseRatio = pua.count / nonSpace;
  if (cid.count >= 3 && result.cidRatio > 0.05) result.reasons.push('cid_glyphs');
  if (fffd.count >= 3 && result.replacementRatio > 0.02) result.reasons.push('replacement_chars');
  if (pua.count >= 3 && result.privateUseRatio > 0.05) result.reasons.push('private_use_glyphs');
  if (moji.count >= 3 && moji.total / nonSpace > 0.02) result.reasons.push('mojibake');
  const clean = source.replace(CID_RE, ' ').replace(PRIVATE_USE_RE, ' ').replace(REPLACEMENT_RE, ' ');
  result.wordRatio = ocrQuality.dictionaryWordRatio(clean, { minTokens: 20 });
  if (result.wordRatio !== null && result.wordRatio < 0.25) result.reasons.push('implausible_words');
  if (clean.replace(/\s+/g, '').length >= 40) {
    const assessment = ocrQuality.assessText(clean.slice(0, 50_000));
    if (assessment.symbolRatio > 0.35) result.reasons.push('symbol_noise');
    if (assessment.singleLetterRatio !== null && assessment.singleLetterRatio > 0.6) result.reasons.push('letter_storm');
  }
  result.garbled = result.reasons.length > 0;
  return result;
}

const PAGE_NUMBER_LINE_RE = /^(?:[-–—\s]*#[-–—\s]*|p[aá]g(?:ina)?\.?\s*#(?:\s*(?:de|of|\/)\s*#)?|page\s*#(?:\s*(?:of|\/)\s*#)?|#\s*(?:de|of|\/)\s*#)$/i;

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

/**
 * Lines repeated VERBATIM on most pages (≥ 2 pages and ≥ 60 % of them):
 * headers, footers, scanner stamps (≤ 80 chars). Lines that differ in their
 * numbers are different lines (form data); page numbers are recognised by
 * isPageNumberLine instead.
 */
function boilerplateLines(pages = []) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && Number.isInteger(p.page));
  const out = new Set();
  if (list.length < 2) return out;
  const counts = new Map();
  for (const p of list) {
    const seen = new Set();
    for (const line of String(p.text || '').split('\n')) {
      const n = normalizeLayerLine(line);
      if (n.length < 2 || n.length > MAX_BOILERPLATE_LINE || seen.has(n)) continue;
      seen.add(n);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(list.length * 0.6));
  for (const [line, count] of counts) if (count >= threshold) out.add(line);
  return out;
}

/** Characters of a page outside boilerplate and page-number lines. */
function residualChars(text, boilerplate = new Set()) {
  let total = 0;
  for (const line of String(text || '').split('\n')) {
    const n = normalizeLayerLine(line);
    if (!n || boilerplate.has(n) || isPageNumberLine(n)) continue;
    total += line.trim().length;
  }
  return total;
}

/**
 * Which pages of a text-layer PDF still need OCR, and why:
 *   - `short`: under `minChars` (scans, image-only pages);
 *   - `garbled`: the layer is broken (scoreTextLayerPage);
 *   - `stamp_only`: only boilerplate/page numbers (< 200 chars in total).
 * `kind`: 'text' (none), 'mixed' (some) or 'scanned' (all — «every page is
 * short» is a scanned document, not a text layer).
 */
function planTextLayerOcr(pages = [], { minChars = minPageChars() } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter((p) => p && Number.isInteger(p.page));
  const reasons = {};
  if (list.length === 0) return { kind: 'text', ocrPages: [], reasons, counts: { short: 0, garbled: 0, stampOnly: 0 } };
  const boilerplate = boilerplateLines(list);
  const counts = { short: 0, garbled: 0, stampOnly: 0 };
  for (const p of list) {
    const trimmed = String(p.text || '').trim();
    if (trimmed.length < minChars) {
      reasons[p.page] = 'short';
      counts.short += 1;
      continue;
    }
    if (scoreTextLayerPage(trimmed).garbled) {
      reasons[p.page] = 'garbled';
      counts.garbled += 1;
      continue;
    }
    if (trimmed.length < 200 && residualChars(trimmed, boilerplate) < minChars) {
      reasons[p.page] = 'stamp_only';
      counts.stampOnly += 1;
    }
  }
  const ocrPages = Object.keys(reasons).map(Number).sort((a, b) => a - b);
  const kind = ocrPages.length === 0 ? 'text' : ocrPages.length === list.length ? 'scanned' : 'mixed';
  return { kind, ocrPages, reasons, counts };
}

/**
 * Whole-document variant for text without page boundaries (pdf-parse): the
 * text is only stamps / page numbers repeated across `numPages` pages.
 */
function isStampOnlyText(text, numPages = 1, { minChars = minPageChars() } = {}) {
  const source = String(text || '');
  const pagesCount = Math.max(1, Number(numPages) || 1);
  if (source.trim().length >= 300 * pagesCount) return false;
  const counts = new Map();
  const lines = source.split('\n');
  for (const line of lines) {
    const n = normalizeLayerLine(line);
    if (n && n.length <= MAX_BOILERPLATE_LINE) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pagesCount * 0.6));
  let residual = 0;
  for (const line of lines) {
    const n = normalizeLayerLine(line);
    if (!n || isPageNumberLine(n) || (pagesCount >= 2 && counts.get(n) >= threshold)) continue;
    residual += line.trim().length;
  }
  return residual < minChars * pagesCount;
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

module.exports = {
  DEFAULT_MIN_PAGE_CHARS,
  minPageChars,
  mixedOcrEnabled,
  mixedOcrMaxPages,
  mixedOcrBudgetMs,
  textLayerCheckEnabled,
  findLowTextPages,
  isMixedPdf,
  mergeMixedPdfText,
  scoreTextLayerPage,
  boilerplateLines,
  residualChars,
  planTextLayerOcr,
  isStampOnlyText,
};
