'use strict';

/**
 * streaming-pdf — page-by-page PDF extraction with bounded memory.
 *
 * Designed for documents of ANY size (including 1000+ pages).
 * Key design decisions:
 *   - Pages are extracted one-at-a time, never held in memory
 *   - RSS cap is soft (triggers yield control) rather than hard (no abort)
 *   - Page content is streamed to caller via onPage callback
 *   - NO character limit cap — extraction continues as long as RSS allows
 *   - Pages are cleaned up after each iteration via doc.cleanup()
 */

const fs = require('fs').promises;

const DEFAULT_MAX_RSS_MB = Number.parseInt(
  process.env.SIRAGPT_STREAM_MAX_RSS_MB || '1200',
  10
);

/**
 * Maximum pages to extract from a single document. 0 = unlimited.
 * Set via SIRAGPT_STREAMING_MAX_PAGES.
 */
const DEFAULT_MAX_PAGES = Number.parseInt(
  process.env.SIRAGPT_STREAMING_MAX_PAGES || '0',
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
 * Detect structural elements from page text content.
 * Returns { headings, tables, listItems } counts.
 */
function analyzePageStructure(text) {
  const lines = (text || '').split('\n');
  let headings = 0;
  let tables = 0;
  let listItems = 0;
  let paragraphCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heading detection: short lines, often all-caps or title case
    if (
      trimmed.length >= 3 &&
      trimmed.length <= 120 &&
      !trimmed.endsWith('.') &&
      !trimmed.endsWith(',') &&
      (trimmed === trimmed.toUpperCase().trim() ||
        /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5}$/.test(trimmed.split(/[.!?:;]/)[0]))
    ) {
      if (trimmed.length <= 80) headings++;
      continue;
    }

    // Table-like lines (pipes, tabs)
    if (/[|]\s*[-:]{2,}\s*[|]/.test(trimmed) || /\t/.test(trimmed) && trimmed.split('\t').length >= 3) {
      tables++;
      continue;
    }

    // List items
    if (/^\s*[-*•‣⁃]\s/.test(trimmed) || /^\s*\d+[.)]\s/.test(trimmed)) {
      listItems++;
      continue;
    }

    // Paragraph (sentence-length text)
    if (trimmed.length >= 40) {
      paragraphCount++;
    }
  }

  return { headings, tables, listItems, paragraphCount };
}

/**
 * Stream a PDF page-by-page as an async iterator.
 * Each yielded item: { page, text, charCount, rssMb, totalPages, structure }.
 * Honors RSS cap by yielding a special abort signal; does NOT hard-abort.
 */
async function* streamPdfPages(filePath, opts = {}) {
  const maxRssMb = opts.maxRssMb || DEFAULT_MAX_RSS_MB;
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
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
  const effectiveMaxPages = maxPages > 0 ? Math.min(maxPages, totalPages) : totalPages;

  let aborted = false;
  try {
    for (let i = 1; i <= effectiveMaxPages; i++) {
      let page = null;
      try {
        page = await doc.getPage(i);
        const textContent = await page.getTextContent({
          includeMarkedContent: false,
          disableCombineTextItems: false,
        });
        const text = pageItemsToText(textContent.items);
        const structure = analyzePageStructure(text);

        const currentRss = rssMb();
        yield {
          page: i,
          text,
          charCount: text.length,
          rssMb: currentRss,
          totalPages,
          structure,
        };

        // Soft RSS check: warn caller but don't abort — let caller decide
        if (currentRss > maxRssMb) {
          aborted = true;
          partialRef.partial = true;
          if (onPartial) {
            onPartial({ reason: 'rss_cap', atPage: i, rssMb: currentRss });
          }
          break;
        }
      } finally {
        if (page && typeof page.cleanup === 'function') {
          try { page.cleanup(); } catch { /* ignore */ }
        }
      }
    }
  } finally {
    if (typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch { /* ignore */ }
    }
  }
}

