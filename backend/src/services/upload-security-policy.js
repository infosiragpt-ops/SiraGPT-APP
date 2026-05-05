const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_MB = 100;
const DEFAULT_MAX_UPLOAD_FILES = 10;

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif',
  'sh', 'bash', 'zsh', 'dash',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'py', 'pyc', 'pyo',
  'pl', 'pm', 'rb', 'rbm', 'lua', 'php', 'php3', 'php4', 'phtml',
  'app', 'elf', 'wasm',
  'reg', 'inf',
]);

// Characters that are dangerous in filenames (path traversal, shell injection, etc.)
const DANGEROUS_FILENAME_PATTERN = /[\0\r\n\x00-\x1f<>:"|?*\\]|(\.\.)/;

const ALLOWED_MIMES = new Set([
  // Images
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/svg+xml',
  'image/heic', 'image/heif',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
  // Video
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
]);

const ALLOWED_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'svg', 'heic', 'heif',
  // Office / OpenDocument
  'pdf', 'doc', 'docx', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
  // Text
  'txt', 'md', 'markdown', 'csv', 'tsv', 'rtf',
  // Web/structured
  'html', 'htm', 'json', 'xml',
  // Email
  'eml', 'msg',
  // Media
  'mp3', 'wav', 'ogg', 'webm', 'mp4', 'm4a', 'mov', 'mpeg', 'mpg',
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
  ['svg', new Set(['image/svg+xml'])],
  ['heic', new Set(['image/heic', 'image/heif'])],
  ['heif', new Set(['image/heif', 'image/heic'])],
  ['pdf', new Set(['application/pdf'])],
  ['doc', new Set(['application/msword'])],
  ['docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'])],
  ['xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'])],
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
  ['ogg', new Set(['audio/ogg'])],
  ['webm', new Set(['audio/webm', 'video/webm'])],
  ['mp4', new Set(['audio/mp4', 'video/mp4'])],
  ['m4a', new Set(['audio/mp4'])],
  ['mov', new Set(['video/quicktime'])],
  ['mpeg', new Set(['video/mpeg'])],
  ['mpg', new Set(['video/mpeg'])],
]);

const ACTIVE_CONTENT_MIMES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'image/svg+xml',
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
  const files = Math.min(positiveInteger(env.MAX_UPLOAD_FILES) || DEFAULT_MAX_UPLOAD_FILES, 25);
  return { fileSize, files };
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

function isDeclaredUploadAllowed(file = {}) {
  const declaredMime = normalizeMime(file.mimetype || file.mimeType);
  const ext = extensionFromName(file.originalname || file.originalName || file.filename);
  return ALLOWED_MIMES.has(declaredMime) || ALLOWED_EXTENSIONS.has(ext);
}

function isActiveContentMime(mime) {
  return ACTIVE_CONTENT_MIMES.has(normalizeMime(mime));
}

function sanitizeFilename(name) {
  if (!name) return null;
  // Reject path traversal ("/" "..") and control characters
  if (DANGEROUS_FILENAME_PATTERN.test(name)) return null;
  // Strip to basename (remove any directory components)
  const base = path.basename(String(name));
  // Reject empty after basename extraction
  if (!base || base === '.' || base === '..') return null;
  return base;
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
  const declared = normalizeMime(declaredMime);
  const detected = normalizeMime(detectedMime);
  const limits = resolveUploadLimits(env);

  if (Number.isFinite(limits.fileSize) && Number(size || 0) > limits.fileSize) {
    return {
      ok: false,
      code: 'file_too_large',
      message: `El archivo supera el limite configurado de ${Math.round(limits.fileSize / MB)} MB.`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

  // ── Reject executable extensions explicitly ──
  if (ext && EXECUTABLE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: 'executable_not_allowed',
      message: `Archivos ejecutables (.${ext}) no estan permitidos por seguridad.`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

  if (!ALLOWED_MIMES.has(declared) && !ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: 'declared_type_not_allowed',
      message: `Tipo no permitido: ${declared || ext || 'desconocido'}.`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

  if (detectionSource === 'magic-bytes' && !ALLOWED_MIMES.has(detected)) {
    return {
      ok: false,
      code: 'detected_type_not_allowed',
      message: `Tipo real del archivo no permitido (${detected || 'desconocido'}).`,
      extension: ext,
      declaredMime: declared || null,
      detectedMime: detected || null,
    };
  }

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

  // ── Check for double extension tricks (e.g., file.pdf.exe) ──
  if (originalName && ext) {
    const base = path.basename(originalName, path.extname(originalName));
    const innerExt = path.extname(base).replace(/^\./, '').toLowerCase();
    if (innerExt && EXECUTABLE_EXTENSIONS.has(innerExt)) {
      return {
        ok: false,
        code: 'double_extension_executable',
        message: `El archivo parece tener una extension ejecutable oculta (.${innerExt}).`,
        extension: ext,
        declaredMime: declared || null,
        detectedMime: detected || null,
      };
    }
  }

  // ── Reject misnamed executables (e.g., virus.exe renamed to virus.pdf) ──
  if (detectionSource === 'magic-bytes' && detected) {
    const detectedExt = extensionFromName(`x.${detected.split('/').pop()}`);
    if (detectedExt && EXECUTABLE_EXTENSIONS.has(detectedExt)) {
      return {
        ok: false,
        code: 'executable_disguised',
        message: `El contenido del archivo corresponde a un ejecutable (${detected}) disfrazado como .${ext}.`,
        extension: ext,
        declaredMime: declared || null,
        detectedMime: detected || null,
      };
    }
  }

  const normalizedMime = detectionSource === 'magic-bytes' && detected ? detected : declared;
  return {
    ok: true,
    code: 'accepted',
    extension: ext,
    declaredMime: declared || null,
    detectedMime: detected || null,
    mimeType: normalizedMime || declared || 'application/octet-stream',
    activeContent: isActiveContentMime(normalizedMime || declared),
    limits,
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  ACTIVE_CONTENT_MIMES,
  DEFAULT_MAX_UPLOAD_FILES,
  DEFAULT_MAX_UPLOAD_MB,
  EXECUTABLE_EXTENSIONS,
  EXTENSION_TO_MIMES,
  extensionFromName,
  isActiveContentMime,
  isDeclaredUploadAllowed,
  mimeMatchesExtension,
  normalizeMime,
  resolveUploadLimits,
  sanitizeFilename,
  validateUploadPolicy,
};
