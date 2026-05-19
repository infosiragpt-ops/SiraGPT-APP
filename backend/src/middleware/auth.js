const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { computeFingerprint, compareFingerprints } = require('../utils/session-fingerprint');
const { writeAuditLog } = require('../utils/audit-log');
const { createQueryDedup } = require('../utils/query-dedup');
const { createWriteBehindCache } = require('../services/write-behind-cache');

// Hot-path read coalescing: two requests for the same session token
// within 50ms share the Prisma lookup. Reduces DB load when a SPA
// fires several concurrent authenticated calls.
const sessionDedup = createQueryDedup({ ttlMs: 50, maxEntries: 5000 });

// Write-behind queue for high-cardinality writes that fire on every
// authenticated request (lastActiveAt). Singleton — wired once per
// process. Disabled via WRITE_BEHIND_DISABLED for emergency rollback.
let _writeBehind = null;
function getWriteBehindCache() {
  if (_writeBehind) return _writeBehind;
  if (String(process.env.WRITE_BEHIND_DISABLED || '').toLowerCase() === 'true') return null;
  _writeBehind = createWriteBehindCache({
    prisma,
    flushIntervalMs: 5000,
    flushThreshold: 100,
    onError: (stage, err) => {
      // Keep noise low in production but surface in dev/test.
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(`[write-behind:${stage}]`, err && err.message);
      }
    },
  });
  return _writeBehind;
}

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if session exists and is valid. Coalesce concurrent
    // identical lookups within a 50ms window so the SPA's burst of
    // authenticated calls only generates one DB roundtrip.
    const session = await sessionDedup.wrap(
      'session',
      { where: { token }, include: { user: true } },
      () => prisma.session.findUnique({ where: { token }, include: { user: true } })
    );

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (session.expiresAt < new Date()) {
      // Best-effort: clean up the expired row and emit an audit event
      // so SIEM/operators can correlate "user got logged out" reports.
      try {
        await prisma.session.deleteMany({ where: { token } });
      } catch (_) { /* ignore — row may already be gone */ }
      void writeAuditLog(prisma, {
        req,
        action: 'session_expired',
        resource: 'session',
        resourceId: session.id,
        userId: session.userId,
        metadata: { expiresAt: session.expiresAt },
      });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Session fingerprint binding (cycle 17, Task 2). Skip when the
    // stored value is null — that happens for sessions minted before
    // the schema migration landed and during the rolling deploy.
    if (session.fingerprint) {
      const current = computeFingerprint(req);
      if (!compareFingerprints(current, session.fingerprint)) {
        // Revoke the session — a token presented from a different
        // network/UA is treated as compromised.
        try {
          await prisma.session.deleteMany({ where: { token } });
        } catch (_) { /* ignore */ }
        void writeAuditLog(prisma, {
          req,
          action: 'session_fingerprint_mismatch',
          resource: 'session',
          resourceId: session.id,
          userId: session.userId,
          metadata: { revoked: true },
        });
        return res.status(401).json({
          error: 'Session revoked — re-authentication required',
          reason: 'fingerprint_mismatch',
        });
      }
    }

    req.user = session.user;
    req.token = token;
    req.session = session;

    // Write-behind: update lastActiveAt without hitting Postgres on
    // every request. The cache flushes every 5s or at 100 pending
    // writes. If the field isn't on the model (legacy DB without the
    // migration) the flush silently drops it. See write-behind-cache.js.
    try {
      const wbc = getWriteBehindCache();
      if (wbc && session.user && session.user.id) {
        wbc.queueWrite('user', { id: session.user.id }, { lastActiveAt: new Date() });
      }
    } catch (_) { /* never block auth on telemetry */ }

    next();
  } catch (error) {
    if (error && error.name === 'TokenExpiredError') {
      void writeAuditLog(prisma, {
        req,
        action: 'session_expired',
        resource: 'session',
        metadata: { reason: 'jwt_expired' },
      });
    }
    console.error('Auth middleware error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || (!req.user.isAdmin && !req.user.isSuperAdmin)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

module.exports = {
  authenticateToken,
  requireAdmin,
  requireSuperAdmin,
  // Exported for tests + graceful shutdown wiring.
  __sessionDedup: sessionDedup,
  __getWriteBehindCache: getWriteBehindCache,
};
