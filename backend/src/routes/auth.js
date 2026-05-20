const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { makeAuthRateLimit } = require('../middleware/rate-limit-auth');
const { writeAuditLog } = require('../utils/audit-log');
const { csrfTokenRoute, issueCsrfToken } = require('../middleware/csrf');
const { defaultLockout } = require('../utils/login-lockout');
const { computeFingerprint } = require('../utils/session-fingerprint');
const {
  validateBody,
  formatExpressValidatorErrors,
} = require('../middleware/validate');
const {
  LoginRequestSchema,
  RegisterRequestSchema,
} = require('../schemas/auth');

// JWT audience / issuer — included in every signed token and verified
// where we hand-decode (e.g. /end-impersonation). Allows future
// multi-service deploys (worker, scheduler) to reject tokens not minted
// by the API. Configurable via env so staging vs production can use
// different identifiers and a leaked token from one env doesn't pass
// verification in the other.
//
// TODO(security): refresh-token rotation. Today we re-sign a JWT with
// the same 7d TTL on /refresh; a stolen long-lived token is replayable
// for its full window. Migrating to short-lived access tokens (15m) +
// rotating opaque refresh tokens persisted in the Session table is the
// correct fix but is non-trivial — every authenticated client needs to
// learn the new refresh contract. Tracked for a dedicated cycle.
const JWT_ISSUER = process.env.JWT_ISSUER || 'siragpt-api';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'siragpt-clients';
const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '7d';

// Rate limiters scoped per sensitive endpoint. See rate-limit-auth.js
// for the sliding-window semantics and Redis/in-memory fallback. We
// build these once at module load so the closures share state across
// requests.
const loginRateLimit = makeAuthRateLimit({
  name: 'login',
  limit: 5,
  windowMs: 60 * 1000, // 1 min
  keyBy: 'ip+email',
});
const registerRateLimit = makeAuthRateLimit({
  name: 'register',
  limit: 3,
  windowMs: 60 * 1000, // 1 min
  keyBy: 'ip',
});
const forgotPasswordRateLimit = makeAuthRateLimit({
  name: 'forgot-password',
  limit: 3,
  windowMs: 15 * 60 * 1000, // 15 min
  keyBy: 'ip+email',
});
// Cycle 93 added GET /verify-email/:token (token redemption). The
// token check is short-circuited on length but a brute-force attacker
// could still grind through opaque 256-bit guesses; cap to 30/15min
// per IP to make that hopeless without locking out legitimate clicks
// from shared NATs.
const verifyEmailRateLimit = makeAuthRateLimit({
  name: 'verify-email',
  limit: 30,
  windowMs: 15 * 60 * 1000,
  keyBy: 'ip',
});

function signSessionToken(payload, opts = {}) {
  // Fail fast at boot if the secret is missing — refuse to sign rather
  // than producing tokens with an empty secret (which `jsonwebtoken`
  // happily accepts and which would then be forgeable trivially).
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: opts.expiresIn || JWT_ACCESS_TTL,
    audience: opts.audience || JWT_AUDIENCE,
    issuer: opts.issuer || JWT_ISSUER,
  });
}
const passport = require('../config/passport');
const { OAuth2Client } = require('google-auth-library');
const { serializeUser } = require('../utils/bigint-serializer');
const {
  popupResponseHtml,
  signOAuthState,
  verifyOAuthState,
} = require('../services/oauth-state');
const {
  getFrontendUrl,
  getGoogleGmailCallbackURL,
  getGoogleServicesCallbackURL,
} = require('../config/oauth-url-policy');
const twoFASms = require('../services/two-fa-sms');
const {
  orgRequiresTwoFactor,
  userHasTwoFactor,
} = require('../services/orgs-service');

const router = express.Router();

// CSRF token endpoint — clients fetch this once after login (or on
// app boot for cookie-authenticated sessions) and echo the returned
// token in the X-CSRF-Token header on state-mutating requests. See
// `middleware/csrf.js` for the double-submit-cookie design notes.
router.get('/csrf-token', csrfTokenRoute);
const googleIntegrationsConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET
);

const isGoogleOAuthConfigured = () => (
  typeof passport.isGoogleOAuthConfigured === 'function'
    ? passport.isGoogleOAuthConfigured()
    : Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_AUTH_URI)
);

const requireGoogleOAuth = (req, res, next) => {
  if (isGoogleOAuthConfigured()) return next();
  // Browser hits like /api/auth/google should not see raw JSON; bounce
  // them back to the login page with a soft notice so the user can pick
  // email/password instead. API clients (Accept: application/json) still
  // get the structured 503.
  const wantsJson = (req.get('accept') || '').toLowerCase().includes('application/json');
  if (wantsJson) {
    return res.status(503).json({
      error: 'Google OAuth is not configured for this environment'
    });
  }
  const base = (getFrontendUrl && getFrontendUrl()) || process.env.FRONTEND_URL || 'http://localhost:3000';
  return res.redirect(`${base.replace(/\/$/, '')}/auth/login?notice=google_unavailable`);
};

const requireGoogleIntegrations = (req, res, next) => {
  if (googleIntegrationsConfigured) return next();
  return res.status(503).json({
    error: 'Google integrations are not configured for this environment'
  });
};

// Gmail OAuth configuration
const gmailOauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getGoogleGmailCallbackURL()
);

// Google Calendar & Drive OAuth configuration
const googleServicesOauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getGoogleServicesCallbackURL()
);

// Google OAuth routes
router.get('/google',
  requireGoogleOAuth,
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      // 'https://www.googleapis.com/auth/gmail.readonly',
      // 'https://www.googleapis.com/auth/gmail.send',
      // 'https://www.googleapis.com/auth/gmail.modify',
      // 'https://www.googleapis.com/auth/calendar',
      // 'https://www.googleapis.com/auth/calendar.events',
      // 'https://www.googleapis.com/auth/drive',
      // 'https://www.googleapis.com/auth/drive.file',
      // 'https://www.googleapis.com/auth/drive.readonly',
      // 'https://www.googleapis.com/auth/drive.metadata.readonly'
    ],
    accessType: 'offline',
    prompt: 'consent'
  })
);

router.get('/google/callback',
  requireGoogleOAuth,
  passport.authenticate('google', { session: false }),
  async (req, res) => {
    try {
      console.log('🟡 General Google OAuth callback triggered (NOT Gmail-specific)');
      // Create session token — include admin claims so the rate-limit
      // bypass + admin guards stay consistent with email/password
      // logins. aud/iss/expiry added by signSessionToken().
      const token = signSessionToken({
        userId: req.user.id,
        isAdmin: Boolean(req.user.isAdmin),
        isSuperAdmin: Boolean(req.user.isSuperAdmin),
      });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await prisma.session.create({
        data: {
          userId: req.user.id,
          token,
          expiresAt
        }
      });

      // Redirect to frontend with token
      res.redirect(`${getFrontendUrl()}/auth/callback?token=${token}`);
    } catch (error) {
      console.error('Google auth callback error:', error);
      res.redirect(`${getFrontendUrl()}/auth/login?error=auth_failed`);
    }
  }
);

// Gmail OAuth routes - separate from regular Google auth
router.get('/gmail',
  authenticateToken,
  requireGoogleIntegrations,
  async (req, res) => {
    try {
      const scopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify'
      ];

      const authUrl = gmailOauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent', // ✅ Force consent screen to ensure refresh token is always sent
        state: signOAuthState({ userId: req.user.id, service: 'gmail' })
      });
      res.json({ authUrl });
    } catch (error) {
      console.error('Gmail OAuth error:', error);
      res.status(500).json({ error: 'Failed to generate Gmail auth URL' });
    }
  }
);

