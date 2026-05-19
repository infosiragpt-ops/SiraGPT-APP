const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
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
module.exports.resolveUserUploadDir = resolveUserUploadDir;
module.exports.safeStorageSegment = safeStorageSegment;
// Exposed so the post-magic-byte check in routes/files.js can re-validate
// the *real* detected mime against the same allowlist the multer pre-gate
// uses, without duplicating the list.
module.exports.ALLOWED_MIMES = ALLOWED_MIMES;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
