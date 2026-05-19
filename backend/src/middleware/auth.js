const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { computeFingerprint, compareFingerprints } = require('../utils/session-fingerprint');
const { writeAuditLog } = require('../utils/audit-log');
const { createQueryDedup } = require('../utils/query-dedup');
const { createWriteBehindCache } = require('../services/write-behind-cache');
const apiKeysService = require('../services/api-keys-service');
// Ratchet 45 — lazy-loaded so the auth module stays cheap to import in
// environments (tests) that don't exercise the API-key path.
let _enforceApiKeyRateLimitMw = null;
function _getApiKeyRateLimitMw() {
  if (_enforceApiKeyRateLimitMw) return _enforceApiKeyRateLimitMw;
  try {
    // eslint-disable-next-line global-require
    const { enforceApiKeyRateLimit } = require('./enforce-api-key-rate-limit');
    _enforceApiKeyRateLimitMw = enforceApiKeyRateLimit();
  } catch (_err) {
    _enforceApiKeyRateLimitMw = false;
  }
  return _enforceApiKeyRateLimitMw;
}

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

/**
 * Authenticate a request via API key (Bearer `sk_…`). Returns true
 * when the key is valid and `req.user` was populated; false when the
 * caller should fall through to JWT auth (i.e. the token did not use
 * the API-key scheme). Sends an error response and returns true when
 * the scheme matched but the key is invalid/expired — in that case
 * the JWT path must NOT run.
 */
async function tryAuthenticateApiKey(req, res, rawToken) {
  const parsed = apiKeysService.parseToken(rawToken);
  if (!parsed) return false; // not our scheme — caller falls back to JWT

  try {
    const row = await prisma.apiKey.findFirst({
      where: { prefix: parsed.prefix },
      include: { user: true, organization: true },
    });

    const presentedHash = apiKeysService.hashToken(parsed.body);
    if (!row || row.tokenHash !== presentedHash) {
      res.status(401).json({ error: 'Invalid API key' });
      return true;
    }
    // Ratchet 45 (TrueDelete) — soft-deleted rows MUST NOT authenticate.
    // We surface the same opaque "revoked" error rather than leaking the
    // distinction between a never-existed key and one we tombstoned.
    if (row.deletedAt) {
      res.status(401).json({ error: 'API key revoked' });
      return true;
    }
    if (apiKeysService.isExpired(row)) {
      res.status(401).json({ error: 'API key expired' });
      return true;
    }
    if (!row.user) {
      // Owner was deleted — defence in depth; FK cascade should make this rare.
      res.status(401).json({ error: 'Invalid API key' });
      return true;
    }

    req.user = row.user;
    req.token = rawToken;
    req.apiKey = {
      id: row.id,
      prefix: row.prefix,
      scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
      organizationId: row.organizationId || null,
      // Ratchet 45 — per-key override of the plan-derived default RPM.
      // Null means "use the plan default" (resolved by enforce-api-key-rate-limit).
      rateLimitPerMinute: Number.isFinite(row.rateLimitPerMinute) && row.rateLimitPerMinute > 0
        ? row.rateLimitPerMinute
        : null,
    };
    if (row.organization) {
      req.organization = row.organization;
    }
    req.authMethod = 'api_key';

    // Fire-and-forget lastUsedAt update; never block the request on it.
    void prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return true;
  } catch (err) {
    console.error('API key auth error:', err && err.message);
    res.status(500).json({ error: 'auth lookup failed' });
    return true;
  }
}

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Bearer API key (sk_…) short-circuits the JWT/session path so a
    // programmatic caller never needs to mint a session row. When the
    // token uses our `sk_` scheme but is invalid, tryAuthenticateApiKey
    // sends the error response itself and we must not fall through.
    const handledByApiKey = await tryAuthenticateApiKey(req, res, token);
    if (handledByApiKey) {
      if (req.user) {
        // Ratchet 45 — enforce per-key sliding-window rate limit + sampled
        // api_key_used audit on every authenticated API-key request. The
        // middleware sends 429 on cap exceeded and fails open on store
        // errors. Skipped silently if the module fails to load.
        const rlMw = _getApiKeyRateLimitMw();
        if (rlMw) return rlMw(req, res, next);
        return next();
      }
      return; // response already sent
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
  __tryAuthenticateApiKey: tryAuthenticateApiKey,
};
