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
const {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  isDeclaredUploadAllowed,
  resolveUploadLimits,
} = require('../services/upload-security-policy');

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

// File filter — accepts the full multimodal-ingestion allowlist.
// The post-write route revalidates bytes and extension with
// upload-security-policy before extraction/RAG/OpenAI upload.
const fileFilter = (req, file, cb) => {
  // Normalise the filename encoding *here* — fileFilter runs before
  // storage.filename, so the extension parse and every downstream
  // consumer (Prisma row, OpenAI files.create, response payload,
  // chat preview alt text) all see the same clean UTF-8 string.
  file.originalname = fixLatin1Filename(file.originalname);
  if (isDeclaredUploadAllowed(file)) {
    return cb(null, true);
  }
  const mime = (file.mimetype || '').toLowerCase();
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  return cb(new Error(`Tipo no permitido: ${mime || ext || 'desconocido'}`), false);
};

// Per-file size policy:
//   - MAX_FILE_SIZE env var (megabytes, integer > 0): enforce that cap.
//   - UPLOAD_MAX_FILE_MB env var can be used when MAX_FILE_SIZE is
//     reserved by the deploy platform.
//   - Default is a commercial safety ceiling (100 MB/file) to avoid
//     disk/memory exhaustion. Set ALLOW_UNBOUNDED_UPLOADS=true only in
//     isolated/internal deployments with separate storage quotas.
const uploadLimits = resolveUploadLimits(process.env);

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: uploadLimits.fileSize,
    files: uploadLimits.files, // multimodal ingestion can batch
  },
});

module.exports = upload;
module.exports.uploadDir = uploadDir;
// The effective per-request file-count ceiling multer actually enforces. Routes
// derive their `.array(field, maxCount)` from this so the advertised batch size
// never exceeds what the instance accepts (otherwise large batches were silently
// rejected with LIMIT_FILE_COUNT before the route's higher maxCount applied).
module.exports.filesLimit = uploadLimits.files;
module.exports.resolveUserUploadDir = resolveUserUploadDir;
module.exports.safeStorageSegment = safeStorageSegment;
module.exports.fixLatin1Filename = fixLatin1Filename;
// Exposed so the post-magic-byte check in routes/files.js can re-validate
// the *real* detected mime against the same allowlist the multer pre-gate
// uses, without duplicating the list.
module.exports.ALLOWED_MIMES = ALLOWED_MIMES;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
