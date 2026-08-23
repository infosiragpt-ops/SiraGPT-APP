'use strict';

/**
 * Shared LibreOffice → PDF export flags.
 *
 * Writer/Impress/Calc PDF filters keep the source page size and margins
 * (pgSz/pgMar, slide size). The generic `--convert-to pdf` path can fall
 * through to a web-layout export that looks "descuadrado" in the viewer.
 *
 * Isolated UserInstallation avoids the "another soffice is running" lock
 * that made concurrent preview/render calls fail and 409.
 */

const path = require('node:path');

const WRITER_EXTS = new Set(['.docx', '.doc', '.odt', '.rtf', '.txt']);
const IMPRESS_EXTS = new Set(['.pptx', '.ppt', '.odp']);
const CALC_EXTS = new Set(['.xlsx', '.xls', '.ods', '.csv']);

function extOf(filename = '') {
  return path.extname(String(filename || '')).toLowerCase();
}

/**
 * LibreOffice --convert-to filter that preserves page geometry.
 * @param {string} filename
 * @returns {string} e.g. "pdf:writer_pdf_Export"
 */
function pdfExportFilterFor(filename = '') {
  const ext = extOf(filename);
  if (IMPRESS_EXTS.has(ext)) return 'pdf:impress_pdf_Export';
  if (CALC_EXTS.has(ext)) return 'pdf:calc_pdf_Export';
  if (WRITER_EXTS.has(ext) || ext === '.pdf') return 'pdf:writer_pdf_Export';
  return 'pdf:writer_pdf_Export';
}

function fileUri(absPath) {
  const resolved = path.resolve(String(absPath || ''));
  // LibreOffice wants file:// URIs; encode spaces but keep the path absolute.
  return `file://${encodeURI(resolved)}`;
}

/**
 * Args for a single headless conversion with an isolated profile.
 * @param {{ sourcePath: string, outDir: string, profileDir: string }} opts
 * @returns {string[]}
 */
function buildSofficeConvertArgs({ sourcePath, outDir, profileDir } = {}) {
  if (!sourcePath || !outDir || !profileDir) {
    throw new Error('sourcePath, outDir and profileDir are required');
  }
  return [
    `-env:UserInstallation=${fileUri(profileDir)}`,
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    '--convert-to',
    pdfExportFilterFor(sourcePath),
    '--outdir',
    outDir,
    path.resolve(sourcePath),
  ];
}

function isNativePdfFilename(filename = '') {
  return extOf(filename) === '.pdf';
}

module.exports = {
  pdfExportFilterFor,
  buildSofficeConvertArgs,
  isNativePdfFilename,
  fileUri,
};
