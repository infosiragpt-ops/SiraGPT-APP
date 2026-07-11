const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { computeFingerprint, compareFingerprints } = require('../utils/session-fingerprint');
const { writeAuditLog } = require('../utils/audit-log');
const { createQueryDedup } = require('../utils/query-dedup');
const { createWriteBehindCache } = require('../services/write-behind-cache');
const { validateActiveSession } = require('../services/active-session-validator');
const { getRequestId } = require('./request-id');
const apiKeysService = require('../services/api-keys-service');
// Lazy require to keep the auth module's import graph cheap for tests that
// stub the email service. Resolved on first auto-revoke event.
let _emailService = null;
function getEmailService() {
  if (_emailService) return _emailService;
  try {
    // eslint-disable-next-line global-require
    _emailService = require('../services/email');
  } catch (_err) {
    _emailService = false;
  }
  return _emailService;
}

/**
 * Fire-and-forget security email when the backend auto-revokes an Appshots
 * session (fingerprint mismatch, token expiration detected at decode time,
 * etc.). The user-initiated /api/appshots/sessions/:id DELETE path keeps
 * sending the existing "you revoked a device" email — this one covers the
 * branches the user didn't trigger.
 */
function notifyAppshotsAutoRevoked(user, reason) {
  if (!user || !user.email) return;
  try {
    const svc = getEmailService();
    if (!svc || typeof svc.sendAppshotsDeviceAutoRevoked !== 'function') return;
    void Promise.resolve(svc.sendAppshotsDeviceAutoRevoked(user, { reason, when: new Date() }))
      .catch((err) => {
        console.warn('[appshots] auto-revoke email failed:', err?.message || err);
      });
  } catch (err) {
    console.warn('[appshots] auto-revoke email dispatch error:', err?.message || err);
  }
}

function isAppshotsScope(decoded) {
  return !!(decoded && typeof decoded === 'object' && decoded.scope === 'appshots:capture');
}

const MAX_ACCESS_TOKEN_LENGTH = 8192;
// Ratchet 45 — lazy-loaded so the auth module stays cheap to import in
// environments (tests) that don't exercise the API-key path.
let _enforceApiKeyRateLimitMw = null;
function _getApiKeyRateLimitMw() {
  if (_enforceApiKeyRateLimitMw) return _enforceApiKeyRateLimitMw;
  try {
    // eslint-disable-next-line global-require
    const {
      createResilientApiKeyRateLimitGate,
    } = require('./enforce-api-key-rate-limit');
    _enforceApiKeyRateLimitMw = createResilientApiKeyRateLimitGate();
  } catch (_err) {
    // Do not cache initialization failures. Production rejects this request
    // below; the next request retries module/factory initialization.
    return null;
  }
  return _enforceApiKeyRateLimitMw;
}

function sendApiKeyRateLimiterUnavailable(req, res) {
  const { isProductionLike } = require('../utils/environment');
  if (!isProductionLike(process.env)) return false;
  const parsed = Number.parseInt(
    String(process.env.RATE_LIMIT_STORE_RETRY_AFTER_SECONDS || ''),
    10,
  );
  const retryAfterSec = Number.isFinite(parsed) && parsed >= 1 && parsed <= 300
    ? parsed
    : 5;
  try { res.setHeader('Retry-After', String(retryAfterSec)); } catch (_error) { /* swallow */ }
  sendAuthError(
    req,
    res,
    503,
    'RATE_LIMIT_STORE_UNAVAILABLE',
    'Rate limit service temporarily unavailable.',
    { retryAfterSec },
  );
  return true;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function validateAccessTokenValue(value) {
  const raw = String(value || '');
  if (/[\r\n\0]/.test(raw)) return { error: 'invalid_token_format' };
  const token = raw.trim();
  if (!token) return { error: 'missing_token' };
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) return { error: 'token_too_large' };
  if (/\s/.test(token)) return { error: 'invalid_token_format' };
  return { token };
}

