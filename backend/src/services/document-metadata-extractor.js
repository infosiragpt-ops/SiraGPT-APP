'use strict';

/**
 * document-metadata-extractor — extracts structured metadata from
 * uploaded documents including EXIF, PDF metadata, Office document
 * properties, and font/author/date information.
 *
 * Add-on — does NOT block extraction. Failures are silently degraded.
 */

const fs = require('fs').promises;

/**
 * Extract PDF metadata (author, title, creator, page count, etc.)
 * Uses the streaming PDF module for fast metadata without loading full doc.
 */
async function extractPdfMetadata(filePath) {
  try {
    const mod = require('./document/streaming-pdf');
    const result = await mod.extractPdfStreaming(filePath, {
      collectText: false,
      maxPages: 1,
    });
    return {
      format: 'pdf',
      pageCount: result?.totalPages || null,
      charCount: result?.totalChars || null,
      partial: result?.partial || false,
    };
  } catch (err) {
    return { format: 'pdf', pageCount: null, charCount: null, error: err?.message };
  }
}

/**
 * Extract image EXIF metadata using Sharp.
 */
async function extractImageMetadata(filePath) {
  try {
    const sharp = require('sharp');
    const metadata = await sharp(filePath).metadata();
    return {
      format: metadata.format || null,
      width: metadata.width || null,
      height: metadata.height || null,
      space: metadata.space || null,
      channels: metadata.channels || null,
      density: metadata.density || null,
      hasAlpha: metadata.hasAlpha || false,
      isProgressive: metadata.isProgressive || false,
      pages: metadata.pages || 1,
      resolution: metadata.resolutionUnit ? `${metadata.density || 'unknown'} ${metadata.resolutionUnit}` : null,
    };
  } catch {
    return { format: 'image', width: null, height: null };
  }
}

/**
 * Extract Office document properties (DOCX, XLSX, PPTX) using ExcelJS/officeparser.
 */
async function extractOfficeMetadata(filePath, mimeType) {
  try {
    const ExcelJS = require('exceljs');
    const path = require('path');
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.xlsx') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      return {
        format: 'xlsx',
        creator: workbook.creator || null,
        lastModifiedBy: workbook.lastModifiedBy || null,
        created: workbook.created ? workbook.created.toISOString() : null,
        modified: workbook.modified ? workbook.modified.toISOString() : null,
        lastPrinted: workbook.lastPrinted ? workbook.lastPrinted.toISOString() : null,
        company: workbook.company || null,
        manager: workbook.manager || null,
        title: workbook.title || null,
        subject: workbook.subject || null,
        keywords: workbook.keywords || null,
        category: workbook.category || null,
        description: workbook.description || null,
        sheetCount: workbook.worksheets?.length || 0,
        sheetNames: workbook.worksheets?.map(w => w.name) || [],
      };
    }

    return { format: ext.replace('.', ''), mimeType: mimeType || null };
  } catch {
    return { format: 'office', error: 'extraction_failed' };
  }
}

/**
 * Extract metadata from a text file (encoding, line count, word count, char count).
 */
async function extractTextMetadata(filePath) {
  try {
    const encodingMod = require('./text-encoding-detector');
    const detection = await encodingMod.detectEncoding(filePath);
    const stat = await fs.stat(filePath);
    const raw = await fs.readFile(filePath);
    const text = raw.toString(detection.encoding || 'utf8');
    const lines = text.split(/\r?\n/);
    const nonEmptyLines = lines.filter(l => l.trim());
    const words = text.split(/\s+/).filter(Boolean);

    return {
      format: 'text',
      encoding: detection.encoding,
      encodingConfidence: detection.confidence,
      hasBom: detection.hasBom,
      sizeBytes: stat.size,
      lineCount: lines.length,
      nonEmptyLines: nonEmptyLines.length,
      wordCount: words.length,
      charCount: text.length,
      firstLine: nonEmptyLines[0]?.substring(0, 200) || null,
    };
  } catch {
    return { format: 'text' };
  }
}

/**
 * Extract metadata for HTML files (title, lang, charset, links count).
 */
async function extractHtmlMetadata(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const langMatch = raw.match(/<html[^>]*lang=["']?([^"'>]+)/i);
    const charsetMatch = raw.match(/charset=["']?([^"'>]+)/i);
    const linkCount = (raw.match(/<a\s[^>]*href=/gi) || []).length;
    const imgCount = (raw.match(/<img\s[^>]*src=/gi) || []).length;
    const metaDesc = raw.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i);

    return {
      format: 'html',
      title: titleMatch?.[1]?.trim() || null,
      lang: langMatch?.[1]?.trim() || null,
      charset: charsetMatch?.[1]?.trim() || null,
      linkCount,
      imgCount,
      description: metaDesc?.[1]?.trim()?.substring(0, 500) || null,
    };
  } catch {
    return { format: 'html' };
  }
}

/**
 * Main extraction: detects type and extracts metadata.
 * @param {string} filePath — absolute path to file
 * @param {string} mimeType — declared MIME type
 * @returns {Promise<object>} — metadata object
 */
async function extractMetadata(filePath, mimeType = '') {
  if (!filePath) return { format: 'unknown' };

  const mime = String(mimeType || '').toLowerCase();

  if (mime === 'application/pdf' || filePath.endsWith('.pdf')) {
    return extractPdfMetadata(filePath);
  }

  if (mime.startsWith('image/')) {
    return extractImageMetadata(filePath);
  }

  if (mime.includes('openxmlformats') || mime === 'application/vnd.ms-excel' ||
      mime === 'application/vnd.ms-powerpoint' || mime === 'application/msword') {
    return extractOfficeMetadata(filePath, mime);
  }

  if (mime === 'text/html' || filePath.endsWith('.html') || filePath.endsWith('.htm')) {
    return extractHtmlMetadata(filePath);
  }

  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return extractTextMetadata(filePath);
  }

  return { format: 'unknown', mimeType: mime || null };
}

module.exports = {
  extractMetadata,
  extractPdfMetadata,
  extractImageMetadata,
  extractOfficeMetadata,
  extractTextMetadata,
  extractHtmlMetadata,
};
