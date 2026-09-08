const path = require('path');
const {
  DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS,
  MAX_SAFE_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');

const MB = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 100;
// Audio/video travel in chunks (see chunked-upload-store) and are transcribed
// server-side, so they get their own, much larger cap.
const DEFAULT_MAX_MEDIA_UPLOAD_MB = 2048;
const DEFAULT_MAX_UPLOAD_FILES = DEFAULT_MAX_SIMULTANEOUS_DOCUMENTS;

/**
 * Upload type policy — "any format".
 *
 * The chat accepts EVERY file format: unknown MIME types, unknown
 * extensions, code, archives, binaries and extension-less files. What is
 * still enforced, in this order:
 *   1. filename sanitisation (no path separators / control characters),
 *   2. Office lock-file detection (`~$doc.docx`),
 *   3. the configured size ceiling,
 *   4. byte-level integrity for KNOWN extensions — a `.pdf` whose magic bytes
 *      say "Windows executable" or a `.docx` that is really a PDF is rejected
 *      (`extension_mime_mismatch`) because every downstream parser would
 *      choke on it and it is the classic disguise trick.
 * Everything else is accepted and classified: `executable` (binaries and
 * scripts the OS/browser could run) and `activeContent` (HTML/SVG/XML) are
 * reported so the serving layer can force `Content-Disposition: attachment`
 * instead of rendering them inline on this origin. Nothing uploaded is ever
 * executed server-side; unknown types are stored opaque and text-like files
 * are read as text by fileProcessor.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Native binaries / installers
  'exe', 'dll', 'msi', 'msp', 'com', 'scr', 'pif', 'cpl', 'sys', 'drv',
  'app', 'elf', 'so', 'dylib', 'bin', 'run', 'appimage', 'dmg', 'pkg',
  'deb', 'rpm', 'apk', 'ipa', 'xap', 'jar', 'war', 'wasm',
  // Shell / OS scripts and shortcuts
  'bat', 'cmd', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'fish',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs',
  'wsf', 'wsh', 'hta', 'lnk', 'url', 'scf', 'reg', 'inf', 'gadget', 'msc',
  // Interpreted code
  'py', 'pyc', 'pyo', 'pyw', 'pl', 'pm', 'rb', 'rbm', 'lua', 'php', 'php3',
  'php4', 'php5', 'phtml', 'cgi',
]);

// Magic-byte MIME types that mean "this is a program", whatever the name.
const EXECUTABLE_MIMES = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-elf',
  'application/x-sharedlib',
  'application/x-pie-executable',
  'application/x-mach-binary',
  'application/x-mach-o-binary',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-debian-package',
  'application/x-rpm',
  'application/x-msi',
  'application/x-ms-installer',
  'application/wasm',
  'application/x-sh',
  'application/x-shellscript',
  'text/x-shellscript',
  'application/x-python-code',
  'application/x-bat',
  'application/x-msdos-program',
]);

// Extensions a browser would render as a document with script access to
// this origin if served inline. Downloaded instead (see shouldForceDownload).
const ACTIVE_CONTENT_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml',
  'svg', 'svgz', 'xml', 'xsl', 'xslt', 'xht',
]);

// Characters that are dangerous in filenames (path traversal, shell injection, etc.).
// Do not reject a harmless double-dot inside the *basename* (for example
// macOS screenshots sometimes arrive as `... p. m..png`). Path traversal is
// handled below by rejecting directory separators and literal `.` / `..` names.
const DANGEROUS_FILENAME_PATTERN = /[\0\r\n\x00-\x1f<>:"|?*\\/]/;

// Known-type tables. Used for MIME canonicalisation, parser routing hints
// and the known-extension integrity check — NOT as an allowlist (see the
// policy note above: every format is accepted).
const ALLOWED_MIMES = new Set([
  // Images
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/svg+xml',
  'image/heic', 'image/heif',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // OpenDocument
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Plain text + structured text
  'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown',
  'text/html', 'text/xml', 'application/xml',
  'application/json',
  'application/rtf', 'text/rtf',
  // Email
  'message/rfc822',
  'application/vnd.ms-outlook',
  // Audio
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/opus', 'application/ogg',
  'audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  // Video
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
  // Ebooks / Academic
  // Ebooks / Academic
  'application/epub+zip',
  'application/x-tex', 'application/x-latex',
  // Archives
  'application/zip',
]);

const ALLOWED_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'svg', 'heic', 'heif',
  // Office / OpenDocument
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
  // Text
  'txt', 'md', 'markdown', 'csv', 'tsv', 'rtf',
  // Web/structured
  'html', 'htm', 'json', 'xml',
  // Email
  'eml', 'msg',
  // Media
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'webm', 'mp4', 'm4a', 'mov', 'mpeg', 'mpg',
  // Ebooks / Academic
  // Ebooks / Academic
  'epub', 'tex', 'latex',
  // Archives
  'zip',
]);

const EXTENSION_TO_MIMES = new Map([
  ['jpg', new Set(['image/jpeg', 'image/jpg'])],
  ['jpeg', new Set(['image/jpeg', 'image/jpg'])],
  ['png', new Set(['image/png'])],
  ['gif', new Set(['image/gif'])],
  ['webp', new Set(['image/webp'])],
  ['bmp', new Set(['image/bmp'])],
  ['tif', new Set(['image/tiff'])],
  ['tiff', new Set(['image/tiff'])],
  ['svg', new Set(['image/svg+xml', 'application/xml', 'text/xml'])], // some detectors report SVG as generic XML
  ['heic', new Set(['image/heic', 'image/heif'])],
  ['heif', new Set(['image/heif', 'image/heic'])],
  ['pdf', new Set(['application/pdf'])],
  ['doc', new Set(['application/msword'])],
  ['docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'])],
  ['xls', new Set(['application/vnd.ms-excel', 'application/msexcel'])],
  ['ppt', new Set(['application/vnd.ms-powerpoint'])],
  ['pptx', new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'])],
  ['odt', new Set(['application/vnd.oasis.opendocument.text'])],
  ['ods', new Set(['application/vnd.oasis.opendocument.spreadsheet'])],
  ['odp', new Set(['application/vnd.oasis.opendocument.presentation'])],
  ['txt', new Set(['text/plain'])],
  ['md', new Set(['text/markdown', 'text/plain'])],
  ['markdown', new Set(['text/markdown', 'text/plain'])],
  ['csv', new Set(['text/csv', 'text/plain', 'application/csv'])],
  ['tsv', new Set(['text/tab-separated-values', 'text/plain'])],
  ['rtf', new Set(['application/rtf', 'text/rtf'])],
  ['html', new Set(['text/html', 'text/plain'])],
  ['htm', new Set(['text/html', 'text/plain'])],
  ['json', new Set(['application/json', 'text/plain'])],
  ['xml', new Set(['application/xml', 'text/xml', 'text/plain'])],
  ['eml', new Set(['message/rfc822', 'text/plain'])],
  ['msg', new Set(['application/vnd.ms-outlook'])],
  ['mp3', new Set(['audio/mpeg'])],
  ['wav', new Set(['audio/wav'])],
  ['ogg', new Set(['audio/ogg', 'application/ogg', 'audio/opus'])],
  ['oga', new Set(['audio/ogg', 'application/ogg'])],
  ['opus', new Set(['audio/opus', 'audio/ogg'])],
  ['webm', new Set(['audio/webm', 'video/webm'])],
  ['mp4', new Set(['audio/mp4', 'video/mp4'])],
  ['m4a', new Set(['audio/mp4'])],
  ['mov', new Set(['video/quicktime'])],
  ['mpeg', new Set(['video/mpeg'])],
  ['mpg', new Set(['video/mpeg'])],
  // Ebooks / Academic
  ['epub', new Set(['application/epub+zip'])],
  ['tex', new Set(['application/x-tex', 'application/x-latex'])],
  ['latex', new Set(['application/x-latex', 'application/x-tex'])],
  // Archives
  ['zip', new Set(['application/zip'])],
]);

const CANONICAL_EXTENSION_MIME = new Map([
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

const GENERIC_ARCHIVE_OR_BROWSER_MIMES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);

const ACTIVE_CONTENT_MIMES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'image/svg+xml',
]);

const OFFICE_LOCK_EXTENSIONS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveUploadLimits(env = process.env) {
  const explicitMb = positiveInteger(env.MAX_FILE_SIZE) || positiveInteger(env.UPLOAD_MAX_FILE_MB);
  const fileSize = explicitMb
    ? explicitMb * MB
    : (env.ALLOW_UNBOUNDED_UPLOADS === 'true' ? Number.POSITIVE_INFINITY : DEFAULT_MAX_UPLOAD_MB * MB);
  const files = Math.min(
    positiveInteger(env.MAX_UPLOAD_FILES) || DEFAULT_MAX_UPLOAD_FILES,
    MAX_SAFE_SIMULTANEOUS_DOCUMENTS,
  );
  const explicitMediaMb = positiveInteger(env.MAX_MEDIA_FILE_MB) || positiveInteger(env.UPLOAD_MAX_MEDIA_MB);
  const mediaFileSize = explicitMediaMb
    ? explicitMediaMb * MB
    : (Number.isFinite(fileSize) ? Math.max(fileSize, DEFAULT_MAX_MEDIA_UPLOAD_MB * MB) : fileSize);
  return { fileSize, files, mediaFileSize };
}

function isMediaMime(mime) {
  return /^(audio|video)\//i.test(normalizeMime(mime));
}

function isMediaExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  const accepted = EXTENSION_TO_MIMES.get(ext);
  if (!accepted) return false;
  for (const mime of accepted) if (isMediaMime(mime)) return true;
  return false;
}

function extensionFromName(filename) {
  const ext = path.extname(String(filename || '')).replace(/^\./, '').toLowerCase();
  return ext || null;
}

function normalizeMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function mimeMatchesExtension(mime, extension) {
  const ext = String(extension || '').toLowerCase();
  const normalized = normalizeMime(mime);
  if (!ext || !normalized) return false;
  const accepted = EXTENSION_TO_MIMES.get(ext);
  return Boolean(accepted && accepted.has(normalized));
}

function canonicalMimeForAcceptedExtension(extension, declaredMime, detectedMime) {
  const ext = String(extension || '').toLowerCase();
  const canonical = CANONICAL_EXTENSION_MIME.get(ext);
  if (!canonical) return null;

  const declared = normalizeMime(declaredMime);
  const detected = normalizeMime(detectedMime);
  if (
    GENERIC_ARCHIVE_OR_BROWSER_MIMES.has(declared) ||
    GENERIC_ARCHIVE_OR_BROWSER_MIMES.has(detected) ||
    detected === canonical ||
    declared === canonical
  ) {
    return canonical;
  }
  return null;
}

/**
 * Pre-write gate used by multer's fileFilter. Every declared type is allowed
 * (the byte-level checks run post-write in validateUploadPolicy); the only
 * thing that can fail here is a filename that is not a plain basename.
 */
function isDeclaredUploadAllowed(file = {}) {
  const name = file.originalname || file.originalName || file.filename;
  if (name == null || name === '') return true; // multer fills a name later; policy re-checks it
  return sanitizeFilename(name) !== null;
}

function isActiveContentMime(mime) {
  return ACTIVE_CONTENT_MIMES.has(normalizeMime(mime));
}

function isActiveContentExtension(extension) {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  return ACTIVE_CONTENT_EXTENSIONS.has(ext);
}

function isExecutableExtension(extension) {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  return EXECUTABLE_EXTENSIONS.has(ext);
}

function isExecutableMime(mime) {
  return EXECUTABLE_MIMES.has(normalizeMime(mime));
}

/**
 * True when an upload should be served with `Content-Disposition: attachment`
 * (never rendered inline on this origin): native executables, scripts and
 * HTML/SVG/XML-like active content. `<img>` tags ignore the header, so image
 * previews of SVG uploads keep working; the viewer fetches text itself.
 */
function shouldForceDownload({ filename, extension, mimeType } = {}) {
  const ext = extension != null && extension !== ''
    ? String(extension).toLowerCase().replace(/^\./, '')
    : extensionFromName(filename);
  if (ext && (EXECUTABLE_EXTENSIONS.has(ext) || ACTIVE_CONTENT_EXTENSIONS.has(ext))) return true;
  const mime = normalizeMime(mimeType);
  return Boolean(mime && (EXECUTABLE_MIMES.has(mime) || ACTIVE_CONTENT_MIMES.has(mime)));
}

function sanitizeFilename(name) {
  if (!name) return null;
  const raw = String(name);
  // Reject directory components and control/shell-hostile characters, but allow
  // normal punctuation in the basename. The double-extension executable guard
  // below still catches `invoice.exe.pdf` and similar tricks.
  if (DANGEROUS_FILENAME_PATTERN.test(raw)) return null;
  // Strip to basename (remove any directory components)
  const base = path.basename(raw);
  // Reject empty after basename extraction
  if (!base || base === '.' || base === '..') return null;
  return base;
}

function isOfficeTemporaryLockFile(filename) {
  const base = path.basename(String(filename || '')).trim();
  const ext = extensionFromName(base);
  return Boolean(base.startsWith('~$') && ext && OFFICE_LOCK_EXTENSIONS.has(ext));
}

function validateUploadPolicy({
  originalName,
  declaredMime,
  detectedMime,
  detectionSource = 'fallback',
  size = 0,
  env = process.env,
} = {}) {
  const ext = extensionFromName(originalName);

  // ── Sanitize filename ──
  const safeName = sanitizeFilename(originalName);
  if (!safeName) {
    return {
      ok: false,
      code: 'invalid_filename',
      message: 'El nombre del archivo contiene caracteres no permitidos o rutas.',
      extension: ext,
      declaredMime: null,
      detectedMime: null,
    };
  }

  if (isOfficeTemporaryLockFile(safeName)) {
    return {
      ok: false,
      code: 'office_temp_lock_file',
      message: 'Ese no es el documento: es un archivo temporal de Microsoft Office de bloqueo (empieza con "~$" y suele pesar pocos bytes). Cierra Word/Excel/PowerPoint y selecciona el documento original con nombre normal, no el archivo de bloqueo.',
      extension: ext,
      declaredMime: normalizeMime(declaredMime) || null,
      detectedMime: normalizeMime(detectedMime) || null,
    };
  }

  const declared = normalizeMime(declaredMime);
  const detected = normalizeMime(detectedMime);
  const limits = resolveUploadLimits(env);
  const media = isMediaMime(detected) || isMediaMime(declared) || isMediaExtension(ext);
  const sizeLimit = media ? limits.mediaFileSize : limits.fileSize;

  if (Number.isFinite(sizeLimit) && Number(size || 0) > sizeLimit) {
    return {
      ok: false,
      code: 'file_too_large',
      message: `El archivo supera el limite configurado de ${Math.round(sizeLimit / MB)} MB.`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

  // ── Byte-level integrity for KNOWN extensions ──
  // Any format is accepted, but a file whose extension we understand must
  // actually contain that format: `report.pdf` with PE magic bytes or
  // `renamed.docx` that is really a PDF is rejected — parsers would choke
  // and it is the classic disguise trick. Unknown extensions skip this.
  if (detectionSource === 'magic-bytes' && ext && EXTENSION_TO_MIMES.has(ext) && !mimeMatchesExtension(detected, ext)) {
    return {
      ok: false,
      code: 'extension_mime_mismatch',
      message: `La extension .${ext} no coincide con el contenido detectado (${detected || 'desconocido'}).`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

  const extensionCanonicalMime = canonicalMimeForAcceptedExtension(ext, declared, detected);
  const normalizedMime = extensionCanonicalMime || (detectionSource === 'magic-bytes' && detected ? detected : declared);
  const mimeType = normalizedMime || declared || 'application/octet-stream';
  const executable = isExecutableExtension(ext) || isExecutableMime(detected) || isExecutableMime(declared);
  const activeContent = isActiveContentMime(mimeType) || isActiveContentExtension(ext);
  return {
    ok: true,
    code: 'accepted',
    extension: ext,
    declaredMime: declared || null,
    detectedMime: detected || null,
    mimeType,
    activeContent,
    executable,
    // Serving hint: never render executables / active content inline.
    forceDownload: executable || activeContent,
    knownType: ALLOWED_MIMES.has(mimeType) || ALLOWED_EXTENSIONS.has(ext),
    limits,
  };
}

module.exports = {
  isMediaMime,
  DEFAULT_MAX_MEDIA_UPLOAD_MB,
  // Known-type tables are kept for parsers, canonicalisation and the
  // extension↔magic-byte integrity check. They are NOT an allowlist anymore.
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  ACTIVE_CONTENT_EXTENSIONS,
  ACTIVE_CONTENT_MIMES,
  DEFAULT_MAX_UPLOAD_FILES,
  DEFAULT_MAX_UPLOAD_MB,
  EXECUTABLE_EXTENSIONS,
  EXECUTABLE_MIMES,
  EXTENSION_TO_MIMES,
  canonicalMimeForAcceptedExtension,
  extensionFromName,
  isActiveContentExtension,
  isActiveContentMime,
  isDeclaredUploadAllowed,
  isExecutableExtension,
  isExecutableMime,
  isOfficeTemporaryLockFile,
  mimeMatchesExtension,
  normalizeMime,
  resolveUploadLimits,
  sanitizeFilename,
  shouldForceDownload,
  validateUploadPolicy,
};