function parseAuthorizationHeader(value) {
  const raw = firstHeaderValue(value);
  if (raw == null || raw === '') return { present: false, token: null };
  const header = String(raw);
  if (header.length > MAX_ACCESS_TOKEN_LENGTH + 32) {
    return { present: true, error: 'authorization_header_too_large' };
  }
  if (/[\r\n\0]/.test(header)) {
    return { present: true, error: 'invalid_authorization_header' };
  }
  const match = header.match(/^\s*Bearer\s+([^\s]+)\s*$/i);
  if (!match) {
    return { present: true, error: 'unsupported_authorization_scheme' };
  }
  return { present: true, ...validateAccessTokenValue(match[1]) };
}

function extractAccessToken(req) {
  const auth = parseAuthorizationHeader(req && req.headers && req.headers.authorization);
  if (auth.error) return auth;
  if (auth.token) return auth;
  const cookieToken = req && req.cookies && req.cookies.token;
  if (cookieToken == null || cookieToken === '') return { present: false, token: null };
  return { present: true, source: 'cookie', ...validateAccessTokenValue(cookieToken) };
}

function setAuthErrorHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendAuthError(req, res, status, code, error, extra = {}) {
  setAuthErrorHeaders(res);
  const requestId = getRequestId(req);
  return res.status(status).json({
    ok: false,
    code,
    error,
    ...(requestId ? { requestId } : {}),
    ...extra,
  });
}

function isJwtVerificationError(error) {
  return !!(
    error
    && ['JsonWebTokenError', 'NotBeforeError', 'TokenExpiredError'].includes(error.name)
  );
}

function extractRawTokenForLogging(req) {
  try {
    const tokenResult = extractAccessToken(req);
    return tokenResult && tokenResult.token ? tokenResult.token : null;
  } catch (_) {
    return null;
  }
}

// Hot-path read coalescing: two requests for the same session token
// within 50ms share the Prisma lookup. Reduces DB load when a SPA
// fires several concurrent authenticated calls.
const sessionDedup = createQueryDedup({ ttlMs: 50, maxEntries: 5000 });

async function revokeInactiveUserSessions(userId) {
  if (!userId || typeof prisma?.session?.deleteMany !== 'function') return;
  try {
    await prisma.session.deleteMany({ where: { userId } });
  } catch (_) {
    // Authentication still fails closed when cleanup is temporarily
    // unavailable. A later request/deletion sweep can retry the revocation.
  } finally {
    // Do not let the 50ms coalescing window repopulate auth from a session
    // result obtained immediately before the account tombstone was observed.
    sessionDedup.clear();
  }
}

