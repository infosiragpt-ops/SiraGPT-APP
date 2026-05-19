const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { computeFingerprint, compareFingerprints } = require('../utils/session-fingerprint');
const { writeAuditLog } = require('../utils/audit-log');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if session exists and is valid
    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: true }
    });

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
  requireSuperAdmin
};
