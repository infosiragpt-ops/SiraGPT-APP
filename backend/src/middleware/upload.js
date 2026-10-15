const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Multer / busboy decodes the multipart `Content-Disposition; filename=...`
// header as latin1 by default (per the multipart spec). Modern browsers
// send the bytes as UTF-8, so the resulting `file.originalname` arrives
// mojibaked when the original name contained any non-ASCII character —
// curly quote U+2019 becomes `â€™`, NBSP becomes `Â `, etc. We detect
// that case heuristically (every char ≤ 255 = latin1-shaped) and re-
// decode the bytes as UTF-8 so the DB `originalName`, the chat preview
// alt text, and the disk filename all carry the human-readable name.
function fixLatin1Filename(name) {
  const s = String(name || '');
  if (!s) return s;
  // If any code point is outside latin1 (>255), the string was already
  // decoded as something other than latin1. Don't touch it — re-decoding
  // would corrupt valid multi-byte characters into U+FFFD replacements.
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) return s;
  }
  try {
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    // Reject decodes that introduced replacement characters — that
    // signals the bytes were not actually valid UTF-8 to begin with
    // (e.g. legitimately latin1-only filenames from old systems).
    if (decoded.includes('\uFFFD')) return s;
    return decoded;
  } catch {
    return s;
  }
}
const { PassThrough } = require('stream');
const {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  isDeclaredUploadAllowed,
  isMediaExtension,
  isMediaMime,
  resolveUploadLimits,
} = require('../services/upload-security-policy');

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Ensure upload directory exists
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function safeStorageSegment(value) {
  const segment = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(segment)) return null;
  if (segment === '.' || segment === '..' || segment.includes('..') || segment.includes('/') || segment.includes('\\')) {
    return null;
  }
  return segment;
}

function resolveUserUploadDir(userId) {
  const segment = safeStorageSegment(userId);
  if (!segment) return null;
  const candidate = path.resolve(uploadDir, segment);
  const relative = path.relative(uploadDir, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = resolveUserUploadDir(req.user?.id);
    if (!userDir) {
      return cb(new Error('Invalid upload owner'), null);
    }
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// File filter — EVERY format is accepted (documents, code, data, media,
// archives, binaries, extension-less files). The only pre-write rejection is
// a filename that is not a plain basename (path separators / control chars).
// The post-write route revalidates bytes with upload-security-policy
// (size, Office lock files, known-extension vs magic-byte integrity) before
// extraction/RAG/OpenAI upload, and classifies executables / active content
// so they are served as downloads instead of rendered inline.
const fileFilter = (req, file, cb) => {
  // Normalise the filename encoding *here* — fileFilter runs before
  // storage.filename, so the extension parse and every downstream
  // consumer (Prisma row, OpenAI files.create, response payload,
  // chat preview alt text) all see the same clean UTF-8 string.
  file.originalname = fixLatin1Filename(file.originalname);
  if (isDeclaredUploadAllowed(file)) {
    return cb(null, true);
  }
  const rejection = new Error('Nombre de archivo no válido: contiene rutas o caracteres no permitidos.');
  rejection.status = 400;
  rejection.code = 'invalid_filename';
  rejection.expose = true;
  return cb(rejection, false);
};

// Per-file size policy:
//   - MAX_FILE_SIZE env var (megabytes, integer > 0): enforce that cap.
//   - UPLOAD_MAX_FILE_MB env var can be used when MAX_FILE_SIZE is
//     reserved by the deploy platform.
//   - Default is a commercial safety ceiling (100 MB/file) to avoid
//     disk/memory exhaustion. Set ALLOW_UNBOUNDED_UPLOADS=true only in
//     isolated/internal deployments with separate storage quotas.
//   - Audio/video get their own, larger cap (mediaFileSize, 10 GB by
//     default): a 5 h lecture at 24-32 kbps weighs 54-72 MB, so a deploy with
//     MAX_FILE_SIZE=50 used to reject it here while the composer only
//     switched to chunked uploads from 80 MB.
const uploadLimits = resolveUploadLimits(process.env);

function finiteOrInfinity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

/** The busboy ceiling: the largest per-kind cap (media ≥ documents). */
function multerFileSizeLimit(limits = uploadLimits) {
  return Math.max(finiteOrInfinity(limits.fileSize), finiteOrInfinity(limits.mediaFileSize));
}

/** Audio/video by declared mime or extension (bytes are re-checked after the write). */
function isMediaUploadCandidate(file) {
  const ext = path.extname(String((file && file.originalname) || '')).replace(/^\./, '').toLowerCase();
  return isMediaMime(file && file.mimetype) || Boolean(ext && isMediaExtension(ext));
}

function perFileLimitFor(file, limits = uploadLimits) {
  return isMediaUploadCandidate(file) ? finiteOrInfinity(limits.mediaFileSize) : finiteOrInfinity(limits.fileSize);
}

function formatLimit(bytes) {
  if (!Number.isFinite(bytes)) return 'el máximo permitido';
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1).replace('.', ',')} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

const UPLOAD_LIMIT_TRIP = Symbol('siragpt.uploadLimitTrip');

function recordLimitTrip(req, file, media) {
  if (!req || req[UPLOAD_LIMIT_TRIP]) return;
  Object.defineProperty(req, UPLOAD_LIMIT_TRIP, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: { name: String((file && file.originalname) || '').slice(0, 120), media: Boolean(media) },
  });
}

