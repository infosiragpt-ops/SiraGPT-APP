'use strict';

/**
 * Page renderer for the docx engine's visual verification loop.
 *
 *   docx → PDF (LibreOffice, serialized in soffice.js) → PNG pages (pdftoppm)
 *
 * Every render is cached by content hash inside one process, so the original
 * document is rasterized once per edit session and `render()` (page count +
 * text) and `pages()` (PNG bitmaps) share the same PDF. Nothing here talks to
 * a model; the agent receives the bitmaps through verify.js / agent.js.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const soffice = require('./soffice');

const execFileAsync = promisify(execFile);

const DEFAULT_DPI = 110;
const MAX_DPI = 200;
const MAX_PAGES = 8;
const MAX_CACHE_ENTRIES = 6;
const PDFTOPPM_TIMEOUT_MS = 60_000;

let pdftoppmState = null;

function pdftoppmBin() {
  return process.env.PDFTOPPM_BIN || 'pdftoppm';
}

async function pdftoppmAvailable({ exec = execFileAsync } = {}) {
  if (pdftoppmState !== null) return pdftoppmState;
  try {
    await exec(pdftoppmBin(), ['-v'], { timeout: 10_000 });
    pdftoppmState = true;
  } catch {
    pdftoppmState = false;
  }
  return pdftoppmState;
}

function clampDpi(dpi) {
  const n = Number(dpi);
  if (!Number.isFinite(n) || n < 36) return DEFAULT_DPI;
  return Math.min(MAX_DPI, Math.round(n));
}

/** Page selection: null/undefined → first MAX_PAGES pages; array → explicit pages (1-based). */
function normalizePages(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const clean = [...new Set(pages.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 1))].sort((a, b) => a - b);
  return clean.length ? clean.slice(0, MAX_PAGES) : null;
}

function pageNumberOf(filename) {
  const m = /-(\d+)\.png$/i.exec(filename);
  return m ? Number(m[1]) : NaN;
}

/**
 * Rasterize a PDF to PNG pages with pdftoppm.
 * @returns {Promise<Array<{ page: number, png: Buffer }>>}
 */
async function rasterizePdf(pdfBuffer, { pages = null, dpi = DEFAULT_DPI, exec = execFileAsync } = {}) {
  const wanted = normalizePages(pages);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-pages-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await fsp.writeFile(input, pdfBuffer);
    const first = wanted ? wanted[0] : 1;
    const last = wanted ? wanted[wanted.length - 1] : MAX_PAGES;
    const args = ['-r', String(clampDpi(dpi)), '-png', '-f', String(first), '-l', String(last), input, path.join(dir, 'page')];
    await exec(pdftoppmBin(), args, { timeout: PDFTOPPM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    const files = (await fsp.readdir(dir)).filter((f) => /^page-\d+\.png$/i.test(f));
    const out = [];
    for (const file of files) {
      const page = pageNumberOf(file);
      if (!Number.isInteger(page)) continue;
      if (wanted && !wanted.includes(page)) continue;
      out.push({ page, png: await fsp.readFile(path.join(dir, file)) });
    }
    out.sort((a, b) => a.page - b.page);
    if (!out.length) throw new Error('pdftoppm no produjo páginas.');
    return out;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Renderer shared by one process: `render(buffer)` → { pages, text },
 * `pages(buffer, { pages, dpi })` → PNG bitmaps. The PDF for a given docx is
 * produced once and reused by both.
 */
function createDocxRenderer({ sofficeModule = soffice, exec = execFileAsync, rasterize = rasterizePdf, dpi = DEFAULT_DPI } = {}) {
  const cache = new Map();

  const entryFor = (buffer) => {
    const key = hashBuffer(buffer);
    let entry = cache.get(key);
    if (!entry) {
      entry = { pdf: null, info: null, images: new Map() };
      cache.set(key, entry);
      if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    }
    if (!entry.pdf) entry.pdf = sofficeModule.renderDocxToPdf(buffer).catch((err) => { entry.pdf = null; throw err; });
    return entry;
  };

  return {
    async available() {
      return (await sofficeModule.sofficeAvailable()) && (await pdftoppmAvailable({ exec }));
    },
    async pdf(buffer) {
      return entryFor(buffer).pdf;
    },
    async render(buffer) {
      const entry = entryFor(buffer);
      if (!entry.info) entry.info = entry.pdf.then((pdf) => sofficeModule.pdfInfo(pdf)).catch((err) => { entry.info = null; throw err; });
      return entry.info;
    },
    async pages(buffer, { pages = null, dpi: wantedDpi = dpi } = {}) {
      const entry = entryFor(buffer);
      const selected = normalizePages(pages);
      const resolvedDpi = clampDpi(wantedDpi);
      const key = `${resolvedDpi}:${selected ? selected.join(',') : 'first'}`;
      if (!entry.images.has(key)) {
        entry.images.set(key, entry.pdf.then((pdf) => rasterize(pdf, { pages: selected, dpi: resolvedDpi, exec }))
          .catch((err) => { entry.images.delete(key); throw err; }));
      }
      return entry.images.get(key);
    },
    clear() { cache.clear(); },
  };
}

let sharedRenderer = null;
function sharedDocxRenderer() {
  if (!sharedRenderer) sharedRenderer = createDocxRenderer();
  return sharedRenderer;
}

module.exports = {
  DEFAULT_DPI,
  MAX_PAGES,
  pdftoppmAvailable,
  rasterizePdf,
  createDocxRenderer,
  sharedDocxRenderer,
  normalizePages,
  _resetAvailability() { pdftoppmState = null; },
};
