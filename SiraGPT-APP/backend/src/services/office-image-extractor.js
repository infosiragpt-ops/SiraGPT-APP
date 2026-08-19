/**
 * Embedded-image extraction for Office documents (DOCX / PPTX / XLSX).
 *
 * These formats are ZIP containers with their media under a well-known
 * folder (word/media/, ppt/media/, xl/media/). mammoth / officeparser /
 * exceljs extract the TEXT and silently drop every image — so a deck of
 * photographed slides or a Word doc with pasted screenshots lost all that
 * content. This module lists the embedded raster images and runs them
 * through the hybrid OCR engine (Tesseract → vision fallback), producing
 * an appendix the callers concatenate to the extracted text.
 *
 * Bounded by design: image count / per-image bytes / total bytes caps keep
 * a pathological 500-image deck from stalling the upload pipeline. Every
 * failure is contained — callers always get their base text back.
 */

const fsp = require('fs').promises;
const PizZip = require('pizzip');

const MEDIA_DIR_RE = /^(word|ppt|xl)\/media\//i;
// Formats sharp/tesseract can actually decode. EMF/WMF (Windows metafiles,
// common for pasted charts) are intentionally excluded.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function config() {
  return {
    enabled: process.env.SIRAGPT_OFFICE_IMAGE_OCR !== '0',
    maxImages: intFromEnv('SIRAGPT_OFFICE_IMAGE_MAX', 12),
    // Below this size it's almost always a bullet icon / logo / divider —
    // OCR noise, not content.
    minBytes: intFromEnv('SIRAGPT_OFFICE_IMAGE_MIN_BYTES', 4096),
    maxBytes: intFromEnv('SIRAGPT_OFFICE_IMAGE_MAX_BYTES', 8 * 1024 * 1024),
    maxTotalBytes: intFromEnv('SIRAGPT_OFFICE_IMAGE_MAX_TOTAL_BYTES', 40 * 1024 * 1024),
  };
}

function guessMime(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'image/png';
}

/**
 * List embedded raster images in an Office zip, applying the size caps.
 * Never throws on a corrupt/foreign file — returns an empty listing.
 */
async function listEmbeddedImages(filePath, opts = {}) {
  const cfg = { ...config(), ...opts };
  let zip;
  try {
    const data = await fsp.readFile(filePath);
    zip = new PizZip(data);
  } catch {
    return { images: [], total: 0, skipped: 0 };
  }

  const entries = Object.values(zip.files)
    .filter(f => f && !f.dir && MEDIA_DIR_RE.test(f.name) && IMAGE_EXT_RE.test(f.name))
    // image1.png, image2.png, … image10.png in document order.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const images = [];
  let totalBytes = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (images.length >= cfg.maxImages) { skipped += 1; continue; }
    let buffer;
    try {
      buffer = typeof entry.asNodeBuffer === 'function'
        ? entry.asNodeBuffer()
        : Buffer.from(entry.asUint8Array());
    } catch {
      skipped += 1;
      continue;
    }
    if (buffer.length < cfg.minBytes || buffer.length > cfg.maxBytes) { skipped += 1; continue; }
    if (totalBytes + buffer.length > cfg.maxTotalBytes) { skipped += 1; continue; }
    totalBytes += buffer.length;
    images.push({
      name: entry.name.split('/').pop(),
      path: entry.name,
      buffer,
      bytes: buffer.length,
      mimeType: guessMime(entry.name),
    });
  }

  return { images, total: entries.length, skipped };
}

/**
 * OCR every listed image through the hybrid engine. `opts.ocrEngine` is
 * injectable for tests. Per-image failures are captured, never thrown.
 */
async function extractImagesText(filePath, opts = {}) {
  const engine = opts.ocrEngine || require('./ocr-engine');
  const { images, total, skipped } = await listEmbeddedImages(filePath, opts);
  const results = [];
  for (const image of images) {
    try {
      const res = await engine.extractFromImage(image.buffer, {
        mimeType: image.mimeType,
        allowVision: opts.allowVision,
      });
      results.push({ name: image.name, path: image.path, bytes: image.bytes, text: res.text || '', ocr: res.ocr });
    } catch (error) {
      results.push({
        name: image.name,
        path: image.path,
        bytes: image.bytes,
        text: '',
        ocr: { status: 'failed', reason: error?.message || 'image_ocr_failed' },
      });
    }
  }
  return { results, total, skipped };
}

/**
 * Format OCR'd images as a text appendix. Empty string when no image
 * produced text (so callers can concatenate unconditionally).
 */
function buildImageAppendix({ results = [], total = 0 } = {}) {
  const withText = results.filter(r => r.text && r.text.trim());
  if (withText.length === 0) return '';
  const scope = total > withText.length ? ` (de ${total} imágenes en el documento)` : '';
  const lines = [`--- Texto extraído de ${withText.length} imagen(es) embebida(s)${scope} ---`];
  withText.forEach((r, i) => {
    lines.push(`\n[Imagen ${i + 1} — ${r.name}]\n${r.text.trim()}`);
  });
  return lines.join('\n');
}

/**
 * One-call helper for fileProcessor: returns the ready-to-append appendix
 * ('' when disabled, no images, or nothing legible).
 */
async function extractImageAppendix(filePath, opts = {}) {
  if (!config().enabled && opts.force !== true) return '';
  const out = await extractImagesText(filePath, opts);
  return buildImageAppendix(out);
}

module.exports = {
  config,
  guessMime,
  listEmbeddedImages,
  extractImagesText,
  buildImageAppendix,
  extractImageAppendix,
};
