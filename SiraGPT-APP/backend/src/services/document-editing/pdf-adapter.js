'use strict';

// Stage 4 of the DocumentEditingService: SAFE PDF operations via pdf-lib.
// PDF is not editable like Office (owner spec acknowledges this): we support
// page-level surgery (rotate / extract / remove / merge) and overlay text —
// never lossy content rewrites. Deep content edits are routed by the caller
// to a clear advisory ("convierte a DOCX") instead of a broken rebuild.

const MAX_PDF_BYTES = Number(process.env.SIRAGPT_EDIT_MAX_PDF_BYTES || 80 * 1024 * 1024);

let _pdfLib;
function getPdfLib() {
  if (_pdfLib === undefined) {
    try {
      // eslint-disable-next-line global-require
      _pdfLib = require('pdf-lib');
    } catch {
      _pdfLib = null;
    }
  }
  return _pdfLib;
}

function assertPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('el PDF está vacío');
  if (buffer.length > MAX_PDF_BYTES) throw new Error('el PDF supera el tamaño máximo editable');
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('el archivo no es un PDF válido');
}

async function loadPdf(buffer) {
  const lib = getPdfLib();
  if (!lib) throw new Error('la edición de PDF no está disponible en este despliegue (falta pdf-lib)');
  assertPdfBuffer(buffer);
  // ignoreEncryption: owner-supplied files sometimes carry empty user
  // passwords; we still refuse to bypass real permissions on save errors.
  return lib.PDFDocument.load(buffer, { ignoreEncryption: false });
}

async function getPdfInfo(buffer) {
  const doc = await loadPdf(buffer);
  return { pageCount: doc.getPageCount() };
}

// Normalise a 1-based page list against the real page count. Accepts
// [2,3,5]; out-of-range pages throw with a clear Spanish message.
function normalisePages(pages, pageCount) {
  const list = Array.from(new Set((pages || []).map(Number).filter(Number.isInteger)));
  if (!list.length) throw new Error('no indicaste páginas válidas');
  for (const p of list) {
    if (p < 1 || p > pageCount) throw new Error(`la página ${p} no existe (el PDF tiene ${pageCount})`);
  }
  return list.sort((a, b) => a - b);
}

async function rotatePdfPages({ buffer, pages = null, degrees = 90 } = {}) {
  const lib = getPdfLib();
  const doc = await loadPdf(buffer);
  const count = doc.getPageCount();
  const target = pages && pages.length ? normalisePages(pages, count) : Array.from({ length: count }, (_, i) => i + 1);
  const turn = ((Math.round(Number(degrees) / 90) * 90) % 360 + 360) % 360;
  for (const pageNumber of target) {
    const page = doc.getPage(pageNumber - 1);
    page.setRotation(lib.degrees((page.getRotation().angle + turn) % 360));
  }
  return { buffer: Buffer.from(await doc.save()), pages: target, degrees: turn, pageCount: count };
}

async function extractPdfPages({ buffer, pages } = {}) {
  const lib = getPdfLib();
  const doc = await loadPdf(buffer);
  const target = normalisePages(pages, doc.getPageCount());
  const out = await lib.PDFDocument.create();
  const copied = await out.copyPages(doc, target.map((p) => p - 1));
  for (const page of copied) out.addPage(page);
  return { buffer: Buffer.from(await out.save()), pages: target, pageCount: target.length };
}

async function removePdfPages({ buffer, pages } = {}) {
  const doc = await loadPdf(buffer);
  const count = doc.getPageCount();
  const target = normalisePages(pages, count);
  if (target.length >= count) throw new Error('no puedo eliminar todas las páginas del PDF');
  // Remove from the end so earlier indices stay valid.
  for (const pageNumber of [...target].reverse()) doc.removePage(pageNumber - 1);
  return { buffer: Buffer.from(await doc.save()), pages: target, pageCount: count - target.length };
}

async function mergePdfBuffers({ buffers } = {}) {
  const lib = getPdfLib();
  if (!Array.isArray(buffers) || buffers.length < 2) throw new Error('para unir PDFs necesito al menos dos archivos');
  const out = await lib.PDFDocument.create();
  let total = 0;
  for (const buffer of buffers) {
    const doc = await loadPdf(buffer);
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) { out.addPage(page); total += 1; }
  }
  return { buffer: Buffer.from(await out.save()), pageCount: total, merged: buffers.length };
}

// Overlay text ON TOP of a page (annotation-style; the original content
// stream is untouched underneath). Default anchor: top-left with margin.
async function addPdfTextOverlay({ buffer, page = 1, text, x = null, y = null, size = 14, color = '#DC2626' } = {}) {
  const lib = getPdfLib();
  const doc = await loadPdf(buffer);
  const count = doc.getPageCount();
  const [pageNumber] = normalisePages([page], count);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('no indicaste el texto a insertar');
  const target = doc.getPage(pageNumber - 1);
  const { width, height } = target.getSize();
  const font = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(color)) ? String(color).replace('#', '') : 'DC2626';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  target.drawText(clean.slice(0, 300), {
    x: Number.isFinite(x) ? Number(x) : 40,
    y: Number.isFinite(y) ? Number(y) : height - 50,
    size: Math.max(6, Math.min(72, Number(size) || 14)),
    font,
    color: lib.rgb(r, g, b),
    maxWidth: width - 80,
  });
  return { buffer: Buffer.from(await doc.save()), page: pageNumber, text: clean.slice(0, 300) };
}

module.exports = {
  getPdfInfo,
  rotatePdfPages,
  extractPdfPages,
  removePdfPages,
  mergePdfBuffers,
  addPdfTextOverlay,
  INTERNAL: { normalisePages, assertPdfBuffer },
};
