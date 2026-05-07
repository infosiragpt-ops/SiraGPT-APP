'use strict';

const path = require('path');

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

function safeFileSegment(value, { allowedExtensions = null } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ''));
  } catch {
    return null;
  }

  if (!decoded || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
    return null;
  }
  if (decoded !== path.basename(decoded) || decoded === '.' || decoded === '..' || decoded.includes('..')) {
    return null;
  }
  if (!SAFE_SEGMENT_RE.test(decoded)) return null;

  if (allowedExtensions) {
    const ext = path.extname(decoded).toLowerCase();
    const allowed = new Set(allowedExtensions.map((item) => String(item).toLowerCase()));
    if (!allowed.has(ext)) return null;
  }

  return decoded;
}

function resolveConfinedFile(baseDir, rawFilename, options = {}) {
  const filename = safeFileSegment(rawFilename, options);
  if (!filename) return null;

  const base = path.resolve(baseDir);
  const filePath = path.resolve(base, filename);
  const relative = path.relative(base, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return { filename, filePath };
}

function contentDispositionHeader(disposition, filename) {
  const fallback = safeFileSegment(filename) || 'download';
  return `${disposition}; filename="${fallback}"`;
}

module.exports = {
  contentDispositionHeader,
  resolveConfinedFile,
  safeFileSegment,
};
