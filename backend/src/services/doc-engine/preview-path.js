'use strict';

/**
 * /chat DOCX preview path selection.
 *
 * Primary: LibreOffice → PDF (page images + zoom + 1/N toolbar via the
 * existing DocumentPreview PdfRenderer). Mammoth / docx-preview HTML dumps
 * are never the primary path — they misalign UPN geometry and look like a
 * broken HTML dump instead of Word.
 */

const ARTIFACT_RE = /\/api\/agent\/artifact\/([a-f0-9]{6,40})/i;
const OFFICE = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf']);

function normalizeFormat(format = '', filename = '', mime = '') {
  const fromExt = String(filename || '').toLowerCase().split('?')[0].split('#')[0];
  const ext = (fromExt.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const raw = String(format || ext || '').toLowerCase().replace(/^\./, '');
  if (raw === 'doc' || raw === 'docx' || /wordprocessingml/i.test(mime)) return raw === 'doc' ? 'doc' : 'docx';
  if (OFFICE.has(raw)) return raw;
  return raw || 'unknown';
}

function artifactIdFromUrl(url = '') {
  const m = ARTIFACT_RE.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * @param {{ format?: string, filename?: string, mime?: string, downloadUrl?: string, fileId?: string, artifactId?: string, htmlPreview?: string|null }} opts
 * @returns {{ kind: 'soffice_pdf'|'docx_native'|'unsupported', previewPdfUrl: string|null, useHtmlDump: false }}
 */
function selectDocxPreviewPath(opts = {}) {
  const format = normalizeFormat(opts.format, opts.filename, opts.mime);
  const downloadUrl = String(opts.downloadUrl || '');
  const artifactId = String(opts.artifactId || '').replace(/[^a-f0-9]/gi, '') || artifactIdFromUrl(downloadUrl);
  const fileId = opts.fileId ? String(opts.fileId) : '';

  if (!OFFICE.has(format) && format !== 'docx' && format !== 'doc') {
    return { kind: 'unsupported', previewPdfUrl: null, useHtmlDump: false };
  }

  if (artifactId) {
    return {
      kind: 'soffice_pdf',
      previewPdfUrl: `/api/agent/artifact/${artifactId}/preview.pdf`,
      useHtmlDump: false,
    };
  }
  if (fileId) {
    return {
      kind: 'soffice_pdf',
      previewPdfUrl: `/api/files/${encodeURIComponent(fileId)}/render?target=pdf`,
      useHtmlDump: false,
    };
  }
  return {
    kind: format === 'docx' || format === 'doc' ? 'docx_native' : 'unsupported',
    previewPdfUrl: null,
    useHtmlDump: false,
  };
}

function shouldAttachHtmlPreview(format = '') {
  const f = String(format || '').toLowerCase();
  // Spreadsheets still get a small HTML table; Word never does.
  return f === 'xlsx' || f === 'csv';
}

module.exports = {
  ARTIFACT_RE,
  normalizeFormat,
  artifactIdFromUrl,
  selectDocxPreviewPath,
  shouldAttachHtmlPreview,
};
