'use strict';

/**
 * legacy-format-converter — converts legacy Office formats (.doc, .xls, .ppt)
 * to plain text using LibreOffice headless conversion to a temp file, then
 * text extraction from the result.
 *
 * Supported legacy formats:
 *   .doc  → LibreOffice → .docx → mammoth extraction
 *   .xls  → LibreOffice → .csv  → text reading
 *   .ppt  → LibreOffice → .pptx → officeparser extraction
 *
 * Falls back gracefully if LibreOffice is not installed.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LIBREOFFICE_BIN = process.env.LIBREOFFICE_BIN || 'soffice';
const CONVERT_TIMEOUT_MS = parseInt(process.env.LEGACY_CONVERT_TIMEOUT_MS, 10) || 120_000;
const CONVERT_OUT_DIR = process.env.LEGACY_FORMAT_OUT_DIR || path.join(os.tmpdir(), 'sira-legacy-convert');

const LEGACY_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);
const IS_AVAILABLE = { value: null };

async function checkAvailable() {
  if (IS_AVAILABLE.value !== null) return IS_AVAILABLE.value;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(LIBREOFFICE_BIN, ['--version'], { stdio: 'ignore' });
      child.on('error', () => reject(new Error('not found')));
      child.on('exit', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`exit ${code}`));
      });
    });
    IS_AVAILABLE.value = true;
  } catch {
    IS_AVAILABLE.value = false;
  }
  return IS_AVAILABLE.value;
}

async function ensureOutDir() {
  await fsp.mkdir(CONVERT_OUT_DIR, { recursive: true });
}

/**
 * Convert a legacy office document to a modern format using LibreOffice.
 * @param {string} srcPath — absolute path to the source file
 * @param {string} targetFormat — 'docx', 'csv', 'pptx', 'txt', 'odt'
 * @returns {Promise<string>} — path to the converted file
 */
