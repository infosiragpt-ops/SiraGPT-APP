const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(uploadDir, req.user.id);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// File filter — accepts the full multimodal-ingestion allowlist.
// Validates by MIME first; falls back to extension when the browser
// reports octet-stream / empty (common for clipboard pastes, drag from
// some non-Finder sources, and HEIC files on Linux/Windows).
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
  'text/plain', 'text/csv', 'text/markdown',
  'text/html', 'text/xml', 'application/xml',
  'application/json',
  'application/rtf', 'text/rtf',
  // Email
  'message/rfc822',
  'application/vnd.ms-outlook',
  // Audio (used for STT + voice)
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
  // Video
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
]);

// Extension-based fallback when MIME is missing/wrong. Lowercase, no dot.
const ALLOWED_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'svg', 'heic', 'heif',
  // Office / OpenDocument
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
  // Text
  'txt', 'md', 'markdown', 'csv', 'rtf',
  // Web/structured
  'html', 'htm', 'json', 'xml',
  // Email
  'eml', 'msg',
  // Media
  'mp3', 'wav', 'ogg', 'webm', 'mp4', 'm4a', 'mov', 'mpeg', 'mpg',
]);

const fileFilter = (req, file, cb) => {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();

  if (ALLOWED_MIMES.has(mime) || ALLOWED_EXTENSIONS.has(ext)) {
    return cb(null, true);
  }
  return cb(new Error(`Tipo no permitido: ${mime || ext || 'desconocido'}`), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024 || 50 * 1024 * 1024, // 50MB default
    files: 10, // Up to 10 files per request — multimodal ingestion can batch
  },
});

module.exports = upload;