// Write-behind queue for high-cardinality writes that fire on every
// authenticated request (lastActiveAt). Singleton — wired once per
// process. Disabled via WRITE_BEHIND_DISABLED for emergency rollback.
let _writeBehind = null;
let _writeBehindShutdownPromise = null;
let _writeBehindShutdownStarted = false;
function getWriteBehindCache() {
  if (_writeBehindShutdownStarted) return null;
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

function shutdownWriteBehindCache() {
  if (_writeBehindShutdownPromise) return _writeBehindShutdownPromise;
  _writeBehindShutdownStarted = true;
  if (!_writeBehind) {
    _writeBehindShutdownPromise = Promise.resolve(undefined);
    return _writeBehindShutdownPromise;
  }
  try {
    _writeBehindShutdownPromise = Promise.resolve(_writeBehind.shutdown());
  } catch (error) {
    _writeBehindShutdownPromise = Promise.reject(error);
  }
  return _writeBehindShutdownPromise;
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
  if (!parsed) {
    if (apiKeysService.hasTokenScheme(rawToken)) {
      sendAuthError(req, res, 401, 'invalid_api_key', 'Invalid API key');
      return true;
    }
    return false; // not our scheme — caller falls back to JWT
  }

  try {
    const row = await prisma.apiKey.findFirst({
      where: { prefix: parsed.prefix },
      include: { user: true, organization: true },
    });

    const presentedHash = apiKeysService.hashToken(parsed.body);
    if (!row || !apiKeysService.compareTokenHash(row.tokenHash, presentedHash)) {
      sendAuthError(req, res, 401, 'invalid_api_key', 'Invalid API key');
      return true;
    }
    // Ratchet 45 (TrueDelete) — soft-deleted rows MUST NOT authenticate.
    // We surface the same opaque "revoked" error rather than leaking the
    // distinction between a never-existed key and one we tombstoned.
    if (row.deletedAt) {
      sendAuthError(req, res, 401, 'api_key_revoked', 'API key revoked');
      return true;
    }
    if (apiKeysService.isExpired(row)) {
      sendAuthError(req, res, 401, 'api_key_expired', 'API key expired');
      return true;
    }
    if (!row.user) {
      // Owner was deleted — defence in depth; FK cascade should make this rare.
      sendAuthError(req, res, 401, 'invalid_api_key', 'Invalid API key');
      return true;
    }
    if (row.user.deletedAt != null) {
      await revokeInactiveUserSessions(row.user.id);
      sendAuthError(req, res, 401, 'account_inactive', 'Invalid credentials');
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
    sendAuthError(req, res, 500, 'auth_lookup_failed', 'auth lookup failed');
    return true;
  }
}

const authenticateToken = async (req, res, next) => {
  try {
    const tokenResult = extractAccessToken(req);
    if (tokenResult.error) {
      return sendAuthError(req, res, 401, tokenResult.error, 'Invalid authorization header');
    }
    const token = tokenResult.token;

    if (!token) {
      return sendAuthError(req, res, 401, 'access_token_required', 'Access token required');
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
        // middleware sends 429 on cap exceeded. Production rejects store or
        // initialization failures; failed initialization is retried next time.
        const rlMw = _getApiKeyRateLimitMw();
        if (rlMw) return rlMw(req, res, next);
        if (sendApiKeyRateLimiterUnavailable(req, res)) return;
        return next();
      }
      return; // response already sent
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Scope gate (added for Appshots, generally applicable). A JWT minted
    // with a `scope` claim is a SCOPED token — it must only be usable on the
    // routes that explicitly opt-in by setting `req._allowScopedToken` BEFORE
    // this middleware runs. Without this, a long-lived Appshots pairing token
    // would be a fully-elevated session token on every other endpoint, since
    // the Session table treats all tokens uniformly. General login tokens
    // never carry a scope claim, so they're unaffected.
    if (decoded && typeof decoded === 'object' && decoded.scope) {
      if (req._allowScopedToken !== decoded.scope) {
        return res.status(403).json({
          error: 'Scoped token used on a route that does not accept it',
          code: 'scope_not_allowed',
          scope: decoded.scope,
        });
      }
    }

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
    if (!session.user || session.user.deletedAt != null) {
      if (session.user?.id || session.userId) {
        await revokeInactiveUserSessions(session.user?.id || session.userId);
      } else {
        try {
          await prisma.session.deleteMany({ where: { token } });
        } catch (_) { /* best-effort orphan cleanup */ }
        sessionDedup.clear();
      }
      void writeAuditLog(prisma, {
        req,
        action: 'session_revoked_inactive_user',
        resource: 'session',
        resourceId: session.id,
        userId: session.userId || session.user?.id || null,
        metadata: { revoked: true },
      });
      return sendAuthError(
        req,
        res,
        401,
        'account_inactive',
        'Invalid or expired token',
      );
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
        metadata: {
          expiresAt: session.expiresAt,
          // Task 22: tag the audit row with the JWT scope so the
          // /settings/appshots history view can filter for auto-
          // revocations of Appshots-scoped sessions only.
          ...(decoded && typeof decoded === 'object' && decoded.scope
            ? { scope: String(decoded.scope) }
            : {}),
        },
      });
      // Appshots sessions also trigger a security email so the owner
      // notices an automatic revocation they didn't request.
      if (isAppshotsScope(decoded)) {
        notifyAppshotsAutoRevoked(session.user, 'token_expired');
      }
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
          metadata: {
            revoked: true,
            // Task 22: tag scope so /settings/appshots can list auto
            // revocations of the extension's bearer token.
            ...(decoded && typeof decoded === 'object' && decoded.scope
              ? { scope: String(decoded.scope) }
              : {}),
          },
        });
        // Appshots sessions: notify the owner. A fingerprint mismatch on a
        // long-lived capture token is the canonical "someone copied my token"
        // signal, so the email is more important here than the audit log.
        if (isAppshotsScope(decoded)) {
          notifyAppshotsAutoRevoked(session.user, 'fingerprint_mismatch');
        }
        return res.status(401).json({
          error: 'Session revoked — re-authentication required',
          reason: 'fingerprint_mismatch',
        });
      }
    }

    req.user = session.user;
    req.token = token;
    // NOTE: do NOT assign to req.session — that name is owned by
    // express-session and overwriting it breaks res.json() (touch()
    // is called on response end). Use req.userSession instead.
    req.userSession = session;

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
      // Task 22: jwt.verify threw before we could read decoded.scope, but
      // jwt.decode is a non-verifying parse so we can still extract the
      // scope claim for the audit metadata (the token bytes are already
      // trusted to the extent that they were signed at mint time).
      let expiredScope = null;
      let expiredUserId = null;
      try {
        const token2 = extractRawTokenForLogging(req);
        if (token2) {
          const peek = jwt.decode(token2);
          if (peek && typeof peek === 'object') {
            if (peek.scope) expiredScope = String(peek.scope);
            if (peek.userId) expiredUserId = String(peek.userId);
          }
        }
      } catch (_) { /* best-effort decode */ }
      void writeAuditLog(prisma, {
        req,
        action: 'session_expired',
        resource: 'session',
        userId: expiredUserId,
        metadata: {
          reason: 'jwt_expired',
          ...(expiredScope ? { scope: expiredScope } : {}),
        },
      });
      // jwt.verify threw, so `decoded` is not in scope here. The signature
      // was checked before the exp comparison (jsonwebtoken's verify order),
      // so it is safe to read the payload via jwt.decode for the sole
      // purpose of routing the auto-revoke email to the right user.
      try {
        const rawToken = extractRawTokenForLogging(req);
        const payload = rawToken ? jwt.decode(rawToken) : null;
        if (isAppshotsScope(payload) && payload?.userId) {
          void prisma.user
            .findUnique({ where: { id: payload.userId }, select: { id: true, email: true, name: true } })
            .then((user) => { if (user) notifyAppshotsAutoRevoked(user, 'token_expired'); })
            .catch(() => {});
        }
      } catch (_) { /* never let telemetry break the auth response */ }
    }
    if (isJwtVerificationError(error)) {
      const code = error.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
      return sendAuthError(req, res, 401, code, 'Invalid or expired token');
    }
    console.error('Auth middleware error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

/**
 * optionalAuth — soft authentication. Populates `req.user` and
 * `req.userSession` when the request carries a valid session token,
 * otherwise calls `next()` anonymously instead of returning 401. Used
 * by public-but-personalisable endpoints (e.g. `GET /api/plans`, the
 * catalog of plans where super-admins see inactive rows too).
 *
 * Mirror of the happy-path branch of `authenticateToken` minus the
 * fail-closed responses: every error path falls through to next().
 */
const optionalAuth = async (req, res, next) => {
  try {
    const tokenResult = extractAccessToken(req);
    if (tokenResult.error || !tokenResult.token) return next();

    const token = tokenResult.token;
    if (apiKeysService.hasTokenScheme(token)) {
      // API-key auth still applies; reuse the strict path but swallow
      // its 401 (we want anonymous fallthrough, not a forced error).
      const handled = await tryAuthenticateApiKey(req, {
        status() { return { json() {} }; },
        setHeader() {},
      }, token).catch(() => false);
      void handled;
      return next();
    }

    const validated = await validateActiveSession({
      token,
      request: req,
      prismaClient: prisma,
    });
    if (validated.decoded && typeof validated.decoded === 'object' && validated.decoded.scope) {
      // Scoped tokens (e.g. Appshots) must NOT silently elevate a
      // generic optional-auth route — drop to anonymous instead.
      return next();
    }

    req.user = validated.user;
    req.token = token;
    req.userSession = validated.session;
    return next();
  } catch {
    sessionDedup.clear();
    return next();
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
  optionalAuth,
  requireAdmin,
  requireSuperAdmin,
  // Exported for tests + graceful shutdown wiring.
  shutdownWriteBehindCache,
  __sessionDedup: sessionDedup,
  __getWriteBehindCache: getWriteBehindCache,
  __tryAuthenticateApiKey: tryAuthenticateApiKey,
  __extractAccessToken: extractAccessToken,
  __parseAuthorizationHeader: parseAuthorizationHeader,
  __validateAccessTokenValue: validateAccessTokenValue,
  __sendAuthError: sendAuthError,
  __isJwtVerificationError: isJwtVerificationError,
  MAX_ACCESS_TOKEN_LENGTH,
};
