'use strict';

/**
 * file-integrity-validator — validates uploaded files for corruption
 * and basic structural integrity before attempting full extraction.
 *
 * Runs quickly (sub-100ms for most files) and can pre-empt expensive
 * extraction failures with clear, actionable error messages.
 *
 * Checks performed:
 *   - Magic byte verification per format
 *   - ZIP/OOXML structure validation for Office docs
 *   - PDF header/trailer check
 *   - Image header validation (JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC)
 *   - Minimum file size sanity
 *   - Truncated/corrupt JSON detection
 */

const fs = require('fs');

const MAGIC_BYTES = {
  pdf:    { offset: 0, bytes: Buffer.from('%PDF'), label: 'PDF' },
  jpg:    { offset: 0, bytes: Buffer.from([0xFF, 0xD8, 0xFF]), label: 'JPEG' },
  png:    { offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]), label: 'PNG' },
  gif:    { offset: 0, bytes: Buffer.from([0x47, 0x49, 0x46, 0x38]), label: 'GIF' },
  webp:   { offset: 0, bytes: Buffer.from('RIFF'), label: 'WebP' },
  bmp:    { offset: 0, bytes: Buffer.from('BM'), label: 'BMP' },
  tiffLE: { offset: 0, bytes: Buffer.from([0x49, 0x49, 0x2A, 0x00]), label: 'TIFF/LE' },
  tiffBE: { offset: 0, bytes: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]), label: 'TIFF/BE' },
  zip:    { offset: 0, bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: 'ZIP/OOXML' },
  eml:    { offset: 0, bytes: Buffer.from('From '), label: 'Email', orMatch: /^(From:|Return-Path:|Date:|Subject:|MIME-Version:|Content-Type:)/mi },
};

const CORRUPTION_CHECKS = {
  pdf: {
    requireHeader: '%PDF-',
    requireTrailer: '%%EOF',
    minSize: 64,
    name: 'PDF',
  },
  json: {
    minSize: 2,
    name: 'JSON',
  },
};

/**
 * Read the first N bytes of a file for magic byte checking.
 */
async function readHeader(filePath, maxBytes = 8192) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/**
 * Check magic bytes against known signatures.
 * Returns { ok, matches[], format }.
 */
function checkMagicBytes(header) {
  if (!header || header.length < 2) return { ok: false, matches: [], format: null };

  const matches = [];
  for (const [format, spec] of Object.entries(MAGIC_BYTES)) {
    const chunk = header.slice(spec.offset, spec.offset + spec.bytes.length);
    if (spec.bytes.compare(chunk) === 0) {
      matches.push(format);
    }
    // Check regex orMatch
    if (spec.orMatch && spec.orMatch.test(header.toString('utf8', 0, Math.min(1024, header.length)))) {
      matches.push(format);
    }
  }

  return { ok: matches.length > 0, matches, format: matches[0] || null };
}

/**
 * Validate internal structure of specific formats.
 */
