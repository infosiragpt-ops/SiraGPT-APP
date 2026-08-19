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
// - Strict validation: allow-listed extensions, size cap, 90s timeout.
// - Best-effort by contract: callers treat any throw as "no preview" and
//   fall back to their legacy renderer.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const PREVIEWABLE = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.csv', '.rtf']);
const MAX_SOURCE_BYTES = Number(process.env.SIRAGPT_PREVIEW_MAX_BYTES || 40 * 1024 * 1024);
const CONVERT_TIMEOUT_MS = Number(process.env.SIRAGPT_PREVIEW_TIMEOUT_MS || 90_000);

const CACHE_DIR = process.env.SIRAGPT_PREVIEW_CACHE_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), 'preview-cache');

let _sofficeChecked = null;
async function hasSoffice() {
  if (_sofficeChecked !== null) return _sofficeChecked;
  try {
    await execFileAsync(process.env.SOFFICE_BIN || 'soffice', ['--version'], { timeout: 10_000 });
    _sofficeChecked = true;
  } catch {
    _sofficeChecked = false;
  }
  return _sofficeChecked;
}

function isPreviewableFile(filename = '') {
  return PREVIEWABLE.has(path.extname(String(filename)).toLowerCase());
}

// Serialize conversions + share in-flight ones.
let conversionChain = Promise.resolve();
const inFlight = new Map();

async function convertToPdf(sourcePath, outPath) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-preview-'));
  try {
    await execFileAsync(process.env.SOFFICE_BIN || 'soffice', [
      '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', runDir, sourcePath,
    ], { timeout: CONVERT_TIMEOUT_MS });
    const produced = (await fsp.readdir(runDir)).find((f) => f.endsWith('.pdf'));
    if (!produced) throw new Error('conversion produced no PDF');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.copyFile(path.join(runDir, produced), outPath);
    return outPath;
  } finally {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Returns the path of a cached (or freshly converted) PDF preview for the
 * given source file. Throws when the file is not previewable, too large, or
 * soffice is unavailable — callers fall back to their legacy preview.
 */
async function getOrCreatePdfPreview({ sourcePath, cacheKey }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('source not found');
  if (!isPreviewableFile(sourcePath)) throw new Error('format not previewable');
  const stat = await fsp.stat(sourcePath);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error('file too large for preview');
  if (!(await hasSoffice())) throw new Error('soffice unavailable');

  const key = String(cacheKey || path.basename(sourcePath)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const outPath = path.join(CACHE_DIR, `${key}-${Math.floor(stat.mtimeMs)}.pdf`);
  if (fs.existsSync(outPath)) return outPath;

  if (inFlight.has(outPath)) return inFlight.get(outPath);
  const job = (conversionChain = conversionChain
    .catch(() => {}) // a failed previous conversion must not poison the chain
    .then(() => convertToPdf(sourcePath, outPath)))
    .finally(() => { inFlight.delete(outPath); });
  inFlight.set(outPath, job);
  return job;
}

module.exports = { getOrCreatePdfPreview, isPreviewableFile, hasSoffice, CACHE_DIR };
