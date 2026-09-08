'use strict';

// High-fidelity document previews: convert office files (docx/xlsx/pptx/…)
// to PDF with LibreOffice headless and cache the result. The frontend then
// shows the PDF in a real viewer (pagination/zoom) instead of hand-rolled
// HTML tables — WYSIWYG parity with how Office renders the file.
//
// Design constraints:
// - Cached by <artifactId>-<mtime> so a re-generated artifact re-converts
//   but repeat views are free.
// - Conversions are SERIALIZED (soffice is heavy; parallel invocations on
//   the same profile dir are flaky) with an in-flight map so concurrent
//   requests for the same file share one conversion.
// - Isolated UserInstallation + Writer/Impress/Calc PDF filters preserve
//   page size and margins (no web-layout "descuadrado" export).
// - Native PDFs are copied into the cache — no soffice pass.
// - Best-effort by contract: callers treat any throw as "no preview" and
//   fall back to their legacy renderer.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  buildSofficeConvertArgs,
  sofficeSpawnEnv,
  isNativePdfFilename,
  pdfExportFilterFor,
} = require('./soffice-pdf-export');

const execFileAsync = promisify(execFile);

const PREVIEWABLE = new Set([
  '.pdf',
  '.docx', '.doc',
  '.xlsx', '.xls',
  '.pptx', '.ppt',
  '.odt', '.ods', '.odp',
  '.csv', '.rtf',
]);
const MAX_SOURCE_BYTES = Number(process.env.SIRAGPT_PREVIEW_MAX_BYTES || 40 * 1024 * 1024);
const CONVERT_TIMEOUT_MS = Number(process.env.SIRAGPT_PREVIEW_TIMEOUT_MS || 90_000);

const CACHE_DIR = process.env.SIRAGPT_PREVIEW_CACHE_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), 'preview-cache');

const PDF_MAGIC = Buffer.from('%PDF');

let _execFile = execFileAsync;
let _sofficeChecked = null;

async function hasSoffice() {
  if (_sofficeChecked !== null) return _sofficeChecked;
  try {
    await _execFile(process.env.SOFFICE_BIN || 'soffice', ['--version'], { timeout: 10_000 });
    _sofficeChecked = true;
  } catch {
    _sofficeChecked = false;
  }
  return _sofficeChecked;
}

function isPreviewableFile(filename = '') {
  return PREVIEWABLE.has(path.extname(String(filename)).toLowerCase());
}

function looksLikePdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC);
}

function isNativePdfSource(sourcePath) {
  if (isNativePdfFilename(sourcePath)) return true;
  try {
    const fd = fs.openSync(sourcePath, 'r');
    try {
      const buf = Buffer.alloc(5);
      const n = fs.readSync(fd, buf, 0, 5, 0);
      return n >= 4 && looksLikePdfBuffer(buf.subarray(0, 4));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

async function copyToCache(sourcePath, outPath) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(sourcePath, tmp);
  await fsp.rename(tmp, outPath);
  return outPath;
}

// Serialize conversions + share in-flight ones.
let conversionChain = Promise.resolve();
const inFlight = new Map();

async function convertToPdf(sourcePath, outPath) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-preview-'));
  const profileDir = path.join(runDir, 'profile');
  const outDir = path.join(runDir, 'out');
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });
  try {
    const args = buildSofficeConvertArgs({ sourcePath, outDir, profileDir });
    await _execFile(process.env.SOFFICE_BIN || 'soffice', args, { timeout: CONVERT_TIMEOUT_MS, env: sofficeSpawnEnv(profileDir) });
    const produced = (await fsp.readdir(outDir)).find((f) => f.endsWith('.pdf'));
    if (!produced) throw new Error('conversion produced no PDF');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.copyFile(path.join(outDir, produced), outPath);
    return outPath;
  } finally {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function cachePathFor(sourcePath, cacheKey, mtimeMs) {
  const key = String(cacheKey || path.basename(sourcePath)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return path.join(CACHE_DIR, `${key}-${Math.floor(mtimeMs)}.pdf`);
}

/**
 * Returns the path of a cached (or freshly converted) PDF preview for the
 * given source file. Native PDFs are copied into the cache without soffice.
 * Throws when the file is not previewable, too large, or soffice is
 * unavailable — callers fall back to their legacy preview.
 */
async function getOrCreatePdfPreview({ sourcePath, cacheKey }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('source not found');
  if (!isPreviewableFile(sourcePath) && !isNativePdfSource(sourcePath)) {
    throw new Error('format not previewable');
  }
  const stat = await fsp.stat(sourcePath);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error('file too large for preview');

  const outPath = cachePathFor(sourcePath, cacheKey, stat.mtimeMs);
  if (fs.existsSync(outPath)) return outPath;

  if (isNativePdfSource(sourcePath)) {
    return copyToCache(sourcePath, outPath);
  }

  if (!(await hasSoffice())) throw new Error('soffice unavailable');

  if (inFlight.has(outPath)) return inFlight.get(outPath);
  const job = (conversionChain = conversionChain
    .catch(() => {}) // a failed previous conversion must not poison the chain
    .then(() => convertToPdf(sourcePath, outPath)))
    .finally(() => { inFlight.delete(outPath); });
  inFlight.set(outPath, job);
  return job;
}

function __setExecFileForTests(fn) {
  _execFile = typeof fn === 'function' ? fn : execFileAsync;
  _sofficeChecked = null;
}

function __resetSofficeCheckForTests() {
  _sofficeChecked = null;
}

module.exports = {
  getOrCreatePdfPreview,
  isPreviewableFile,
  isNativePdfSource,
  hasSoffice,
  CACHE_DIR,
  pdfExportFilterFor,
  buildSofficeConvertArgs,
  __setExecFileForTests,
  __resetSofficeCheckForTests,
};