router.get('/gmail/callback', async (req, res) => {
  try {
    console.log('🔵 Gmail OAuth callback triggered');
    const { code, state } = req.query;
    let userId;

    if (!code || !state) {
      return res.send(popupResponseHtml({ status: 'error', service: 'gmail', error: 'auth_failed' }));
    }

    try {
      ({ userId } = verifyOAuthState(state, { service: 'gmail' }));
    } catch (stateError) {
      console.warn('Gmail OAuth state validation failed:', stateError.message);
      return res.send(popupResponseHtml({ status: 'error', service: 'gmail', error: 'invalid_state' }));
    }

    // Exchange code for tokens
    const { tokens } = await gmailOauth2Client.getToken(code);

    // Store Gmail tokens for the user (encrypted)
    const { encrypt } = require('../utils/encryption');

    console.log('🎉 Gmail OAuth successful - Received tokens:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      scope: tokens.scope,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : 'none'
    });

    const gmailTokens = JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || 'gmail',
      expiresAt: tokens.expiry_date || (Date.now() + 3600000) // Use Google's expiry or 1 hour default
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        gmailTokens: encrypt(gmailTokens)
      }
    });

    // ✅ Send a full HTML page with a script to ensure execution
    res.set('Content-Type', 'text/html');
    res.send(popupResponseHtml({ status: 'success', service: 'gmail' }));
  } catch (error) {
    console.error('Gmail OAuth callback error:', error);
    // ✅ Handle error case as well
    res.set('Content-Type', 'text/html');
    res.send(popupResponseHtml({ status: 'error', service: 'gmail', error: 'auth_failed' }));
  }
});

// Disconnect Gmail
router.post('/gmail/disconnect', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        gmailTokens: null
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Gmail disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Gmail' });
  }
});

// Check Gmail connection status
router.get('/gmail/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { gmailTokens: true }
    });

    let isConnected = false;
    let hasRefreshToken = false;
    let hasRequiredScopes = false;

    if (user?.gmailTokens) {
      try {
        const { decrypt } = require('../utils/encryption');
        const tokens = JSON.parse(decrypt(user.gmailTokens));
        isConnected = true;
        hasRefreshToken = !!tokens.refreshToken;

        // Check scopes
        const requiredScopes = [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.modify'
        ];
        const tokenScope = tokens.scope || '';
        hasRequiredScopes = requiredScopes.every(scope => tokenScope.includes(scope));
      } catch (error) {
        console.error('Error decrypting Gmail tokens:', error);
      }
    }

    res.json({
      isConnected,
      hasRefreshToken,
      hasRequiredScopes,
      needsReauth: isConnected && (!hasRefreshToken || !hasRequiredScopes)
    });
  } catch (error) {
    console.error('Gmail status error:', error);
    res.status(500).json({ error: 'Failed to check Gmail status' });
  }
});

// Force Gmail re-authentication with consent screen
router.get('/gmail/reauth', authenticateToken, requireGoogleIntegrations, (req, res) => {
  try {
    // Generate OAuth URL with forced consent
    const { OAuth2Client } = require('google-auth-library');
    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getGoogleGmailCallbackURL()
    );

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify'
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Force consent screen
      scope: scopes,
      state: signOAuthState({ userId: req.user.id, service: 'gmail' })
    });

    res.json({ authUrl });
  } catch (error) {
    console.error('Gmail reauth error:', error);
    res.status(500).json({ error: 'Failed to generate reauth URL' });
  }
});

// Google Calendar & Drive OAuth routes
router.get('/google-services',
  authenticateToken,
  requireGoogleIntegrations,
  async (req, res) => {
    try {
      const scopes = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly'
      ];

      const authUrl = googleServicesOauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent',
        state: signOAuthState({ userId: req.user.id, service: 'google_services' })
      });

      res.json({ authUrl });
    } catch (error) {
      console.error('Google Services OAuth error:', error);
      res.status(500).json({ error: 'Failed to generate Google Services auth URL' });
    }
  }
);

router.get('/google-services/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    let userId;

    if (!code || !state) {
      return res.send(popupResponseHtml({ status: 'error', service: 'google_services', error: 'auth_failed' }));
    }

    try {
      ({ userId } = verifyOAuthState(state, { service: 'google_services' }));
    } catch (stateError) {
      console.warn('Google Services OAuth state validation failed:', stateError.message);
      return res.send(popupResponseHtml({ status: 'error', service: 'google_services', error: 'invalid_state' }));
    }

    // Exchange code for tokens
    const { tokens } = await googleServicesOauth2Client.getToken(code);

    // Store Google Services tokens for the user (encrypted)
    const { encrypt } = require('../utils/encryption');

    console.log('🎉 Google Services OAuth successful - Received tokens:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      scope: tokens.scope,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : 'none'
    });

    const googleServicesTokens = JSON.stringify({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || 'calendar,drive',
      expiresAt: tokens.expiry_date || (Date.now() + 3600000) // Use Google's expiry or 1 hour default
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        googleServicesTokens: encrypt(googleServicesTokens)
      }
    });

    res.set('Content-Type', 'text/html');
    res.send(popupResponseHtml({
      status: 'success',
      service: 'google_services',
      message: 'Google Calendar & Drive connected successfully! This window will now close.',
    }));
  } catch (error) {
    console.error('Google Services OAuth callback error:', error);
    res.set('Content-Type', 'text/html');
    res.send(popupResponseHtml({ status: 'error', service: 'google_services', error: 'auth_failed' }));
  }
});

// Disconnect Google Services
router.post('/google-services/disconnect', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        googleServicesTokens: null
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Google Services disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Google Services' });
  }
});

// Check Google Services connection status
router.get('/google-services/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { googleServicesTokens: true }
    });

    let isConnected = false;
    let hasRefreshToken = false;
    let hasRequiredScopes = false;

    if (user?.googleServicesTokens) {
      try {
        const { decrypt } = require('../utils/encryption');
        const tokens = JSON.parse(decrypt(user.googleServicesTokens));
        isConnected = true;
        hasRefreshToken = !!tokens.refreshToken;

        // Check for Calendar and Drive scopes
        const requiredScopes = [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/drive'
        ];
        const tokenScope = tokens.scope || '';
        hasRequiredScopes = requiredScopes.some(scope => tokenScope.includes(scope));
      } catch (error) {
        console.error('Error decrypting Google Services tokens:', error);
      }
    }

    res.json({
      isConnected,
      hasRefreshToken,
      hasRequiredScopes,
      needsReauth: isConnected && (!hasRefreshToken || !hasRequiredScopes)
    });
  } catch (error) {
    console.error('Google Services status error:', error);
    res.status(500).json({ error: 'Failed to check Google Services status' });
  }
});

