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

  return { kind: 'owned', userId: first };
}

function tokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length).trim();
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

module.exports = {
  BLOCKED_UPLOAD_PREFIXES,
  PUBLIC_UPLOAD_PREFIXES,
  classifyUploadPath,
  createUploadStaticAccessGuard,
  normaliseUploadPath,
  resolveConfinedPath,
  tokenFromRequest,
  userFromToken,
};