/** Spanish LIMIT_FILE_SIZE copy naming the cap that applied to that file. */
function fileTooLargeMessage(trip, limits = uploadLimits) {
  const docCap = finiteOrInfinity(limits.fileSize);
  const mediaCap = finiteOrInfinity(limits.mediaFileSize);
  const named = trip && trip.name ? `El archivo «${trip.name}»` : 'El archivo';
  if (trip && trip.media) return `${named} supera el máximo de ${formatLimit(mediaCap)} para audio y video.`;
  if (trip) {
    const mediaHint = mediaCap > docCap ? ` Los audios y videos admiten hasta ${formatLimit(mediaCap)}.` : '';
    return `${named} supera el máximo de ${formatLimit(docCap)} por documento.${mediaHint}`;
  }
  return `${named} supera el tamaño máximo permitido (${formatLimit(multerFileSizeLimit(limits))}).`;
}

/**
 * Wraps the disk storage so each file is held to ITS kind's cap: busboy only
 * knows one limit per request (the media ceiling), so documents are counted
 * here and stopped at `fileSize` exactly like busboy would — the partial file
 * is closed, multer aborts with LIMIT_FILE_SIZE and removes it.
 */
function createKindAwareStorage(inner, limits = uploadLimits) {
  const ceiling = multerFileSizeLimit(limits);
  return {
    _handleFile(req, file, cb) {
      const source = file.stream;
      const media = isMediaUploadCandidate(file);
      const limit = perFileLimitFor(file, limits);
      if (!source || typeof source.on !== 'function') return inner._handleFile(req, file, cb);
      // busboy's own limit (the ceiling) fires 'limit' on the source too.
      source.on('limit', () => recordLimitTrip(req, file, media));
      if (!Number.isFinite(limit) || !(limit < ceiling)) return inner._handleFile(req, file, cb);

      const gate = new PassThrough();
      let seen = 0;
      let tripped = false;
      let sourceError = null;
      source.on('data', (chunk) => {
        if (tripped) return;
        seen += chunk.length;
        if (seen > limit) {
          tripped = true;
          gate.end();
          source.resume();
          source.emit('limit');
          return;
        }
        if (!gate.write(chunk)) {
          source.pause();
          gate.once('drain', () => { if (!tripped) source.resume(); });
        }
      });
      source.once('end', () => { if (!tripped) gate.end(); });
      source.once('error', (err) => {
        sourceError = err;
        if (!tripped) gate.end();
      });
      Object.defineProperty(file, 'stream', { configurable: true, enumerable: false, value: gate });
      inner._handleFile(req, file, (err, info) => {
        if (sourceError && !err && info && info.path) {
          fs.unlink(info.path, () => cb(sourceError));
          return;
        }
        cb(err, info);
      });
    },
    _removeFile(req, file, cb) {
      inner._removeFile(req, file, cb);
    },
  };
}

function localizeUploadError(err, req) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    err.message = fileTooLargeMessage(req && req[UPLOAD_LIMIT_TRIP]);
    err.expose = true;
  }
  return err;
}

const upload = multer({
  storage: createKindAwareStorage(storage, uploadLimits),
  fileFilter,
  limits: {
    fileSize: multerFileSizeLimit(uploadLimits),
    files: uploadLimits.files, // multimodal ingestion can batch
  },
});

// Every middleware this instance builds reports LIMIT_FILE_SIZE in Spanish,
// naming the cap that applied (documents vs audio/video).
for (const method of ['single', 'array', 'fields', 'any', 'none']) {
  if (typeof upload[method] !== 'function') continue;
  const build = upload[method].bind(upload);
  upload[method] = (...args) => {
    const middleware = build(...args);
    return function localizedUploadMiddleware(req, res, next) {
      return middleware(req, res, (err) => next(localizeUploadError(err, req)));
    };
  };
}

module.exports = upload;
module.exports.uploadDir = uploadDir;
// The effective per-request file-count ceiling multer actually enforces. Routes
// derive their `.array(field, maxCount)` from this so the advertised batch size
// never exceeds what the instance accepts (otherwise large batches were silently
// rejected with LIMIT_FILE_COUNT before the route's higher maxCount applied).
module.exports.filesLimit = uploadLimits.files;
// Per-kind size gate (documents vs audio/video) and its Spanish copy.
module.exports.uploadLimits = uploadLimits;
module.exports.multerFileSizeLimit = multerFileSizeLimit;
module.exports.perFileLimitFor = perFileLimitFor;
module.exports.fileTooLargeMessage = fileTooLargeMessage;
module.exports.createKindAwareStorage = createKindAwareStorage;
module.exports.resolveUserUploadDir = resolveUserUploadDir;
module.exports.safeStorageSegment = safeStorageSegment;
module.exports.fixLatin1Filename = fixLatin1Filename;
// Known-type tables (canonicalisation / parser hints). Kept exported for
// back-compat; they are no longer an allowlist — every format is accepted.
module.exports.ALLOWED_MIMES = ALLOWED_MIMES;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