// Register
router.post('/register', registerRateLimit, validateBody(RegisterRequestSchema, { codePrefix: 'auth' }), [
  // Name: 2..100 chars, strip HTML tags / control chars. We keep
  // accents + unicode letters because the user base is multilingual.
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters')
    .customSanitizer((v) => String(v).replace(/<[^>]*>/g, '').slice(0, 100)),
  // Email: RFC max length is 254. normalizeEmail collapses gmail dots
  // + plus tags so + tricks can't bypass uniqueness.
  body('email')
    .isEmail({ allow_utf8_local_part: true }).withMessage('Valid email required')
    .isLength({ max: 254 }).withMessage('Email is too long')
    .normalizeEmail(),
  // Password: 8..128, at least one letter AND one number. Stronger
  // than the previous min:6/no-complexity rule but still permissive
  // enough that legacy users don't trip the gate on /login (login
  // intentionally uses notEmpty() so existing weak passwords keep
  // working until reset).
  body('password')
    .isLength({ min: 8, max: 128 }).withMessage('Password must be 8-128 characters')
    .matches(/[A-Za-z]/).withMessage('Password must contain at least one letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ...formatExpressValidatorErrors(errors.array(), { codePrefix: 'auth' }), errors: errors.array() });
    }

    const { name, email, password } = req.body;

    // SSO domain claim (ratchet 45) — same gate as /login: if the
    // email domain belongs to an SSO-enabled org we refuse to create
    // a password-backed account and steer the user to the IdP.
    const ssoOrg = await resolveOrgBySsoDomain(email);
    if (ssoOrg) {
      return res.status(501).json({
        ok: false,
        ssoRequired: true,
        implemented: false,
        message: 'password registration disabled — use SSO for this organization',
        orgSlug: ssoOrg.slug,
        ssoLoginUrl: `/api/auth/sso/${ssoOrg.slug}/login`,
      });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        plan: 'FREE',
        isAdmin: false,
        apiUsage: 0,
        monthlyCallLimit: 3,   // <-- new: 3 queries/month for Free
        monthlyLimit: 10000
      }
    });

    // Create session — embed isSuperAdmin claim so the rate-limit
    // bypass + downstream policy checks can use it without a DB
    // lookup on the hot path. aud/iss claims are added centrally via
    // signSessionToken().
    const token = signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt
      }
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // Mint a fresh CSRF token alongside the session cookie so SPAs
    // can skip the dedicated /api/csrf-token roundtrip (ratchet 45,
    // task 2). The token still rotates on every call — `issueCsrfToken`
    // resets both the public + secret cookies with brand-new randomness.
    const csrfToken = issueCsrfToken(res);

    res.status(201).json({
      user: userWithoutPassword,
      token,
      csrfToken,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', loginRateLimit, validateBody(LoginRequestSchema, { codePrefix: 'auth' }), [
  body('email')
    .isEmail({ allow_utf8_local_part: true }).withMessage('Valid email required')
    .isLength({ max: 254 }).withMessage('Email is too long')
    .normalizeEmail(),
  // Intentionally lenient on min/max here: legacy users may have weak
  // passwords from before the register tightening landed. We still
  // bound the upper length so a bcrypt.compare bomb can't be sent.
  body('password').isString().isLength({ min: 1, max: 256 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ...formatExpressValidatorErrors(errors.array(), { codePrefix: 'auth' }), errors: errors.array() });
    }

    const { email, password } = req.body;

    // SSO domain claim (ratchet 45) — if any org has claimed the
    // user's email domain AND ssoEnabled = true, bounce them at the
    // password handler so password auth can't be used to bypass the
    // org's IdP. The actual redirect target (501) is the SSO scaffold
    // route; see `GET /api/auth/sso/:orgSlug/login`. Once the real
    // SAML/OIDC handshake ships this becomes a 302.
    const ssoOrg = await resolveOrgBySsoDomain(email);
    if (ssoOrg) {
      void writeAuditLog(prisma, {
        req,
        action: 'login_sso_required',
        resource: 'organization',
        resourceId: ssoOrg.id,
        actorName: email,
        metadata: { orgSlug: ssoOrg.slug },
      });
      return res.status(501).json({
        ok: false,
        ssoRequired: true,
        implemented: false,
        message: 'password login disabled — use SSO for this organization',
        orgSlug: ssoOrg.slug,
        ssoLoginUrl: `/api/auth/sso/${ssoOrg.slug}/login`,
      });
    }

    // Account-level lockout — distinct from the per-IP rate limit so
    // distributed credential-stuffing (one attempt per IP) still hits
    // a cap. See utils/login-lockout.js for the rolling window.
    const lockState = defaultLockout.isLocked(email);
    if (lockState.locked) {
      const retryAfterSec = Math.max(1, Math.ceil(lockState.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      void writeAuditLog(prisma, {
        req,
        action: 'account_locked',
        resource: 'user',
        actorName: email,
        metadata: { reason: 'too_many_failures', attempts: lockState.attempts },
      });
      return res.status(423).json({
        error: 'Account temporarily locked. Try again later.',
        retryAfterMs: lockState.retryAfterMs,
      });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      const after = defaultLockout.recordFailure(email);
      void writeAuditLog(prisma, {
        req,
        action: 'login_failed',
        resource: 'user',
        actorName: email,
        metadata: { reason: 'unknown_email', attempts: after.attempts },
      });
      if (after.locked) {
        void writeAuditLog(prisma, {
          req,
          action: 'account_locked',
          resource: 'user',
          actorName: email,
          metadata: { reason: 'failure_threshold', attempts: after.attempts },
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      const after = defaultLockout.recordFailure(email);
      void writeAuditLog(prisma, {
        req,
        action: 'login_failed',
        resource: 'user',
        resourceId: user.id,
        actorName: email,
        metadata: { reason: 'bad_password', attempts: after.attempts },
      });
      if (after.locked) {
        void writeAuditLog(prisma, {
          req,
          action: 'account_locked',
          resource: 'user',
          resourceId: user.id,
          actorName: email,
          metadata: { reason: 'failure_threshold', attempts: after.attempts },
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Successful credential check — clear lockout counter.
    defaultLockout.recordSuccess(email);

    // ─── Org-level 2FA enforcement (ratchet 45) ───────────────
    // When the user belongs to an org with settings.security.requireTwoFactor
    // enabled and has not enrolled either SMS or TOTP, refuse to mint a
    // session. The SMS/TOTP gates below already handle users who *have*
    // enrolled 2FA — this gate fires when the user has none at all.
    if (!userHasTwoFactor(user) && prisma.orgMembership?.findMany) {
      try {
        const memberships = await prisma.orgMembership.findMany({
          where: { userId: user.id },
          include: { organization: { select: { id: true, slug: true, settings: true } } },
        });
        const blocking = memberships.find((m) => orgRequiresTwoFactor(m.organization));
        if (blocking) {
          void writeAuditLog(prisma, {
            req,
            action: 'login_blocked_org_2fa',
            resource: 'user',
            resourceId: user.id,
            userId: user.id,
            actorName: user.email,
            metadata: { orgId: blocking.organization.id },
          });
          return res.status(403).json({
            error: 'organization requires two-factor authentication',
            code: 'org_requires_2fa',
            orgId: blocking.organization.id,
          });
        }
      } catch (e) {
        console.error('[auth/login] org-2fa check failed:', e?.message || e);
        // Fail open on transient DB errors to avoid locking everyone out —
        // the per-route enforce hook still blocks org-scoped fetches.
      }
    }

    // ─── SMS 2FA gate (ratchet 45) ────────────────────────────
    // When the user has opted in (User.twoFactorEnabled) AND has a
    // verified phone on file, do NOT mint a session JWT yet. Instead
    // mint a TwoFAChallenge row, send the OTP, and respond 202 with
    // { twoFactorRequired: true, challengeId }. The FE then submits
    // POST /api/auth/2fa/sms/verify to redeem a full JWT. Falls back
    // to the legacy flow (full JWT immediately) when 2FA is not
    // enabled so cycle-0 callers are unaffected.
    if (user.twoFactorEnabled && user.phoneVerifiedAt && user.phone
      && twoFASms.isValidPhone(user.phone)) {
      try {
        const { challengeId, code, expiresAt } = await twoFASms.createSmsChallenge(
          prisma,
          user,
          user.phone,
        );
        const smsResult = await twoFASms.sendSms(user.phone, code);
        void writeAuditLog(prisma, {
          req,
          action: 'login_2fa_required',
          resource: 'user',
          resourceId: user.id,
          userId: user.id,
          actorName: user.email,
          metadata: {
            phoneMasked: user.phone.replace(/.(?=.{4})/g, '*'),
            smsSent: Boolean(smsResult.sent),
            smsReason: smsResult.reason || null,
          },
        });
        const body202 = {
          twoFactorRequired: true,
          challengeId,
          expiresAt: expiresAt.toISOString(),
          smsSent: Boolean(smsResult.sent),
        };
        if (!smsResult.sent && smsResult.reason) {
          body202.smsSkippedReason = smsResult.reason;
        }
        return res.status(202).json(body202);
      } catch (e) {
        console.error('[auth/login] 2fa challenge mint failed:', e?.message || e);
        return res.status(500).json({ error: 'Failed to issue 2FA challenge' });
      }
    }

    // ─── TOTP 2FA gate (ratchet 45) ────────────────────────────
    // When the user has enrolled TOTP (totpEnabled = true) but has NOT
    // opted into SMS 2FA (twoFactorEnabled = false), we still refuse to
    // mint a full session JWT until they prove possession of the
    // authenticator app. The client receives a partial-session token
    // and submits POST /api/auth/2fa/totp/verify { code } to redeem the
    // full token. SMS-enabled users keep the SMS-only flow above (TOTP
    // is treated as the secondary lever there — out of scope for this
    // cycle).
    if (user.totpEnabled && !user.twoFactorEnabled) {
      try {
        const partial = await mintPartialSession(user.id);
        void writeAuditLog(prisma, {
          req,
          action: 'login_totp_required',
          resource: 'user',
          resourceId: user.id,
          userId: user.id,
          actorName: user.email,
        });
        return res.status(202).json({
          twoFactorRequired: true,
          method: 'totp',
          partialToken: partial.token,
          expiresAt: partial.expiresAt.toISOString(),
        });
      } catch (e) {
        console.error('[auth/login] partial-session mint failed:', e?.message || e);
        return res.status(500).json({ error: 'Failed to issue TOTP challenge' });
      }
    }

    // Create session — embed admin / super-admin claims so the
    // rate-limit bypass + admin route guards can read them without
    // hitting the DB on every authenticated request. aud/iss claims
    // added centrally via signSessionToken().
    const token = signSessionToken({
      userId: user.id,
      isAdmin: Boolean(user.isAdmin),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Bind the session to the issuing client's IP-class + UA hash so
    // a leaked token can't be replayed from a different network /
    // browser. See utils/session-fingerprint.js for the reduce-to-/24
    // tolerance for mobile networks.
    const fingerprint = computeFingerprint(req);
    try {
      await prisma.session.create({
        data: {
          userId: user.id,
          token,
          expiresAt,
          fingerprint,
        }
      });
    } catch (e) {
      // Fallback for environments where the schema hasn't been
      // migrated yet (the fingerprint column was added in cycle 17).
      if (e && /fingerprint/i.test(String(e.message))) {
        await prisma.session.create({
          data: { userId: user.id, token, expiresAt }
        });
      } else {
        throw e;
      }
    }

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const serializedUser = serializeUser(userWithoutPassword);
    void writeAuditLog(prisma, {
      req,
      action: 'login',
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
      actorName: user.email,
      metadata: { isAdmin: Boolean(user.isAdmin), isSuperAdmin: Boolean(user.isSuperAdmin) },
    });
    // Mint a fresh CSRF token alongside the session cookie so SPAs
    // can skip the dedicated /api/csrf-token roundtrip (ratchet 45,
    // task 2). Token rotates on every login.
    const csrfToken = issueCsrfToken(res);

    res.json({
      user: serializedUser,
      token,
      csrfToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { password: _, ...userWithoutPassword } = req.user;
    const serializedUser = serializeUser(userWithoutPassword);
    // Convenience boolean for clients — derived from emailVerifiedAt so
    // the existing timestamp field stays the source of truth. Adding a
    // new top-level field is backward compatible.
    const emailVerified = serializedUser != null && serializedUser.emailVerifiedAt != null;
    // Ratchet 45 — surface 2FA status + remaining-recovery-codes count so
    // the settings UI can show "X codes left" without an extra round-trip.
    // We never echo back the hashed codes themselves; only the count of
    // entries with `usedAt == null` is exposed.
    const totpEnabled = Boolean(req.user.totpEnabled);
    const twoFactorEnabled = Boolean(req.user.twoFactorEnabled);
    const recoveryCodes = Array.isArray(req.user.totpRecoveryCodes)
      ? req.user.totpRecoveryCodes
      : [];
    const totpRecoveryCodesRemaining = recoveryCodes.reduce(
      (n, entry) => (entry && entry.usedAt == null ? n + 1 : n),
      0,
    );
    res.json({
      user: serializedUser,
      emailVerified,
      totpEnabled,
      twoFactorEnabled,
      totpRecoveryCodesRemaining,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await prisma.session.deleteMany({
      where: { token: req.token }
    });

    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Refresh token
//
// TODO(security): implement refresh-token rotation. Currently this
// re-signs a long-lived (7d) access token whenever the client asks.
// A stolen token can be refreshed indefinitely until the original
// session row is deleted. Migrating to short-lived (15m) access +
// rotating opaque refresh tokens stored in Session is the correct
// fix but requires coordinated FE+BE changes; tracked separately.
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // Create new token — re-embed admin claims so the rate-limit
    // bypass continues to apply across refreshes.
    const newToken = signSessionToken({
      userId: req.user.id,
      isAdmin: Boolean(req.user.isAdmin),
      isSuperAdmin: Boolean(req.user.isSuperAdmin),
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Update session — re-bind fingerprint to the refreshing client
    // so subsequent verifications track the current network/UA.
    const refreshedFp = computeFingerprint(req);
    try {
      await prisma.session.update({
        where: { token: req.token },
        data: { token: newToken, expiresAt, fingerprint: refreshedFp }
      });
    } catch (e) {
      if (e && /fingerprint/i.test(String(e.message))) {
        await prisma.session.update({
          where: { token: req.token },
          data: { token: newToken, expiresAt }
        });
      } else {
        throw e;
      }
    }

    res.cookie('token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    void writeAuditLog(prisma, {
      req,
      action: 'token_refresh',
      resource: 'session',
      userId: req.user.id,
      actorName: req.user.email,
    });

    res.json({ token: newToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Super Admin Impersonation — hardened.
//
// SECURITY:
//   - Token TTL reduced from 24h to 30m so a leaked impersonation
//     cookie has a much smaller blast radius.
//   - Caller must provide `reason` (>= 10 chars) so the audit row
//     answers "why did admin X log in as user Y".
//   - Per-target rate limit: max 3 impersonations / hour, keyed
//     on `${adminId}:${targetUserId}`. Mitigates abuse without
//     blocking legitimate "admin needs to reproduce a bug" flows.
//   - Every successful + denied attempt is logged with the
//     `[SUPER_ADMIN_AUDIT]` tag for grep / SIEM ingestion.
//
// The rate-limit map lives in-process. For multi-instance deploys
// promote this to the existing rate-limit-store (Redis) when
// REDIS_URL is configured.
const IMPERSONATE_LIMIT = 3;
const IMPERSONATE_WINDOW_MS = 60 * 60 * 1000;
const impersonateAttempts = new Map(); // key: `${adminId}:${targetId}` → number[] (timestamps)
const IMPERSONATE_TTL_MS = 30 * 60 * 1000;

function recordImpersonationAttempt(adminId, targetId) {
  const key = `${adminId}:${targetId}`;
  const now = Date.now();
  const arr = (impersonateAttempts.get(key) || []).filter((t) => now - t < IMPERSONATE_WINDOW_MS);
  if (arr.length >= IMPERSONATE_LIMIT) {
    return { ok: false, retryAfterMs: IMPERSONATE_WINDOW_MS - (now - arr[0]) };
  }
  arr.push(now);
  impersonateAttempts.set(key, arr);
  return { ok: true };
}

router.post('/impersonate/:userId', authenticateToken, async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      console.warn(`[SUPER_ADMIN_AUDIT] impersonate_denied non_admin=${req.user.email} target=${req.params.userId}`);
      return res.status(403).json({ error: 'Super admin access required' });
    }

    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 10) {
      return res.status(400).json({
        error: 'Impersonation reason required (min 10 chars) for the audit log',
      });
    }

    const { userId } = req.params;

    const rate = recordImpersonationAttempt(req.user.id, userId);
    if (!rate.ok) {
      console.warn(`[SUPER_ADMIN_AUDIT] impersonate_rate_limited admin=${req.user.email} target=${userId}`);
      const retryAfterSec = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many impersonations for this target. Try again later.',
        retryAfterMs: rate.retryAfterMs,
      });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (targetUser.isSuperAdmin) {
      console.warn(`[SUPER_ADMIN_AUDIT] impersonate_denied_super_admin admin=${req.user.email} target=${targetUser.email}`);
      return res.status(403).json({ error: 'Cannot impersonate other super admins' });
    }

    const impersonationToken = signSessionToken(
      {
        userId: targetUser.id,
        impersonatedBy: req.user.id,
        isImpersonation: true,
      },
      { expiresIn: '30m' }
    );

    const expiresAt = new Date(Date.now() + IMPERSONATE_TTL_MS);

    await prisma.session.create({
      data: {
        userId: targetUser.id,
        token: impersonationToken,
        expiresAt,
      },
    });

    console.warn(
      `[SUPER_ADMIN_AUDIT] impersonate_granted admin=${req.user.email} target=${targetUser.email} reason=${JSON.stringify(reason)} ttl=30m`
    );
    void writeAuditLog(prisma, {
      req,
      action: 'impersonate',
      resource: 'user',
      resourceId: targetUser.id,
      userId: req.user.id,
      actorName: req.user.email,
      metadata: { targetEmail: targetUser.email, reason, ttlMs: IMPERSONATE_TTL_MS },
    });

    res.json({
      token: impersonationToken,
      user: serializeUser(targetUser),
      impersonatedBy: req.user.id,
      expiresAt,
    });
  } catch (error) {
    console.error('Impersonation error:', error);
    res.status(500).json({ error: 'Impersonation failed' });
  }
});

// End impersonation and return to super admin account
router.post('/end-impersonation', authenticateToken, async (req, res) => {
  try {
    // Get the token payload to check if it's an impersonation session
    const decoded = jwt.verify(req.token, process.env.JWT_SECRET);
    
    if (!decoded.isImpersonation || !decoded.impersonatedBy) {
      return res.status(400).json({ error: 'Not an impersonation session' });
    }

    // Find the original super admin user
    const superAdmin = await prisma.user.findUnique({
      where: { id: decoded.impersonatedBy }
    });

    if (!superAdmin || !superAdmin.isSuperAdmin) {
      return res.status(403).json({ error: 'Original super admin not found' });
    }

    // Delete the impersonation session
    await prisma.session.deleteMany({
      where: { token: req.token }
    });

    // Create new session for super admin
    const newToken = signSessionToken({
      userId: superAdmin.id,
      isAdmin: Boolean(superAdmin.isAdmin),
      isSuperAdmin: Boolean(superAdmin.isSuperAdmin),
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        userId: superAdmin.id,
        token: newToken,
        expiresAt
      }
    });

    console.log(`Ending impersonation, returning to super admin ${superAdmin.email}`);

    res.json({
      token: newToken,
      user: serializeUser(superAdmin)
    });
  } catch (error) {
    console.error('End impersonation error:', error);
    res.status(500).json({ error: 'Failed to end impersonation' });
  }
});

// ── Active session management ──────────────────────────────────────────────
// GET  /api/auth/sessions       — list this user's active sessions
// DELETE /api/auth/sessions/:id — revoke a specific session (not current)
//
// The Session model has no dedicated ip/ua columns today, so we surface
// whatever the audit-log writer stashed under `metadata` for the closest
// preceding `login` / `token_refresh` event of the same user (best-effort).
// When that lookup yields nothing the IP/UA fields are simply null — the
// endpoint MUST not throw on missing telemetry.
const { maskIp, parseUA } = require('../utils/session-info');

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    // Pagination: ?page= (default 1) / ?limit= (default 20, capped at 100).
    // Garbage input collapses to the defaults rather than 400-ing so the
    // sessions UI keeps working when a stale query string is hanging around.
    const SESSIONS_DEFAULT_LIMIT = 20;
    const SESSIONS_MAX_LIMIT = 100;
    const rawPage = parseInt(req.query.page, 10);
    const rawLimit = parseInt(req.query.limit, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Math.min(
      SESSIONS_MAX_LIMIT,
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : SESSIONS_DEFAULT_LIMIT,
    );
    const where = { userId: req.user.id, expiresAt: { gt: now } };
    const total = typeof prisma.session.count === 'function'
      ? await prisma.session.count({ where })
      : null;
    const sessions = await prisma.session.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, token: true, createdAt: true, expiresAt: true },
    });

    // Best-effort enrichment: pull recent login/refresh audit rows for
    // this user so we can attribute ip/ua to each session by createdAt
    // proximity. Audit-log reads may fail (table missing in narrow test
    // mocks) — degrade silently.
    let auditRows = [];
    try {
      if (prisma.auditLog && typeof prisma.auditLog.findMany === 'function') {
        auditRows = await prisma.auditLog.findMany({
          where: {
            actorId: req.user.id,
            action: { in: ['login', 'token_refresh', 'register'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { createdAt: true, metadata: true },
        });
      }
    } catch (_) { /* ignore — enrichment is optional */ }

    function pickAuditFor(createdAt) {
      // Closest audit row at-or-before the session's createdAt within
      // a 30-minute window. Falls back to the session's own ip/ua from
      // the active request when the session matches `req.token`.
      const ts = createdAt instanceof Date ? createdAt.getTime() : 0;
      let best = null;
      let bestDelta = Infinity;
      for (const r of auditRows) {
        const rt = r.createdAt instanceof Date ? r.createdAt.getTime() : 0;
        const delta = Math.abs(rt - ts);
        if (delta < bestDelta && delta < 30 * 60 * 1000) {
          bestDelta = delta;
          best = r;
        }
      }
      return best && best.metadata && typeof best.metadata === 'object'
        ? best.metadata
        : null;
    }

    const currentReqMeta = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      ua: req.headers['user-agent'] || null,
    };

    const items = sessions.map((s) => {
      const isCurrent = s.token === req.token;
      const meta = pickAuditFor(s.createdAt) || (isCurrent ? currentReqMeta : null) || {};
      return {
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        ip: maskIp(meta.ip || null),
        ua: parseUA(meta.ua || null),
        current: isCurrent,
      };
    });

    const safeTotal = typeof total === 'number' ? total : items.length;
    const pages = limit > 0 ? Math.max(1, Math.ceil(safeTotal / limit)) : 1;
    res.json({ sessions: items, total: safeTotal, page, pages, limit });
  } catch (err) {
    console.error('[auth/sessions] list failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.delete('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'session id required' });

    const target = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, token: true },
    });
    if (!target || target.userId !== req.user.id) {
      // Don't disclose existence of another user's session — same
      // status code as a genuine 404 keeps enumeration noisy.
      return res.status(404).json({ error: 'Session not found' });
    }
    if (target.token === req.token) {
      // Refuse to nuke the active session via this endpoint — that's
      // what /logout is for and avoids a confusing "Suddenly logged out"
      // surprise after a misclick in the sessions UI.
      return res.status(400).json({
        error: 'Cannot revoke the current session; use /api/auth/logout instead',
        reason: 'is_current',
      });
    }

    await prisma.session.delete({ where: { id } });
    void writeAuditLog(prisma, {
      req,
      action: 'session_revoked',
      resource: 'session',
      resourceId: id,
      userId: req.user.id,
      actorName: req.user.email,
    });

    res.json({ ok: true, id });
  } catch (err) {
    console.error('[auth/sessions/:id] revoke failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// POST /api/auth/sessions/revoke-all — revoke every active session for
// the calling user EXCEPT the one bound to the current request token.
// Returned `count` is the number of rows deleted (0 when the caller is
// already on their only active session). Writes a single audit-log
// event `sessions_revoked_all` with the count in metadata so SIEM can
// alert on mass-revocations (a common post-compromise reaction).
router.post('/sessions/revoke-all', authenticateToken, async (req, res) => {
  try {
    const result = await prisma.session.deleteMany({
      where: { userId: req.user.id, NOT: { token: req.token } },
    });
    const count = (result && typeof result.count === 'number') ? result.count : 0;

    void writeAuditLog(prisma, {
      req,
      action: 'sessions_revoked_all',
      resource: 'session',
      userId: req.user.id,
      actorName: req.user.email,
      metadata: { count },
    });

    res.json({ ok: true, count });
  } catch (err) {
    console.error('[auth/sessions/revoke-all] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

// ─── SSO scaffold (ratchet 45) ──────────────────────────────────────
// Two public endpoints that resolve an org by slug and *would* hand off
// to the configured SAML/OIDC provider. The handshake itself is not
// implemented yet — both endpoints return 501 with the redacted config
// so the FE can wire its "Continue with SSO" button and integration
// tests can assert the contract before the real implementation lands.
//
//   GET /api/auth/sso/:orgSlug/login     — redirect target placeholder
//   GET /api/auth/sso/:orgSlug/callback  — IdP callback placeholder
//
// When the integration ships the login route should 302 to
// `org.ssoConfig.entryPoint` with the provider-specific query params,
// and the callback should validate the SAML response / OIDC code and
// mint a Sira session for the matched user.

function redactSsoConfigForPublic(config) {
  if (!config || typeof config !== 'object') return null;
  return {
    provider: config.provider || null,
    entryPoint: config.entryPoint || null,
    issuer: config.issuer || null,
    callbackUrl: config.callbackUrl || null,
    audience: config.audience || null,
    // never expose cert/clientSecret on a public endpoint
  };
}

async function resolveOrgForSso(slug) {
  if (!slug || typeof slug !== 'string') return null;
  try {
    const row = await prisma.organization.findUnique({
      where: { slug: slug.trim().toLowerCase() },
      select: { id: true, slug: true, ssoConfig: true, ssoEnabled: true },
    });
    return row || null;
  } catch (err) {
    console.error('[auth/sso] lookup failed:', err && err.message ? err.message : err);
    return null;
  }
}

router.get('/sso/:orgSlug/login', async (req, res) => {
  const org = await resolveOrgForSso(req.params.orgSlug);
  if (!org) return res.status(404).json({ error: 'organization not found' });
  if (!org.ssoEnabled || !org.ssoConfig) {
    return res.status(400).json({ error: 'SSO is not enabled for this organization' });
  }
  return res.status(501).json({
    ok: false,
    implemented: false,
    message: 'SSO login redirect not implemented',
    orgSlug: org.slug,
    config: redactSsoConfigForPublic(org.ssoConfig),
  });
});

router.get('/sso/:orgSlug/callback', async (req, res) => {
  const org = await resolveOrgForSso(req.params.orgSlug);
  if (!org) return res.status(404).json({ error: 'organization not found' });
  if (!org.ssoEnabled || !org.ssoConfig) {
    return res.status(400).json({ error: 'SSO is not enabled for this organization' });
  }
  return res.status(501).json({
    ok: false,
    implemented: false,
    message: 'SSO callback handler not implemented',
    orgSlug: org.slug,
    receivedParams: Object.keys(req.query || {}),
  });
});

// Resolve an org claiming `email`'s domain for SSO. Returns null if
// no org has that domain in `ssoDomains` **and** `ssoEnabled = true`.
// Used by /login + /register to short-circuit password auth to the
// SSO redirect (currently the 501 scaffold).
function extractEmailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d || null;
}

async function resolveOrgBySsoDomain(email, deps = { prisma }) {
  const db = deps.prisma || prisma;
  const domain = extractEmailDomain(email);
  if (!domain) return null;
  try {
    const row = await db.organization.findFirst({
      where: { ssoEnabled: true, ssoDomains: { has: domain } },
      select: { id: true, slug: true, ssoEnabled: true },
    });
    return row || null;
  } catch (err) {
    // Fail-open: if the lookup itself blows up we'd rather let the
    // user attempt password auth than lock them out of the product.
    console.error('[auth/sso] domain lookup failed:', err && err.message ? err.message : err);
    return null;
  }
}

// Test surface — let route tests poke the helpers without a live DB.
router.__ssoHelpers = {
  redactSsoConfigForPublic,
  resolveOrgForSso,
  extractEmailDomain,
  resolveOrgBySsoDomain,
};

// ─── Email verification (ratchet 45) ───────────────────────────────
// Two endpoints: the magic-link redeemer (public, GET) and the resend
// endpoint (authenticated, POST). Both reuse services/email-verification.js
// so the org-invitation accept flow can mint tokens through the same
// helper.

const {
  createVerificationToken,
  redeemVerificationToken,
} = require('../services/email-verification');
const emailService = require('../services/email');

// Resend is rate-limited per user so a malicious client can't spam an
// inbox. 3 per 15 min lines up with the password-reset limiter.
const resendVerificationRateLimit = makeAuthRateLimit({
  name: 'resend-verification',
  limit: 3,
  windowMs: 15 * 60 * 1000,
  keyBy: 'ip+email',
});

// GET /api/auth/verify-email/:token — public. Sets emailVerifiedAt = now
// when the token is valid + unconsumed + unexpired.
router.get('/verify-email/:token', verifyEmailRateLimit, async (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) {
    return res.status(400).json({ error: 'invalid token' });
  }
  try {
    const result = await redeemVerificationToken(prisma, token);
    if (result.ok) {
      void writeAuditLog(prisma, {
        req,
        action: 'email_verified',
        resource: 'user',
        resourceId: result.userId,
        userId: result.userId,
      });
      return res.json({ ok: true, userId: result.userId });
    }
    switch (result.code) {
      case 'expired':
        return res.status(410).json({ error: 'verification token expired' });
      case 'already_used':
        return res.status(409).json({ error: 'verification token already used' });
      case 'not_found':
      default:
        return res.status(404).json({ error: 'verification token not found' });
    }
  } catch (err) {
    console.error('[auth/verify-email] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'failed to verify email' });
  }
});

// POST /api/auth/resend-verification — authenticated. Mints a fresh
// token + emails it. No-ops with 200 if the user is already verified
// so the FE can be naive about state.
router.post('/resend-verification', authenticateToken, resendVerificationRateLimit, async (req, res) => {
  try {
    const user = req.user;
    if (user.emailVerifiedAt) {
      return res.json({ ok: true, alreadyVerified: true });
    }
    const { token, expiresAt } = await createVerificationToken(prisma, user.id);
    const userArg = { name: user.name, email: user.email };
    // Ratchet 45 — critical email: persist into the failed-email retry
    // queue if the SMTP transport throws. We still await so the FE can
    // surface an immediate 500 on the first try, but the retry queue
    // gives the 06:00 UTC cron a second + third chance to deliver.
    try {
      await emailService.sendEmailVerification(userArg, token);
    } catch (sendErr) {
      try {
        const retryQueue = require('../services/failed-email-retry');
        await retryQueue.enqueue(prisma, 'verification', { user: userArg, token });
      } catch (_) { /* queue persistence best-effort */ }
      throw sendErr;
    }
    void writeAuditLog(prisma, {
      req,
      action: 'verification_resent',
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
      actorName: user.email,
    });
    res.json({ ok: true, expiresAt });
  } catch (err) {
    console.error('[auth/resend-verification] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'failed to send verification email' });
  }
});

// ─── SMS-based 2FA login scaffold (ratchet 45, cycle 131) ─────────
// Two endpoints that scaffold the SMS second-factor on top of the
// `TwoFAChallenge` Prisma model. The login flow itself (binding a
// partial session → final JWT only after a verified code) is left
// for the next cycle — these endpoints expose the challenge
// lifecycle so the FE can wire the UI in parallel.
//
//   POST /api/auth/2fa/sms/challenge { phone | email | sessionToken }
//     → resolves the contact to a User, mints a 6-digit OTP, fans it
//       out via Twilio. Returns { challengeId, expiresAt } so the
//       client can submit /verify without re-sending the contact.
//
//   POST /api/auth/2fa/sms/verify { challengeId, code }
//     → matches the code against the row; on success returns a
//       fresh JWT bound to the resolved User. Falls back to a
//       generic 400 on unknown / expired / bad-code so a passive
//       observer can't enumerate which contacts are registered.
//
// Both endpoints are rate-limited per IP+contact / IP+challengeId via
// the shared auth-rate-limit middleware so distributed brute-force
// is bounded by the 5-attempts-per-row cap inside the service layer.
const twoFASmsChallengeRateLimit = makeAuthRateLimit({
  name: '2fa-sms-challenge',
  limit: 5,
  windowMs: 15 * 60 * 1000, // 15 min
  keyBy: 'ip+email',
});
const twoFASmsVerifyRateLimit = makeAuthRateLimit({
  name: '2fa-sms-verify',
  limit: 10,
  windowMs: 15 * 60 * 1000, // 15 min
  keyBy: 'ip',
});

router.post(
  '/2fa/sms/challenge',
  twoFASmsChallengeRateLimit,
  [
    body('phone').optional().isString().trim().isLength({ min: 9, max: 16 }),
    body('email').optional().isString().trim().isLength({ max: 254 }),
    body('sessionToken').optional().isString().isLength({ min: 16, max: 1024 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { phone, email, sessionToken } = req.body || {};
      if (!phone && !email && !sessionToken) {
        return res.status(400).json({
          error: 'phone, email, or sessionToken required',
        });
      }

      const user = await twoFASms.resolveUser(prisma, { phone, email, sessionToken });

      // Always return a 200-shaped body even when the user lookup
      // fails — opaque expiresAt + opaque challengeId — so an
      // attacker can't enumerate "is this email registered?" by
      // poking the endpoint. We DO NOT mint a row in that case.
      if (!user || !user.phone || !twoFASms.isValidPhone(user.phone)) {
        // Audit the miss without leaking which contact field tripped.
        void writeAuditLog(prisma, {
          req,
          action: '2fa_sms_challenge_miss',
          resource: 'user',
          metadata: { hasPhone: Boolean(phone), hasEmail: Boolean(email) },
        });
        return res.json({
          ok: true,
          challengeId: twoFASms.mintChallengeId(),
          expiresAt: new Date(Date.now() + twoFASms.ttlMs()).toISOString(),
          smsSent: false,
          smsSkippedReason: 'unknown-contact',
        });
      }

      const { challengeId, code, expiresAt } = await twoFASms.createSmsChallenge(
        prisma,
        user,
        user.phone,
      );

      const smsResult = await twoFASms.sendSms(user.phone, code);

      void writeAuditLog(prisma, {
        req,
        action: '2fa_sms_challenge_sent',
        resource: 'user',
        resourceId: user.id,
        userId: user.id,
        metadata: {
          phoneMasked: user.phone.replace(/.(?=.{4})/g, '*'),
          smsSent: Boolean(smsResult.sent),
          smsReason: smsResult.reason || null,
        },
      });

      const body = {
        ok: true,
        challengeId,
        expiresAt: expiresAt.toISOString(),
        smsSent: Boolean(smsResult.sent),
      };
      if (!smsResult.sent && smsResult.reason) {
        body.smsSkippedReason = smsResult.reason;
      }
      return res.json(body);
    } catch (error) {
      if (error?.code === 'invalid_phone' || error?.code === 'unknown_contact') {
        return res.status(400).json({ error: 'invalid contact for 2FA' });
      }
      console.error('[auth/2fa/sms/challenge] failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to issue 2FA challenge' });
    }
  },
);

router.post(
  '/2fa/sms/verify',
  twoFASmsVerifyRateLimit,
  [
    body('challengeId').isString().trim().isLength({ min: 16, max: 128 }),
    body('code').isString().trim().isLength({ min: 6, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { challengeId, code } = req.body;
      const result = await twoFASms.verifyChallenge(prisma, challengeId, code);

      if (!result.ok) {
        switch (result.code) {
          case 'invalid_input':
            return res.status(400).json({ error: 'challengeId or code malformed' });
          case 'not_found':
            return res.status(404).json({ error: 'No active 2FA challenge' });
          case 'expired':
            return res.status(410).json({ error: '2FA challenge expired' });
          case 'too_many_attempts':
            void writeAuditLog(prisma, {
              req,
              action: '2fa_sms_locked',
              resource: 'user',
              metadata: { attempts: result.attempts },
            });
            return res.status(429).json({
              error: 'Too many attempts. Request a new code.',
              attempts: result.attempts,
            });
          case 'invalid_code':
            return res.status(400).json({
              error: 'Invalid verification code',
              attempts: result.attempts,
              remaining: result.remaining,
            });
          default:
            return res.status(400).json({ error: '2FA verification failed' });
        }
      }

      // Success — mint a full session JWT for the resolved user. Mirrors
      // the email/password /login handler so downstream middleware sees
      // an identical token shape. The partial-session model that would
      // gate this behind an earlier login step lands next cycle.
      const user = await prisma.user.findUnique({ where: { id: result.userId } });
      if (!user) {
        // The row's user disappeared between challenge mint and verify.
        return res.status(404).json({ error: 'User no longer exists' });
      }

      const token = signSessionToken({
        userId: user.id,
        isAdmin: Boolean(user.isAdmin),
        isSuperAdmin: Boolean(user.isSuperAdmin),
      });
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const fingerprint = computeFingerprint(req);
      try {
        await prisma.session.create({
          data: { userId: user.id, token, expiresAt, fingerprint },
        });
      } catch (e) {
        if (e && /fingerprint/i.test(String(e.message))) {
          await prisma.session.create({ data: { userId: user.id, token, expiresAt } });
        } else {
          throw e;
        }
      }

      const { password: _pw, ...userWithoutPassword } = user;
      const serializedUser = serializeUser(userWithoutPassword);

      void writeAuditLog(prisma, {
        req,
        action: '2fa_sms_verified',
        resource: 'user',
        resourceId: user.id,
        userId: user.id,
        actorName: user.email,
      });

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      const csrfToken = issueCsrfToken(res);

      return res.json({
        ok: true,
        user: serializedUser,
        token,
        csrfToken,
      });
    } catch (error) {
      console.error('[auth/2fa/sms/verify] failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to verify 2FA challenge' });
    }
  },
);

// ─── TOTP login bridge (ratchet 45) ─────────────────────────────────
// A partial-session token is a 32-byte hex string persisted in
// PartialSession with a 5-minute TTL. It is NOT a JWT — the
// /api/auth/2fa/totp/verify handler looks it up by token, checks
// expiresAt + consumedAt, marks it consumed atomically, and only
// then mints a full session JWT for the bound userId.
const PARTIAL_SESSION_TTL_MS = 5 * 60 * 1000;

async function mintPartialSession(userId) {
  const { randomBytes } = require('node:crypto');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PARTIAL_SESSION_TTL_MS);
  await prisma.partialSession.create({
    data: { token, userId, expiresAt },
  });
  return { token, expiresAt };
}

const totpVerifyRateLimit = makeAuthRateLimit({
  name: '2fa-totp-verify',
  limit: 10,
  windowMs: 15 * 60 * 1000,
  keyBy: 'ip',
});

// A code is "TOTP-shaped" when it's a 6-digit string. Anything else is
// treated as a recovery-code candidate (ratchet 45, Task 2). Both
// branches feed through the same partial-session consumption pipeline.
function _isTotpShaped(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

router.post(
  '/2fa/totp/verify',
  totpVerifyRateLimit,
  [
    body('code').isString().isLength({ min: 6, max: 64 })
      .withMessage('code must be a 6-digit code or a recovery code'),
    body('partialToken').isString().isLength({ min: 32, max: 256 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { code, partialToken } = req.body;

      const row = await prisma.partialSession.findUnique({
        where: { token: partialToken },
      });
      if (!row) {
        return res.status(404).json({ error: 'partial session not found' });
      }
      if (row.consumedAt) {
        return res.status(409).json({ error: 'partial session already used' });
      }
      if (row.expiresAt.getTime() < Date.now()) {
        return res.status(410).json({ error: 'partial session expired' });
      }

      const user = await prisma.user.findUnique({ where: { id: row.userId } });
      if (!user || !user.totpSecret || !user.totpEnabled) {
        return res.status(400).json({ error: 'TOTP not enabled for user' });
      }

      // Reuse the same envelope decoder the users router uses. Lazy
      // require() avoids circular module loads when this file is
      // pulled in by the tests' require cache.
      const { INTERNAL } = require('./users');

      // Two acceptance paths (ratchet 45 / Task 2):
      //   1) 6-digit TOTP code — verified against the encrypted seed.
      //   2) Recovery code — matched (and consumed) against the
      //      hashed `totpRecoveryCodes` array on the user row.
      let ok = false;
      let usedRecovery = false;
      let updatedRecoveryCodes = null;

      if (_isTotpShaped(code)) {
        const secret = INTERNAL.decryptTotpSecret(user.totpSecret);
        if (!secret) {
          return res.status(500).json({ error: 'Stored TOTP secret is unreadable' });
        }
        const { verifyTotp } = require('../services/auth/totp');
        ok = verifyTotp(String(code), secret, { window: 1 });
      } else {
        // Recovery-code branch.
        const stored = Array.isArray(user.totpRecoveryCodes) ? user.totpRecoveryCodes : [];
        if (stored.length === 0) {
          return res.status(401).json({ error: 'Invalid TOTP code', code: 'totp_invalid' });
        }
        const candidateHash = INTERNAL.hashRecoveryCode(String(code));
        const idx = stored.findIndex(
          (entry) => entry && entry.hash === candidateHash && !entry.usedAt,
        );
        if (idx >= 0) {
          ok = true;
          usedRecovery = true;
          updatedRecoveryCodes = stored.map((entry, i) =>
            i === idx
              ? { ...entry, usedAt: new Date().toISOString() }
              : entry,
          );
        }
      }

      if (!ok) {
        void writeAuditLog(prisma, {
          req,
          action: 'login_totp_failed',
          resource: 'user',
          resourceId: user.id,
          userId: user.id,
          actorName: user.email,
        });
        return res.status(401).json({ error: 'Invalid TOTP code', code: 'totp_invalid' });
      }

      // Atomically consume the partial session. If another concurrent
      // verify already flipped it we treat that as 409 — defence-in-
      // depth against double-spend should a client retry.
      const consumed = await prisma.partialSession.updateMany({
        where: { token: partialToken, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (!consumed || (typeof consumed.count === 'number' && consumed.count === 0)) {
        return res.status(409).json({ error: 'partial session already used' });
      }

      // If the user redeemed via a recovery code, mark that entry as
      // used now that the partial session is locked in. The update is
      // best-effort — a failure here doesn't block the JWT mint, but
      // it does emit a warning so ops sees re-usable recovery codes.
      if (usedRecovery && updatedRecoveryCodes) {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { totpRecoveryCodes: updatedRecoveryCodes },
            select: { id: true },
          });
        } catch (err) {
          console.warn('[auth/2fa/totp/verify] failed to mark recovery code used:', err?.message || err);
        }
      }

      // Mint the full session JWT — mirrors the email/password path.
      const token = signSessionToken({
        userId: user.id,
        isAdmin: Boolean(user.isAdmin),
        isSuperAdmin: Boolean(user.isSuperAdmin),
      });
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const fingerprint = computeFingerprint(req);
      try {
        await prisma.session.create({
          data: { userId: user.id, token, expiresAt, fingerprint },
        });
      } catch (e) {
        if (e && /fingerprint/i.test(String(e.message))) {
          await prisma.session.create({ data: { userId: user.id, token, expiresAt } });
        } else {
          throw e;
        }
      }

      const { password: _pw, ...userWithoutPassword } = user;
      const serializedUser = serializeUser(userWithoutPassword);

      void writeAuditLog(prisma, {
        req,
        action: usedRecovery ? 'login_totp_recovery_used' : 'login_totp_verified',
        resource: 'user',
        resourceId: user.id,
        userId: user.id,
        actorName: user.email,
        metadata: usedRecovery ? { method: 'recovery_code' } : undefined,
      });

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      const csrfToken = issueCsrfToken(res);

      return res.json({
        ok: true,
        user: serializedUser,
        token,
        csrfToken,
      });
    } catch (error) {
      console.error('[auth/2fa/totp/verify] failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to verify TOTP code' });
    }
  },
);

// Expose helpers for unit tests (mirrors the SSO __ssoHelpers pattern).
router.__twoFAHelpers = { twoFASms, mintPartialSession, PARTIAL_SESSION_TTL_MS };

// ────────────────────────────────────────────────────────────
// WebAuthn / passkey authentication — ratchet 45 scaffold.
// Unauthenticated entry points (the user is logging IN). The
// caller supplies a claimed userId; an unknown user still
// receives a structurally valid response (empty
// allowCredentials) to avoid enumeration. Verify increments the
// stored counter via User.webauthnCredentials JSON column.
// Issuing a JWT on success is intentionally OUT OF SCOPE for
// this scaffold — the caller composes it with the higher-level
// login flow once the operator has decided whether passkeys
// replace or augment passwords.
// ────────────────────────────────────────────────────────────
const webauthnSvc = require('../services/webauthn');

router.post('/webauthn/authentication-options', async (req, res) => {
  try {
    const userId = String((req.body && req.body.userId) || '').trim();
    let user = null;
    if (userId) {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, webauthnCredentials: true },
      });
    }
    const result = await webauthnSvc.generateAuthenticationOptions({ user: user || { id: userId || 'anon' } });
    if (!result.ok) return res.status(result.status || 500).json(result);
    return res.json({ ok: true, options: result.options });
  } catch (error) {
    console.error('WebAuthn authentication-options error:', error);
    return res.status(500).json({ error: 'webauthn_authentication_options_failed' });
  }
});

router.post('/webauthn/authentication-verify', async (req, res) => {
  try {
    const userId = String((req.body && req.body.userId) || '').trim();
    if (!userId) return res.status(400).json({ error: 'webauthn_missing_user' });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, webauthnCredentials: true },
    });
    if (!user) return res.status(400).json({ error: 'webauthn_credential_not_found' });
    const result = await webauthnSvc.verifyAuthentication({
      user,
      response: req.body && req.body.response,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    await prisma.user.update({
      where: { id: user.id },
      data: { webauthnCredentials: result.credentials },
      select: { id: true },
    });
    void writeAuditLog(prisma, {
      req,
      action: 'webauthn_authentication_verified',
      resource: 'user',
      resourceId: user.id,
      userId: user.id,
    });
    return res.json({
      ok: true,
      userId: result.userId,
      credentialId: result.credentialId,
    });
  } catch (error) {
    console.error('WebAuthn authentication-verify error:', error);
    return res.status(500).json({ error: 'webauthn_authentication_verify_failed' });
  }
});

module.exports = router;
