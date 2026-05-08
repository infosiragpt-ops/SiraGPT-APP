'use strict';

const fs = require('fs').promises;

const DEFAULT_MAX_RSS_MB = Number.parseInt(
  process.env.SIRAGPT_STREAM_MAX_RSS_MB || '900',
  10
);

function rssMb() {
  try {
    return process.memoryUsage().rss / (1024 * 1024);
  } catch {
    return 0;
  }
}

let _pdfjsModulePromise = null;
async function loadPdfjs() {
  if (_pdfjsModulePromise) return _pdfjsModulePromise;
  _pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
    _pdfjsModulePromise = null;
    throw err;
  });
  return _pdfjsModulePromise;
}

function pageItemsToText(items) {
  let last = null;
  let out = '';
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    if (last !== null && item.transform && last !== item.transform[5]) {
      out += '\n';
    }
    out += item.str;
    if (item.hasEOL) out += '\n';
    if (item.transform) last = item.transform[5];
  }
  return out;
}

/**
 * Stream a PDF page-by-page as an async iterator.
 * Each yielded item: { page, text, charCount, rssMb, totalPages }.
 * Honors RSS cap by aborting early; sets partialRef.partial = true if so.
 */
async function* streamPdfPages(filePath, opts = {}) {
  const maxRssMb = opts.maxRssMb || DEFAULT_MAX_RSS_MB;
  const partialRef = opts.partialRef || { partial: false };
  const onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null;

  const pdfjs = await loadPdfjs();
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useWorker: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;
  const maxPages = opts.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, totalPages) : totalPages;

  let aborted = false;
  try {
    for (let i = 1; i <= maxPages; i += 1) {
      let page = null;
      try {
        page = await doc.getPage(i);
        const textContent = await page.getTextContent({
          includeMarkedContent: false,
          disableCombineTextItems: false,
        });
        const text = pageItemsToText(textContent.items);
        yield {
          page: i,
          text,
          charCount: text.length,
          rssMb: rssMb(),
          totalPages,
        };
      } finally {
        if (page && typeof page.cleanup === 'function') {
          try { page.cleanup(); } catch { /* ignore */ }
        }
      }
      if (rssMb() > maxRssMb) {
        aborted = true;
        partialRef.partial = true;
        if (onPartial) onPartial({ reason: 'rss_cap', atPage: i, rssMb: rssMb() });
        break;
      }
    }
  } finally {
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch { /* ignore */ }
    }
    if (aborted && opts.partialRef) opts.partialRef.partial = true;
  }
}

async function extractPdfStreaming(filePath, opts = {}) {
  const start = Date.now();
  let peakRss = rssMb();
  const pages = [];
  let totalChars = 0;
  let totalPages = 0;
  const partialRef = { partial: false };

  for await (const p of streamPdfPages(filePath, { ...opts, partialRef })) {
    totalPages = p.totalPages || totalPages;
    pages.push(opts.collectText !== false
      ? { page: p.page, charCount: p.charCount, text: p.text }
      : { page: p.page, charCount: p.charCount });
    totalChars += p.charCount;
    if (p.rssMb > peakRss) peakRss = p.rssMb;
    if (typeof opts.onPage === 'function') opts.onPage(p);
  }

  return {
    pageCount: pages.length,
    totalPages: totalPages || pages.length,
    totalChars,
    pages,
    partial: partialRef.partial,
    peakRssMb: peakRss,
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  streamPdfPages,
  extractPdfStreaming,
  DEFAULT_MAX_RSS_MB,
};
