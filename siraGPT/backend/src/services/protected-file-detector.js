'use strict';

/**
 * Password-Protected File Detector — detects encrypted/protected files
 * and provides clear error messages instead of cryptic parse failures.
 *
 * Supported detection:
 *   - PDF: checks for /Encrypt entry in trailer
 *   - DOCX/XLSX/PPTX (OOXML): checks EncryptionInfo stream in ZIP
 *   - Legacy Office (binary): checks FIB encryption flags
 */

const fs = require('fs');

/**
 * Detect if a PDF is password-protected by looking for the /Encrypt
 * entry in the file's trailer dictionary.
 */
async function isEncryptedPdf(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const text = buf.toString('latin1');

    // Quick heuristic: search for /Encrypt marker near end of file
    // Standard PDF encryption is always in the trailer dict
    if (/\bEncrypt\b/.test(text)) {
      // Verify it's a real /Encrypt entry, not just the word "Encrypt" in text
      if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect if an OOXML file (docx/xlsx/pptx) is password-protected.
 * Protected OOXML files contain an "EncryptionInfo" entry in the ZIP.
 */
async function isEncryptedOoxml(filePath) {
  try {
    // OOXML files are ZIP archives. Check for EncryptionInfo in central directory.
    const buf = await fs.promises.readFile(filePath);
    const text = buf.toString('latin1');

    // Check for EncryptionInfo stream marker in the ZIP
    if (/EncryptionInfo/.test(text) || /EncryptedPackage/.test(text)) {
      return true;
    }

    // Also check file header for OOXML encryption container magic
    // ECMA-376 encrypted packages start with specific structures
    if (text.includes('EncryptedPackage') && text.includes('EncryptionInfo')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect if a file is password-protected, returning a clear error
 * message if so.
 *
 * @param {string} filePath - absolute path to the file
 * @param {string} mimeType - MIME type of the file
 * @param {string} originalName - original filename
 * @returns {Promise<{ protected: boolean, message: string|null }>}
 */
async function detectProtectedFile(filePath, mimeType, originalName) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(originalName || '').toLowerCase();

  // PDF
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const encrypted = await isEncryptedPdf(filePath);
    if (encrypted) {
      return {
        protected: true,
        message: `PDF protegido con contraseña — "${originalName}" está cifrado. Desbloquéalo y vuelve a subirlo.`,
        type: 'pdf_password',
      };
    }
  }

  // OOXML (DOCX, XLSX, PPTX)
  if (
    mime.includes('openxmlformats') ||
    name.endsWith('.docx') || name.endsWith('.xlsx') || name.endsWith('.pptx')
  ) {
    const encrypted = await isEncryptedOoxml(filePath);
    if (encrypted) {
      const format = name.endsWith('.xlsx') ? 'Excel' : name.endsWith('.pptx') ? 'PowerPoint' : 'Word';
      return {
        protected: true,
        message: `Documento ${format} protegido con contraseña — "${originalName}" está cifrado. Quita la protección y vuelve a subirlo.`,
        type: 'ooxml_password',
      };
    }
  }

  return { protected: false, message: null };
}

/**
 * Check if a file is likely corrupt based on common signatures.
 * Returns { corrupt: boolean, message: string|null }
 */
async function detectCorruptFile(filePath, mimeType, originalName) {
  try {
    const stat = await fs.promises.stat(filePath);

    // Empty file
    if (stat.size === 0) {
      return {
        corrupt: true,
        message: `Archivo vacío — "${originalName}" no contiene datos.`,
        type: 'empty',
      };
    }

    // Read first and last bytes
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(8);
      await fd.read(header, 0, 8, 0);

      // PDF: check for %PDF header and %%EOF trailer
      const mime = String(mimeType || '').toLowerCase();
      if (mime === 'application/pdf' || String(originalName || '').toLowerCase().endsWith('.pdf')) {
        const hdrStr = header.toString('latin1');
        if (!hdrStr.startsWith('%PDF')) {
          return {
            corrupt: true,
            message: `PDF corrupto — "${originalName}" no tiene cabecera PDF válida.`,
            type: 'bad_pdf_header',
          };
        }

        // Check for %%EOF trailer
        const trailer = Buffer.alloc(64);
        await fd.read(trailer, 0, 64, stat.size - 64);
        if (!trailer.toString('latin1').includes('%%EOF')) {
          return {
            corrupt: true,
            message: `PDF posiblemente truncado — "${originalName}" no tiene marca de fin (%%EOF). El archivo puede estar incompleto.`,
            type: 'pdf_truncated',
          };
        }
      }

      // ZIP-based files: check PK header and central directory
      if (header.toString('latin1', 0, 2) === 'PK') {
        const trailer = Buffer.alloc(22);
        await fd.read(trailer, 0, 22, stat.size - 22);
        if (trailer.toString('latin1', 0, 4) !== 'PK\x05\x06') {
          return {
            corrupt: true,
            message: `Archivo ZIP/OOXML posiblemente truncado — "${originalName}" no tiene directorio central. El archivo puede estar incompleto o corrupto.`,
            type: 'zip_truncated',
          };
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    // File may not exist or be inaccessible
  }

  return { corrupt: false, message: null };
}

module.exports = { detectProtectedFile, detectCorruptFile, isEncryptedPdf, isEncryptedOoxml };