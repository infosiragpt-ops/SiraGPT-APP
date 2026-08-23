'use strict';

/**
 * Fast extract helpers for chat-upload documents.
 *
 * The composer chip stays on "Extrayendo texto" until fileProcessor
 * returns. This module is the speed path:
 *   - pdftotext (poppler) before pdf.js / OCR
 *   - per-slide PPTX XML (don't lose slides to a blob parser)
 *   - skip-until-send RAG so extract can mark ready
 *   - stage timings for logs/metrics
 *
 * Preview-ready stays the PR 387 persist-object gate. This only
 * shortens the extract/index wait after the bytes are already stored.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fsp = require('node:fs/promises');
const PizZip = require('pizzip');

const execFileAsync = promisify(execFile);
let _execFile = execFileAsync;

function envFlag(name, defaultOn) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function intFromEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.floor(n));
  return max == null ? clamped : Math.min(clamped, max);
}

/** Marker/Docling/MarkItDown probes are slow even when unavailable. Off by default. */
function shouldRunExternalParsers() {
  return envFlag('SIRAGPT_EXTERNAL_PARSER_FIRST', false);
}

/** Persist extracted text and let the first chat turn index via operational-rag. */
function shouldSkipRagUntilSend() {
  return envFlag('SIRAGPT_RAG_SKIP_UNTIL_SEND', true);
}

function shouldDeferOfficeImageOcr() {
  return envFlag('SIRAGPT_DEFER_OFFICE_IMAGE_OCR', true);
}

function pdftotextEnabled() {
  return envFlag('SIRAGPT_PDFTOTEXT', true);
}

function officeImageOcrConcurrency() {
  return intFromEnv('SIRAGPT_OFFICE_IMAGE_OCR_CONCURRENCY', 3, 1, 8);
}

function embedBatchSize() {
  return intFromEnv('SIRAGPT_EMBED_BATCH', 128, 16, 512);
}

function createStageTimer(label = 'extract') {
  const started = Date.now();
  const stages = [];
  let last = started;
  return {
    mark(name) {
      const now = Date.now();
      stages.push({ name: String(name || 'stage'), ms: now - last });
      last = now;
      return stages[stages.length - 1];
    },
    snapshot() {
      return {
        label,
        totalMs: Date.now() - started,
        stages: stages.slice(),
      };
    },
  };
}

