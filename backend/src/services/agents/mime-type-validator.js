/**
 * mime-type-validator — phase 5 of the Validation Fabric.
 *
 * Catches the failure mode none of the structural validators reach:
 * an artifact whose MIME / extension claims one format but whose
 * magic bytes say another. The upload route already runs this check
 * on user-supplied files (see routes/files.js detectMime); this
 * validator runs the same gate on artifacts the agent / doc-pipeline
 * generates, so we never hand the chat a "Validado" .docx that is
 * actually a PDF the LLM accidentally wrote, or a .xlsx that is a
 * truncated zero-byte stub.
 *
 * Why this is its own validator instead of reusing detectMime: the
 * upload path *corrects* a wrong mime to whatever the magic bytes
 * say. At delivery time we want the opposite — we want to reject
 * the file when delivery and content disagree, because the route /
 * the chip / the OpenAI Files API will all key off the declared
 * mime, and a mismatch produces a "looks fine, breaks downstream"
 * silent failure.
 *
 * Public API:
 *   detectFileType(buffer) -> { ok, ext?, mime?, reason? }
 *   validateMimeType({ buffer, declaredMime, declaredExtension })
 *     -> { ok, reason?, declaredMime, declaredExtension,
 *          detectedMime, detectedExtension }
 */

let _fileTypePromise = null;
function loadFileType() {
  if (!_fileTypePromise) {
    _fileTypePromise = import('file-type').catch((err) => {
      _fileTypePromise = null;
      throw err;
    });
  }
  return _fileTypePromise;
}

/**
 * MIMEs that file-type either reports as a more general type than
 * what the OOXML container actually is (DOCX/XLSX/PPTX inside ZIP
 * → file-type sniffs the [Content_Types].xml to pick the right one,
 * but older versions returned `application/zip`), or that we
 * deliberately accept as equivalent for the validator's purposes.
 *
 * Each entry maps a *declared* mime to a set of *detected* mimes
 * we treat as a passing match.
 */
const EQUIVALENT_MIMES = new Map([
  // DOCX / XLSX / PPTX live inside ZIP containers; older file-type
  // versions returned 'application/zip' for these. New ones get the
  // OOXML mime right, but accept both so a runner pinning the older
  // version still passes.
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip']),
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip']),
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip']),
  ],
  // Plain text formats — file-type returns null for these (no magic
  // bytes), and we trust the declaration. CSV/MD/TXT/HTML all share
  // this property.
]);

// Formats with no magic-byte signature. file-type returns null for
// these and we have no choice but to trust the declared mime —
// nothing visible in the bytes tells PDF apart from a zero-byte
// allocation in those families. The upload allowlist + fileFilter
// (multer) already enforce the declared shape at the entry point.
const MAGICLESS_DECLARED_MIMES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/rtf',
  'text/rtf',
  'image/svg+xml',
]);

const EXTENSION_TO_MIME = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc:  'application/msword',
  xls:  'application/vnd.ms-excel',
  ppt:  'application/vnd.ms-powerpoint',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  csv:  'text/csv',
  md:   'text/markdown',
  txt:  'text/plain',
  html: 'text/html',
  htm:  'text/html',
  json: 'application/json',
  xml:  'application/xml',
};

function normaliseExtension(ext) {
  if (!ext || typeof ext !== 'string') return null;
  return ext.replace(/^\./, '').toLowerCase().trim() || null;
}

async function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'empty_buffer' };
  }
  let detected;
  try {
    const ft = await loadFileType();
    detected = await ft.fileTypeFromBuffer(buffer);
  } catch (err) {
    return { ok: false, reason: `file_type_failed: ${err.message || 'unknown'}` };
  }
  if (!detected) {
    return { ok: true, ext: null, mime: null };
  }
  return { ok: true, ext: detected.ext, mime: detected.mime };
}

function mimesAreEquivalent(declared, detected) {
  if (!declared || !detected) return false;
  if (declared === detected) return true;
  const accepted = EQUIVALENT_MIMES.get(declared);
  if (accepted && accepted.has(detected)) return true;
  return false;
}

/**
 * Validate that the bytes match the declared mime/extension. Returns
 *   { ok: true,  declaredMime, declaredExtension, detectedMime,
 *     detectedExtension }
 * on a clean match, or
 *   { ok: false, reason, ... }
 * with one of:
 *   - 'empty_buffer'           buffer was 0 bytes / not a Buffer
 *   - 'magic_bytes_unreadable' file-type threw (bad parser / OOM)
 *   - 'declared_extension_unknown' the declared ext wasn't in our
 *                                  EXTENSION_TO_MIME table
 *   - 'magic_bytes_missing'    bytes have no recognisable signature
 *                              and the format isn't in the
 *                              MAGICLESS_DECLARED_MIMES set
 *   - 'mime_mismatch'          detected !== declared and not in the
 *                              equivalence table
 */
async function validateMimeType({ buffer, declaredMime, declaredExtension } = {}) {
  const declared = (declaredMime || '').toLowerCase().trim();
  const ext = normaliseExtension(declaredExtension);

  // Resolve a working "declared mime" — caller can pass either the
  // mime, the extension, or both; we normalise so the comparison
  // doesn't mind which.
  let resolvedDeclaredMime = declared;
  if (!resolvedDeclaredMime && ext) {
    resolvedDeclaredMime = EXTENSION_TO_MIME[ext] || '';
  }
  if (!resolvedDeclaredMime) {
    return {
      ok: false,
      reason: 'declared_extension_unknown',
      declaredMime: declared || null,
      declaredExtension: ext,
      detectedMime: null,
      detectedExtension: null,
    };
  }

  const detection = await detectFileType(buffer);
  if (!detection.ok) {
    return {
      ok: false,
      reason: detection.reason || 'magic_bytes_unreadable',
      declaredMime: resolvedDeclaredMime,
      declaredExtension: ext,
      detectedMime: null,
      detectedExtension: null,
    };
  }

  // Magic-less format (CSV/MD/TXT/JSON/XML/SVG plain text) — trust
  // the declared mime since there are no bytes to disagree with.
  if (!detection.mime) {
    if (MAGICLESS_DECLARED_MIMES.has(resolvedDeclaredMime)) {
      return {
        ok: true,
        declaredMime: resolvedDeclaredMime,
        declaredExtension: ext,
        detectedMime: null,
        detectedExtension: null,
      };
    }
    return {
      ok: false,
      reason: 'magic_bytes_missing',
      declaredMime: resolvedDeclaredMime,
      declaredExtension: ext,
      detectedMime: null,
      detectedExtension: null,
    };
  }

  if (mimesAreEquivalent(resolvedDeclaredMime, detection.mime)) {
    return {
      ok: true,
      declaredMime: resolvedDeclaredMime,
      declaredExtension: ext,
      detectedMime: detection.mime,
      detectedExtension: detection.ext,
    };
  }

  return {
    ok: false,
    reason: 'mime_mismatch',
    declaredMime: resolvedDeclaredMime,
    declaredExtension: ext,
    detectedMime: detection.mime,
    detectedExtension: detection.ext,
  };
}

module.exports = {
  detectFileType,
  validateMimeType,
  mimesAreEquivalent,
  EXTENSION_TO_MIME,
  EQUIVALENT_MIMES,
  MAGICLESS_DECLARED_MIMES,
};
