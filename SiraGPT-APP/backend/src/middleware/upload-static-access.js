const path = require('path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const {
  findSessionByPresentedToken,
} = require('../services/auth/session-token-persistence');

const UPLOAD_MEDIA_TOKEN_AUDIENCE = 'siragpt-upload-static';
const UPLOAD_MEDIA_TOKEN_TYPE = 'upload_media';
const UPLOAD_MEDIA_TOKEN_DEFAULT_TTL_SECONDS = 120;
const UPLOAD_MEDIA_TOKEN_MAX_TTL_SECONDS = 300;

const PUBLIC_UPLOAD_PREFIXES = new Set([
  'audio',
  'gpt-icons',
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
  // Session JWTs are deliberately never accepted from the URL. Query strings
  // are routinely retained by browser history, reverse proxies, and access
  // logs; a separate path-scoped media capability is handled by the guard.
  return req.cookies?.token || null;
}

function mediaTokenFromRequest(req) {
  return req.query && typeof req.query.token === 'string'
    ? req.query.token.trim()
    : '';
}

function mintUploadMediaToken({
  userId,
  uploadPath,
  jwtSecret = process.env.JWT_SECRET,
  issuer = process.env.JWT_ISSUER || 'siragpt-api',
  ttlSeconds = process.env.UPLOAD_MEDIA_TOKEN_TTL_SECONDS,
  randomUUID = crypto.randomUUID,
}) {
  const subject = String(userId || '').trim();
  if (!subject || subject.length > 256 || /[\r\n\0]/.test(subject)) {
    throw new TypeError('media token userId is invalid');
  }
  if (!jwtSecret) throw new Error('JWT_SECRET is required for media tokens');

  const withoutMount = String(uploadPath || '').replace(/^\/?uploads\//, '');
  const relativePath = normaliseUploadPath(withoutMount);
  const access = relativePath ? classifyUploadPath(relativePath) : { kind: 'blocked' };
  if (access.kind !== 'owned' || String(access.userId) !== subject) {
    const error = new Error('UPLOAD_MEDIA_TOKEN_PATH_FORBIDDEN');
    error.code = 'UPLOAD_MEDIA_TOKEN_PATH_FORBIDDEN';
    throw error;
  }

  const parsedTtl = Number(ttlSeconds);
  const boundedTtl = Number.isFinite(parsedTtl)
    ? Math.max(30, Math.min(UPLOAD_MEDIA_TOKEN_MAX_TTL_SECONDS, Math.floor(parsedTtl)))
    : UPLOAD_MEDIA_TOKEN_DEFAULT_TTL_SECONDS;
  return jwt.sign({
    typ: UPLOAD_MEDIA_TOKEN_TYPE,
    sub: subject,
    path: relativePath,
  }, jwtSecret, {
    algorithm: 'HS256',
    audience: UPLOAD_MEDIA_TOKEN_AUDIENCE,
    issuer,
    expiresIn: boundedTtl,
    jwtid: randomUUID(),
  });
}

function createUploadMediaTokenHandler({
  jwtSecret = process.env.JWT_SECRET,
  issuer = process.env.JWT_ISSUER || 'siragpt-api',
  ttlSeconds = process.env.UPLOAD_MEDIA_TOKEN_TTL_SECONDS,
} = {}) {
  return function uploadMediaTokenHandler(req, res) {
    try {
      const uploadPath = req.body?.path;
      const token = mintUploadMediaToken({
        userId: req.user?.id,
        uploadPath,
        jwtSecret,
        issuer,
        ttlSeconds,
      });
      const relativePath = normaliseUploadPath(
        String(uploadPath || '').replace(/^\/?uploads\//, ''),
      );
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        token,
        url: `/uploads/${relativePath}?token=${encodeURIComponent(token)}`,
        expiresInSeconds: Number(jwt.decode(token)?.exp) - Number(jwt.decode(token)?.iat),
      });
    } catch (error) {
      const forbidden = error?.code === 'UPLOAD_MEDIA_TOKEN_PATH_FORBIDDEN';
      return res.status(forbidden ? 403 : 400).json({
        error: forbidden ? 'Upload path is not owned by the current user' : 'Invalid upload path',
      });
    }
  };
}

function userIdFromMediaToken({
  token,
  relativePath,
  jwtSecret,
  issuer = process.env.JWT_ISSUER || 'siragpt-api',
}) {
  if (!token || !jwtSecret) return null;
  try {
    const claims = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      audience: UPLOAD_MEDIA_TOKEN_AUDIENCE,
      issuer,
    });
    if (
      claims?.typ !== UPLOAD_MEDIA_TOKEN_TYPE
      || typeof claims.sub !== 'string'
      || typeof claims.path !== 'string'
      || typeof claims.jti !== 'string'
      || claims.path !== relativePath
    ) {
      return null;
    }
    return claims.sub;
  } catch {
    return null;
  }
}

async function userFromToken({ token, jwtSecret, prisma }) {
  if (!token || !jwtSecret) return null;

  try {
    jwt.verify(token, jwtSecret);
  } catch {
    return null;
  }

  const session = await findSessionByPresentedToken(prisma, token, {
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

    const mediaToken = mediaTokenFromRequest(req);
    if (mediaToken) {
      const mediaUserId = userIdFromMediaToken({
        token: mediaToken,
        relativePath,
        jwtSecret,
      });
      if (!mediaUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (String(mediaUserId) !== access.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    }

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
  UPLOAD_MEDIA_TOKEN_AUDIENCE,
  UPLOAD_MEDIA_TOKEN_DEFAULT_TTL_SECONDS,
  UPLOAD_MEDIA_TOKEN_MAX_TTL_SECONDS,
  UPLOAD_MEDIA_TOKEN_TYPE,
  classifyUploadPath,
  createUploadMediaTokenHandler,
  createUploadStaticAccessGuard,
  createUploadR2Fallback,
  normaliseUploadPath,
  resolveConfinedPath,
  mediaTokenFromRequest,
  mintUploadMediaToken,
  tokenFromRequest,
  userIdFromMediaToken,
  userFromToken,
};