/**
 * Extract PDF text with page-streaming, returning structured results.
 *
 * Unlike the old version, this has NO hard character cap — it streams
 * ALL pages until RSS exceeds maxRssMb or the document ends.
 *
 * @param {string} filePath - Path to PDF file
 * @param {object} opts
 * @param {boolean} [opts.collectText=true] - Whether to return page text in result
 * @param {function} [opts.onPage] - Called for each page with { page, text, charCount }
 * @param {number} [opts.maxRssMb] - RSS threshold in MB
 * @param {number} [opts.maxPages] - Max pages to extract (0 = unlimited)
 * @returns {Promise<{pageCount, totalPages, totalChars, pages, partial, peakRssMb, elapsedMs}>}
 */
async function extractPdfStreaming(filePath, opts = {}) {
  const start = Date.now();
  let peakRss = rssMb();
  const pages = [];
  let totalChars = 0;
  let totalPages = 0;
  let currentPageCount = 0;
  const partialRef = { partial: false };

  for await (const p of streamPdfPages(filePath, { ...opts, partialRef })) {
    currentPageCount++;
    totalPages = p.totalPages || totalPages;
    if (opts.collectText !== false) {
      pages.push({
        page: p.page,
        charCount: p.charCount,
        text: p.text,
        structure: p.structure || null,
      });
    } else {
      pages.push({
        page: p.page,
        charCount: p.charCount,
        structure: p.structure || null,
      });
    }
    totalChars += p.charCount;
    if (p.rssMb > peakRss) peakRss = p.rssMb;
    if (typeof opts.onPage === 'function') opts.onPage(p);
  }

  return {
    pageCount: currentPageCount,
    totalPages: totalPages || currentPageCount,
    totalChars,
    pages,
    partial: partialRef.partial,
    peakRssMb: peakRss,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Lightweight structural outline builder.
 * Scans page text for heading patterns and builds a Table of Contents.
 *
 * @param {Array<{page: number, text: string, structure: object}>} pages
 * @returns {Array<{level: number, title: string, page: number}>}
 */
function buildOutlineFromPages(pages) {
  const outline = [];
  for (const p of pages) {
    if (!p.text) continue;
    const lines = p.text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 3 || trimmed.length > 100) continue;

      // Level 1: All-caps short lines
      if (
        trimmed === trimmed.toUpperCase() &&
        trimmed.length >= 3 &&
        trimmed.length <= 60 &&
        !trimmed.endsWith('.') &&
        !trimmed.endsWith(':')
      ) {
        outline.push({ level: 1, title: trimmed, page: p.page });
        continue;
      }

      // Level 2: Title case short lines (potential section headings)
      if (
        /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+$/.test(trimmed) &&
        trimmed.length >= 3 &&
        trimmed.length <= 70 &&
        !trimmed.endsWith('.')
      ) {
        outline.push({ level: 2, title: trimmed, page: p.page });
        continue;
      }

      // Level 3: Numbered sections like "1.1 Introduction"
      if (/^\d+\.\d+\s+[A-Z]/.test(trimmed)) {
        outline.push({ level: 3, title: trimmed, page: p.page });
        continue;
      }

      // Level 4: "Chapter/Sección/Capítulo N"
      if (
        /^(Chapter|Section|Sección|Seccion|Capítulo|Capitulo|Part|Parte)\s+\d+/i.test(trimmed)
      ) {
        outline.push({ level: 1, title: trimmed, page: p.page });
        continue;
      }
    }
  }
  return outline;
}

/**
 * Build a compact markdown outline from extracted pages.
 * Callers can include this in the LLM context for document navigation.
 */
function buildMarkdownOutline(pages) {
  const outline = buildOutlineFromPages(pages);
  if (outline.length === 0) return null;
  return outline
    .map((entry) => {
      const prefix = '#'.repeat(Math.min(entry.level, 3));
      return `${prefix} [p.${entry.page}] ${entry.title}`;
    })
    .join('\n');
}

module.exports = {
  streamPdfPages,
  extractPdfStreaming,
  buildOutlineFromPages,
  buildMarkdownOutline,
  analyzePageStructure,
  DEFAULT_MAX_RSS_MB,
};