async function convertWithLibreOffice(srcPath, targetFormat) {
  if (!await checkAvailable()) {
    throw new Error(`LibreOffice (${LIBREOFFICE_BIN}) not available. Install LibreOffice on the host.`);
  }

  await ensureOutDir();

  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-profile-legacy-'));
  const outDir = path.resolve(CONVERT_OUT_DIR);

  try {
    await new Promise((resolve, reject) => {
      const args = [
        `-env:UserInstallation=file://${profileDir}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to', targetFormat,
        '--outdir', outDir,
        srcPath,
      ];
      const child = spawn(LIBREOFFICE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Legacy format conversion timed out after ${CONVERT_TIMEOUT_MS}ms`));
      }, CONVERT_TIMEOUT_MS);

      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited ${code}: ${stderr.slice(0, 240)}`));
      });
    });

    const baseNoExt = path.basename(srcPath, path.extname(srcPath));
    const outPath = path.join(outDir, `${baseNoExt}.${targetFormat}`);

    try { await fsp.access(outPath); } catch { throw new Error(`Converted file not found: ${outPath}`); }

    return outPath;
  } finally {
    fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Convert a .doc file to plain text.
 * Strategy: LibreOffice .doc → .odt → mammoth extraction, or
 *            LibreOffice .doc → .docx → mammoth extraction.
 * Failing that: LibreOffice .doc → .txt directly.
 */
async function convertDocToText(srcPath) {
  try {
    const odtPath = await convertWithLibreOffice(srcPath, 'odt');
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ path: odtPath });
    if (value && value.trim().length > 50) {
      await fsp.unlink(odtPath).catch(() => {});
      return value;
    }
    await fsp.unlink(odtPath).catch(() => {});
    throw new Error('Too little text from ODT conversion');
  } catch (err1) {
    try {
      const docxPath = await convertWithLibreOffice(srcPath, 'docx');
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ path: docxPath });
      await fsp.unlink(docxPath).catch(() => {});
      if (value && value.trim().length > 30) return value;
      throw new Error('Too little text from DOCX conversion');
    } catch (err2) {
      try {
        const txtPath = await convertWithLibreOffice(srcPath, 'txt');
        const text = await fsp.readFile(txtPath, 'utf8');
        await fsp.unlink(txtPath).catch(() => {});
        return text;
      } catch {
        throw new Error(`Legacy .doc conversion failed. Install LibreOffice (${LIBREOFFICE_BIN}) on the backend host.`);
      }
    }
  }
}

/**
 * Convert a .xls file to plain text.
 * Strategy: LibreOffice .xls → .csv → read as text.
 * Failing that: LibreOffice .xls → .xlsx → ExcelJS extraction.
 */
async function convertXlsToText(srcPath) {
  try {
    const csvPath = await convertWithLibreOffice(srcPath, 'csv');
    const text = await fsp.readFile(csvPath, 'utf8');
    await fsp.unlink(csvPath).catch(() => {});
    if (text && text.trim().length > 10) return text;
    throw new Error('Too little CSV content');
  } catch (err1) {
    try {
      const xlsxPath = await convertWithLibreOffice(srcPath, 'xlsx');
      const { readXlsxFile, selectWorkbookWorksheets, worksheetRows } = require('./xlsx-safe-workbook');
      const workbook = await readXlsxFile(xlsxPath);
      await fsp.unlink(xlsxPath).catch(() => {});
      const { worksheets } = selectWorkbookWorksheets(workbook);
      const blocks = [];
      for (const sheet of worksheets) {
        const rows = worksheetRows(sheet, { maxRows: 5000 });
        if (rows.length > 0) {
          blocks.push(`Sheet: ${sheet.name}\n` + rows.map(r => r.join('\t')).join('\n'));
        }
      }
      return blocks.join('\n\n') || '';
    } catch {
      throw new Error(`Legacy .xls conversion failed. Install LibreOffice (${LIBREOFFICE_BIN}) on the backend host.`);
    }
  }
}

/**
 * Convert a .ppt file to plain text.
 * Strategy: LibreOffice .ppt → .pptx → officeparser extraction.
 * Failing that: LibreOffice .ppt → .odp → text export.
 */
async function convertPptToText(srcPath) {
  try {
    const pptxPath = await convertWithLibreOffice(srcPath, 'pptx');
    const officeParser = require('officeparser');
    const parsed = typeof officeParser.parseOfficeAsync === 'function'
      ? await officeParser.parseOfficeAsync(pptxPath)
      : await officeParser.parseOffice(pptxPath, { ocr: false });
    const text = typeof parsed === 'string'
      ? parsed
      : (typeof parsed?.toText === 'function' ? parsed.toText() : String(parsed || ''));
    await fsp.unlink(pptxPath).catch(() => {});
    if (text && text.trim().length > 30) return text;
    throw new Error('Too little text from PPTX conversion');
  } catch (err1) {
    try {
      const odpPath = await convertWithLibreOffice(srcPath, 'odp');
      const text = await fsp.readFile(odpPath, 'utf8');
      await fsp.unlink(odpPath).catch(() => {});
      return text;
    } catch {
      throw new Error(`Legacy .ppt conversion failed. Install LibreOffice (${LIBREOFFICE_BIN}) on the backend host.`);
    }
  }
}

/**
 * Extract text from a legacy format file.
 * @param {string} filePath — absolute path to the file
 * @param {string} extension — lowercase extension (doc, xls, ppt)
 * @returns {Promise<string>} — extracted text
 */
async function extractLegacyText(filePath, extension) {
  const ext = String(extension || '').toLowerCase();

  switch (ext) {
    case 'doc': return convertDocToText(filePath);
    case 'xls': return convertXlsToText(filePath);
    case 'ppt': return convertPptToText(filePath);
    default:
      throw new Error(`Unsupported legacy format: .${ext}`);
  }
}

/**
 * Check if an extension is a known legacy format.
 */
function isLegacyFormat(extension) {
  return LEGACY_EXTENSIONS.has(String(extension || '').toLowerCase());
}

/**
 * Map legacy extension to its OOXML/equivalent MIME for the processing pipeline.
 */
function legacyMimeForExtension(ext) {
  const map = {
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
  };
  return map[String(ext || '').toLowerCase()] || null;
}

module.exports = {
  extractLegacyText,
  isLegacyFormat,
  legacyMimeForExtension,
  checkAvailable,
  LEGACY_EXTENSIONS,
};