async function validateStructure(filePath, mimeType, fileSize) {
  const issues = [];
  const mt = String(mimeType || '').toLowerCase();

  // Validate PDF structure
  if (mt === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
    try {
      const header = await readHeader(filePath, 2048);
      const headerText = header.toString('utf8');

      if (!headerText.startsWith('%PDF-')) {
        issues.push({ code: 'corrupt_header', message: 'Not a valid PDF (missing %PDF- header)' });
      }

      // Check for %%EOF trailer
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 50) {
        const trailerBuf = Buffer.alloc(256);
        const fd = await fs.promises.open(filePath, 'r');
        try {
          const start = Math.max(0, stat.size - 256);
          await fd.read(trailerBuf, 0, 256, start);
          const trailer = trailerBuf.toString('utf8');
          if (!trailer.includes('%%EOF')) {
            issues.push({ code: 'missing_trailer', message: 'PDF may be truncated or corrupt (missing %%EOF)' });
          }
        } finally {
          await fd.close();
        }
      }

      if (fileSize < 50) {
        issues.push({ code: 'too_small', message: `PDF file is too small (${fileSize} bytes), likely corrupt or empty` });
      }
    } catch (err) {
      issues.push({ code: 'structure_read_error', message: `Failed to read PDF structure: ${err.message}` });
    }
  }

  // Validate ZIP/OOXML structure (DOCX, XLSX, PPTX, ODT, EPUB)
  if (mt.includes('openxmlformats') || mt.includes('oasis.opendocument') ||
      mt === 'application/epub+zip' ||
      (filePath.toLowerCase().match(/\.(docx|xlsx|pptx|odt|ods|odp|epub)$/))) {
    try {
      const stat = await fs.promises.stat(filePath);
      const header = await readHeader(filePath, 4);

      if (header[0] !== 0x50 || header[1] !== 0x4B) {
        issues.push({ code: 'not_zip', message: 'Office document is not a valid ZIP archive' });
      }

      if (stat.size < 100) {
        issues.push({ code: 'too_small', message: `Office document is too small (${stat.size} bytes), likely empty or corrupt` });
      }
    } catch (err) {
      issues.push({ code: 'zip_read_error', message: `Failed to validate ZIP structure: ${err.message}` });
    }
  }

  // Validate JSON structure (basic checks)
  if (mt === 'application/json' || filePath.toLowerCase().endsWith('.json')) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size < 2) {
        issues.push({ code: 'too_small', message: 'JSON file is too small or empty' });
      }
      if (stat.size > 20 * 1024 * 1024) {
        issues.push({ code: 'very_large', message: 'JSON file is very large (>20MB), parsing may be slow' });
      }
      const headerBytes = await readHeader(filePath, 4);
      // Only inspect the first byte when there IS one. For a 0-byte file
      // headerBytes[0] is undefined → String.fromCharCode(undefined) is NUL,
      // which failed the start-char check and added a spurious 'invalid_start'
      // issue on top of the accurate 'too_small'.
      if (headerBytes.length > 0) {
        const firstChar = String.fromCharCode(headerBytes[0]);
        if (firstChar !== '{' && firstChar !== '[' && firstChar !== '"') {
          issues.push({ code: 'invalid_start', message: 'JSON does not start with {, [, or "' });
        }
      }
    } catch (err) {
      issues.push({ code: 'json_read_error', message: `Failed to validate JSON: ${err.message}` });
    }
  }

  // Validate image headers
  if (mt.startsWith('image/')) {
    try {
      const header = await readHeader(filePath, 16);
      const magicResult = checkMagicBytes(header);

      if (!magicResult.ok) {
        issues.push({ code: 'invalid_magic', message: 'Image file has invalid or unknown magic bytes' });
      }

      if (fileSize < 30) {
        issues.push({ code: 'too_small', message: `Image file is too small (${fileSize} bytes), likely corrupt or empty` });
      }
    } catch (err) {
      issues.push({ code: 'image_read_error', message: `Failed to validate image: ${err.message}` });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    issueCount: issues.length,
  };
}

/**
 * Full validation of a file before extraction.
 *
 * @param {string} filePath — absolute path to file
 * @param {string} mimeType — declared MIME type
 * @param {number} fileSize — file size in bytes
 * @returns {Promise<{ valid: boolean, magicOk: boolean, structureOk: boolean, issues: object[], warnings: object[] }>}
 */
async function validateFile(filePath, mimeType = '', fileSize = 0) {
  const warnings = [];

  if (!filePath) {
    return {
      valid: false, magicOk: false, structureOk: false,
      issues: [{ code: 'no_path', message: 'No file path provided' }],
      warnings: [],
    };
  }

  // Check if file exists
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return {
      valid: false, magicOk: false, structureOk: false,
      issues: [{ code: 'not_found', message: `File not found or not readable: ${filePath}` }],
      warnings: [],
    };
  }

  // Get actual file size if not provided
  let actualSize = fileSize;
  if (!actualSize || actualSize <= 0) {
    try {
      const stat = await fs.promises.stat(filePath);
      actualSize = stat.size;
    } catch {
      return {
        valid: false, magicOk: false, structureOk: false,
        issues: [{ code: 'stat_failed', message: 'Failed to read file stats' }],
        warnings: [],
      };
    }
  }

  // Zero-byte file check
  if (actualSize === 0) {
    return {
      valid: false, magicOk: false, structureOk: false,
      issues: [{ code: 'empty_file', message: 'File is empty (0 bytes)' }],
      warnings: [],
    };
  }

  // Check magic bytes
  const header = await readHeader(filePath, 2048);
  const magicResult = checkMagicBytes(header);
  let magicOk = magicResult.ok;

  if (!magicResult.ok && actualSize > 100) {
    warnings.push({ code: 'unknown_magic', message: 'Unknown file format (no recognized magic bytes)', detectedFormat: magicResult.format });
  }

  // Validate internal structure
  const structureResult = await validateStructure(filePath, mimeType, actualSize);
  const structureOk = structureResult.valid;

  // Additional warnings
  if (actualSize > 500 * 1024 * 1024) {
    warnings.push({ code: 'very_large', message: `File is very large (${(actualSize / 1024 / 1024).toFixed(0)}MB), processing may be slow` });
  }

  if (actualSize < 10 && actualSize > 0) {
    warnings.push({ code: 'very_small', message: `File is very small (${actualSize} bytes), may not contain useful content` });
  }

  const allIssues = [...structureResult.issues];
  const valid = magicOk && structureOk;

  return {
    valid,
    magicOk,
    structureOk,
    issues: allIssues,
    warnings,
    magicResult: magicResult.matches,
    fileSize: actualSize,
  };
}

module.exports = {
  validateFile,
  checkMagicBytes,
  validateStructure,
  readHeader,
  MAGIC_BYTES,
};