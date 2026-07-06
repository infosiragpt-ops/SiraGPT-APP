const path = require('path');
const jwt = require('jsonwebtoken');

const PUBLIC_UPLOAD_PREFIXES = new Set([
  'audio',
  'images',
  'presentations',
]);

const BLOCKED_UPLOAD_PREFIXES = new Set([
  '_rendered',
  'document-pipeline',
  'screenshots',
  'temp',
]);

function normaliseUploadPath(requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestPath || '').split('?')[0]);
  } catch {
    return null;
  }

  const parts = decoded
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0') || part.includes('\\'))) {
    return null;
  }

  return parts.join('/');
}

function resolveConfinedPath(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(base, relativePath);
  const relative = path.relative(base, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

// A GPT avatar upload — multer names it `icon-<timestamp>-<hash>.<ext>` (the
// form fieldname is "icon"). It lives directly under the owner's dir but is
// shown in the PUBLIC GPT store, so it must be readable without the owner's
// token. The pattern is specific to GPT icon uploads; the files are
// non-sensitive avatars.
const GPT_ICON_FILE = /^icon-\d+-[0-9a-f]{6,}\.(png|jpe?g|gif|webp|svg|avif)$/i;

function classifyUploadPath(relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  const first = parts[0];

  if (!first || BLOCKED_UPLOAD_PREFIXES.has(first)) {
    return { kind: 'blocked' };
  }

  if (PUBLIC_UPLOAD_PREFIXES.has(first)) {
    return { kind: 'public' };
  }

  if (first === 'documents') {
    return parts[1] ? { kind: 'owned', userId: parts[1] } : { kind: 'blocked' };
  }

  // Public GPT avatar: `<userId>/icon-<ts>-<hash>.<ext>` (exactly two segments).
  if (parts.length === 2 && GPT_ICON_FILE.test(parts[1])) {
    return { kind: 'public' };
  }

  return { kind: 'owned', userId: first };
}

function tokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length).trim();
  // Cookies are sent automatically only when the cookie's domain matches
  // the request origin. In our split-host setup (frontend on one origin,
  // backend on another) the `token` cookie issued by the backend isn't
  // sent on `<img src="/uploads/...">` requests originating from the
  // frontend page. Allow callers to pass the JWT explicitly via the
  // `?token=` query string so authenticated media (images, video, etc.)
  // can be referenced from plain HTML elements that cannot set custom
  // Authorization headers. The token is still validated against the DB
  // session below, so this carries the same security properties as the
  // header-based path.
  const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (queryToken) return queryToken;
  return req.cookies?.token || null;
}

async function userFromToken({ token, jwtSecret, prisma }) {
  if (!token || !jwtSecret) return null;

  try {
    jwt.verify(token, jwtSecret);
  } catch {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) return null;
  return session.user || null;
}

function createUploadStaticAccessGuard({ uploadsDir, prisma, jwtSecret = process.env.JWT_SECRET } = {}) {
  if (!uploadsDir) throw new Error('createUploadStaticAccessGuard: uploadsDir required');
  if (!prisma) throw new Error('createUploadStaticAccessGuard: prisma required');

  return async function uploadStaticAccessGuard(req, res, next) {
    const relativePath = normaliseUploadPath(req.path || req.url);
    if (!relativePath || !resolveConfinedPath(uploadsDir, relativePath)) {
      return res.status(400).json({ error: 'Invalid upload path' });
    }

    const access = classifyUploadPath(relativePath);
    if (access.kind === 'public') return next();
    if (access.kind === 'blocked') return res.status(404).json({ error: 'File not found' });

    const user = await userFromToken({
      token: tokenFromRequest(req),
      jwtSecret,
      prisma,
    });

    if (!user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (String(user.id) !== access.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}

/**
 * R2 fallback for `/uploads/*`. Mounted AFTER express.static, so it only runs
 * when no local file exists — i.e. the binary lives in R2 (production / scaled
 * deployments). Ownership/auth is already enforced by the access guard mounted
 * before express.static, so by the time we get here the request is authorized.
 *
 * The R2 key mirrors the upload-relative path ("uploads/<rel>"), so we can
 * redirect straight to a short-lived signed URL and let the browser pull the
 * bytes directly from R2 (free egress, no VM bandwidth).
 */
function createUploadR2Fallback({ objectStorage = require('../services/object-storage') } = {}) {
  return async function uploadR2Fallback(req, res, next) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (!objectStorage.enabled()) return next();
      const relativePath = normaliseUploadPath(req.path || req.url);
      if (!relativePath) return next();
      const ref = objectStorage.refFromKey(`uploads/${relativePath}`);
      if (!(await objectStorage.exists(ref))) return next();
      const url = await objectStorage.signedUrl(ref);
      if (!url) return next();
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.redirect(302, url);
    } catch (err) {
      return next();
    }
  };
}

module.exports = {
  BLOCKED_UPLOAD_PREFIXES,
  PUBLIC_UPLOAD_PREFIXES,
  classifyUploadPath,
  createUploadStaticAccessGuard,
  createUploadR2Fallback,
  normaliseUploadPath,
  resolveConfinedPath,
  tokenFromRequest,
  userFromToken,
};
