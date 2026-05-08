const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
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

const router = express.Router();
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
  return res.status(503).json({
    error: 'Google OAuth is not configured for this environment'
  });
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
      // Create session token
      const token = jwt.sign(
        { userId: req.user.id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

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
router.post('/register', [
  body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password } = req.body;

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

    // Create session
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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

    res.status(201).json({
      user: userWithoutPassword,
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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

    const serializedUser = serializeUser(userWithoutPassword);
    res.json({
      user: serializedUser,
      token
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
    res.json({ user: serializedUser });
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
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // Create new token
    const newToken = jwt.sign(
      { userId: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Update session
    await prisma.session.update({
      where: { token: req.token },
      data: {
        token: newToken,
        expiresAt
      }
    });

    res.cookie('token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ token: newToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Super Admin Impersonation - Allow super admin to access any user account
router.post('/impersonate/:userId', authenticateToken, async (req, res) => {
  try {
    // Check if current user is super admin
    if (!req.user.isSuperAdmin) {
      return res.status(403).json({ error: 'Super admin access required' });
    }

    const { userId } = req.params;

    // Find target user
    const targetUser = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Don't allow impersonating other super admins
    if (targetUser.isSuperAdmin) {
      return res.status(403).json({ error: 'Cannot impersonate other super admins' });
    }

    // Create impersonation token
    const impersonationToken = jwt.sign(
      { 
        userId: targetUser.id,
        impersonatedBy: req.user.id,
        isImpersonation: true
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' } // Shorter expiry for impersonation
    );

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create impersonation session
    await prisma.session.create({
      data: {
        userId: targetUser.id,
        token: impersonationToken,
        expiresAt
      }
    });

    console.log(`Super admin ${req.user.email} impersonating user ${targetUser.email}`);

    res.json({
      token: impersonationToken,
      user: serializeUser(targetUser),
      impersonatedBy: req.user.id
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
    const newToken = jwt.sign(
      { userId: superAdmin.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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

module.exports = router;
