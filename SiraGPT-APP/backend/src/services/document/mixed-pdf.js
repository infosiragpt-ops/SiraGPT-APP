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
 * Pure functions, no I/O — unit-tested in isolation.
 */

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
 * the result of ocrEngine.extractPdfPagesSubset().pages. Pages that have
 * neither text layer nor OCR text are omitted (true blanks).
 * Returns { text, ocrPagesUsed }.
 */
function mergeMixedPdfText(pages = [], ocrPages = [], minChars = minPageChars()) {
  const ocrByPage = new Map(
    (ocrPages || [])
      .filter(p => p && p.text && String(p.text).trim())
      .map(p => [p.page, p]),
  );
  const blocks = [];
  let ocrPagesUsed = 0;
  for (const p of pages) {
    if (!p || !Number.isInteger(p.page)) continue;
    const layerText = (p.text || '').trim();
    if (layerText.length >= minChars) {
      blocks.push(`\n[page ${p.page}]\n${p.text}`);
    } else if (ocrByPage.has(p.page)) {
      const ocr = ocrByPage.get(p.page);
      ocrPagesUsed += 1;
      blocks.push(`\n[page ${p.page} — OCR]\n${ocr.text}`);
    } else if (layerText.length > 0) {
      // Below the threshold but not empty and OCR gave nothing better —
      // keep the crumbs rather than dropping the page entirely.
      blocks.push(`\n[page ${p.page}]\n${p.text}`);
    }
  }
  return { text: blocks.join(''), ocrPagesUsed };
}

module.exports = {
  DEFAULT_MIN_PAGE_CHARS,
  minPageChars,
  mixedOcrEnabled,
  mixedOcrMaxPages,
  findLowTextPages,
  isMixedPdf,
  mergeMixedPdfText,
};