function logExtractTiming(payload = {}) {
  const body = {
    event: 'file_extract_timing',
    ts: new Date().toISOString(),
    ...payload,
  };
  console.log('[file-extract]', JSON.stringify(body));
  return body;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractATextRuns(xml) {
  const texts = [];
  String(xml || '').replace(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi, (_, inner) => {
    const decoded = decodeXmlEntities(inner).replace(/\s+/g, ' ').trim();
    if (decoded) texts.push(decoded);
    return '';
  });
  return texts;
}

function slideNumberFromName(name) {
  const match = String(name || '').match(/slide(\d+)\.xml$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function notesNumberFromName(name) {
  const match = String(name || '').match(/notesSlide(\d+)\.xml$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function formatPptxExtraction({ slides = [], skipped = 0 } = {}) {
  const withText = slides.filter((s) => s.text && s.text.trim());
  const header = `PowerPoint presentation — ${slides.length} slide(s) extracted` +
    (skipped > 0 ? ` (${skipped} skipped)` : '') +
    `\n---\n`;
  const blocks = slides.map((slide) => {
    const title = slide.title ? ` — ${slide.title}` : '';
    const notes = slide.notes ? `\n[Notes]\n${slide.notes}` : '';
    return `[Slide ${slide.slide}${title}]\n${slide.text || '(empty)'}${notes}`;
  });
  return {
    text: header + blocks.join('\n\n'),
    slideCount: slides.length,
    slidesWithText: withText.length,
    skipped,
  };
}

/**
 * Per-slide PPTX extract from the Office zip. officeparser flattens the
 * deck and can drop later slides; this keeps slide order + notes.
 */
async function extractPptxSlides(filePath, opts = {}) {
  let zip;
  try {
    const data = opts.buffer || await fsp.readFile(filePath);
    zip = new PizZip(data);
  } catch (err) {
    return { ok: false, reason: err?.message || 'zip_read_failed', slides: [], skipped: 0 };
  }

  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && !zip.files[name].dir)
    .sort((a, b) => slideNumberFromName(a) - slideNumberFromName(b));

  if (slideNames.length === 0) {
    return { ok: false, reason: 'no_slides', slides: [], skipped: 0 };
  }

  const notesBySlide = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)) continue;
    const num = notesNumberFromName(name);
    try {
      const xml = zip.files[name].asText();
      const runs = extractATextRuns(xml)
        .filter((t) => !/^slide \d+$/i.test(t) && t !== 'Notes Placeholder');
      if (runs.length) notesBySlide.set(num, runs.join('\n'));
    } catch {
      // keep going — notes are optional
    }
  }

  const slides = [];
  let skipped = 0;
  for (const name of slideNames) {
    const num = slideNumberFromName(name);
    try {
      const xml = zip.files[name].asText();
      const runs = extractATextRuns(xml);
      slides.push({
        slide: num,
        title: runs[0] || '',
        text: runs.join('\n'),
        notes: notesBySlide.get(num) || '',
      });
    } catch {
      skipped += 1;
    }
  }

  if (slides.length === 0) {
    return { ok: false, reason: 'slides_unreadable', slides: [], skipped };
  }

  return { ok: true, reason: 'pptx_xml', slides, skipped, ...formatPptxExtraction({ slides, skipped }) };
}

function splitPdftotextPages(stdout) {
  const rawPages = String(stdout || '').split('\f');
  const pages = rawPages.map((text, i) => ({
    page: i + 1,
    text: String(text || '').replace(/\s+$/g, ''),
  }));
  while (pages.length > 1 && !pages[pages.length - 1].text.trim()) pages.pop();
  const totalChars = pages.reduce((n, p) => n + p.text.trim().length, 0);
  return { pages, totalChars, pageCount: pages.length };
}

/**
 * Poppler pdftotext is typically 5–20× faster than pdf.js for text-layer
 * PDFs. Returns { used:false } when the binary is missing or the PDF is
 * image-only so the caller can fall through to streaming / OCR.
 */
async function tryPdftotext(filePath, opts = {}) {
  if (!pdftotextEnabled()) return { used: false, reason: 'disabled', pages: [], text: '', totalChars: 0 };
  const exec = opts.execFile || _execFile;
  const timeout = opts.timeoutMs || intFromEnv('SIRAGPT_PDFTOTEXT_TIMEOUT_MS', 8000, 500, 60000);
  try {
    const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], {
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    const split = splitPdftotextPages(stdout);
    if (split.totalChars < 20) {
      return { used: false, reason: 'empty', ...split, text: '' };
    }
    const text = split.pages
      .filter((p) => p.text.trim())
      .map((p) => `\n[page ${p.page}]\n${p.text}`)
      .join('');
    return { used: true, reason: 'pdftotext', text, ...split };
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'unavailable' : (err?.message || 'failed');
    return { used: false, reason, pages: [], text: '', totalChars: 0 };
  }
}

function coverageFromPages(pages = []) {
  const total = pages.length;
  const withText = pages.filter((p) => String(p.text || '').trim().length > 0).length;
  return { pages: total, pagesWithText: withText, pagesMissingText: Math.max(0, total - withText) };
}

function __setExecFileForTests(fn) {
  _execFile = typeof fn === 'function' ? fn : execFileAsync;
}

module.exports = {
  coverageFromPages,
  createStageTimer,
  decodeXmlEntities,
  embedBatchSize,
  envFlag,
  extractATextRuns,
  extractPptxSlides,
  formatPptxExtraction,
  logExtractTiming,
  officeImageOcrConcurrency,
  pdftotextEnabled,
  shouldDeferOfficeImageOcr,
  shouldRunExternalParsers,
  shouldSkipRagUntilSend,
  splitPdftotextPages,
  tryPdftotext,
  __setExecFileForTests,
};
