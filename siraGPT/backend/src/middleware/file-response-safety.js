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

function normaliseExtension(extension) {
  if (!extension) return null;
  const ext = String(extension).trim().toLowerCase();
  if (!/^\.[a-z0-9]{1,16}$/.test(ext)) return null;
  return ext;
}

function safeDownloadFilename(value, { fallback = 'download', extension = null } = {}) {
  const ext = normaliseExtension(extension);
  const fallbackExt = ext || path.extname(String(fallback || '')).toLowerCase();
  const fallbackStem = path.basename(String(fallback || 'download'), path.extname(String(fallback || 'download'))) || 'download';

  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ''));
  } catch {
    decoded = String(value || '');
  }

  let candidate = decoded.trim();
  if (!candidate) candidate = fallback;
  candidate = path.basename(candidate);
  candidate = candidate
    .replace(/[\0-\x1F\x7F]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  let stem = candidate;
  const currentExt = path.extname(candidate);
  if (currentExt) stem = candidate.slice(0, -currentExt.length);
  stem = stem.replace(/^[._-]+|[._-]+$/g, '') || fallbackStem.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'download';

  let filename = ext ? `${stem}${ext}` : `${stem}${currentExt || fallbackExt || ''}`;
  if (filename.length > 181) {
    const keepExt = ext || path.extname(filename);
    const maxStem = Math.max(1, 181 - keepExt.length);
    filename = `${stem.slice(0, maxStem).replace(/[._-]+$/g, '') || 'download'}${keepExt}`;
  }

  return safeFileSegment(filename, ext ? { allowedExtensions: [ext] } : {}) || (ext ? `download${ext}` : 'download');
}

function contentDispositionHeader(disposition, filename) {
  const fallback = safeFileSegment(filename) || 'download';
  return `${disposition}; filename="${fallback}"`;
}

function parseHttpByteRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;

  const size = Number(fileSize);
  const raw = String(rangeHeader).trim();
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);

  if (!Number.isSafeInteger(size) || size < 0 || !match || (!match[1] && !match[2])) {
    return { error: 'invalid', contentRange: `bytes */${Number.isFinite(size) && size >= 0 ? size : 0}` };
  }

  if (size === 0) {
    return { error: 'unsatisfiable', contentRange: 'bytes */0' };
  }

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { error: 'invalid', contentRange: `bytes */${size}` };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { error: 'invalid', contentRange: `bytes */${size}` };
    }
    end = Math.min(end, size - 1);
  }

  if (start < 0 || end < 0 || start > end || start >= size) {
    return { error: 'unsatisfiable', contentRange: `bytes */${size}` };
  }

  return {
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

module.exports = {
  contentDispositionHeader,
  parseHttpByteRange,
  resolveConfinedFile,
  safeFileSegment,
  safeDownloadFilename,
};
