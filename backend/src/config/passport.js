const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const prisma = require('./database');
const bcrypt = require('bcryptjs');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const isProduction = () => process.env.NODE_ENV === 'production';

const isLocalhostUrl = (value) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return /(^|\/\/)(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(String(value));
  }
};

const inferBackendUrlFromFrontend = () => {
  try {
    const frontendUrl = new URL(process.env.FRONTEND_URL || '');
    if (frontendUrl.hostname === 'siragpt.com' || frontendUrl.hostname === 'www.siragpt.com') {
      return 'https://api.siragpt.com';
    }
  } catch {
    return '';
  }
  return '';
};

const resolvePublicBackendUrl = () => {
  const candidates = [
    process.env.GOOGLE_AUTH_BASE_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.API_PUBLIC_URL,
    process.env.PUBLIC_API_URL,
    process.env.BASE_URL,
    process.env.APP_URL
  ];

  for (const candidate of candidates) {
    const normalized = stripTrailingSlash(candidate);
    if (!normalized) continue;
    if (isProduction() && isLocalhostUrl(normalized)) continue;
    return normalized;
  }

  const inferred = inferBackendUrlFromFrontend();
  if (inferred) return inferred;
  return isProduction() ? 'https://api.siragpt.com' : 'http://localhost:5000';
};

const getGoogleCallbackURL = () => {
  const configuredCallback = stripTrailingSlash(process.env.GOOGLE_AUTH_URI);
  if (configuredCallback && !(isProduction() && isLocalhostUrl(configuredCallback))) {
    return configuredCallback;
  }
  return `${resolvePublicBackendUrl()}/api/auth/google/callback`;
};

const isGoogleOAuthConfigured = () => Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  getGoogleCallbackURL()
);

const googleCallbackURL = getGoogleCallbackURL();
const googleOAuthConfigured = isGoogleOAuthConfigured();

// Google OAuth Strategy with extended scopes. Keep email/password auth available
// when Google OAuth is not configured on a given environment.
if (googleOAuthConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: googleCallbackURL,
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ],
    accessType: 'offline',  // Important: Get refresh token
    prompt: 'consent'        // Force consent screen to get refresh token
  }, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('Google OAuth callback - accessToken:', !!accessToken);
    console.log('Google OAuth callback - refreshToken:', !!refreshToken);
    console.log('Google OAuth callback - profile scopes:', profile._json?.scope);

    if (!refreshToken) {
      console.error('❌ No refresh token received! User may need to revoke app access and re-authenticate.');
      console.error('📋 To get refresh token: Go to https://myaccount.google.com/permissions, revoke access to your app, then re-authenticate.');

      // Check if user already has a refresh token stored
      const existingUser = await prisma.user.findUnique({
        where: { email: profile.emails[0].value },
        select: { gmailTokens: true }
      });

      if (existingUser?.gmailTokens) {
        const { decrypt } = require('../utils/encryption');
        try {
          const existingTokens = JSON.parse(decrypt(existingUser.gmailTokens));
          if (existingTokens.refreshToken) {
            console.log('✅ Using existing refresh token from database');
            refreshToken = existingTokens.refreshToken;
          }
        } catch (error) {
          console.error('Error decrypting existing tokens (tokens may be corrupted):', error.message);
          console.log('🔄 Will proceed without existing refresh token - user may need to complete full re-auth');
          // Clear corrupted tokens
          try {
            await prisma.user.update({
              where: { id: existingUser.id },
              data: { gmailTokens: null }
            });
            console.log('🧹 Cleared corrupted Gmail tokens');
          } catch (clearError) {
            console.error('Error clearing corrupted tokens:', clearError);
          }
        }
      }
    }

    // Encrypt tokens (you should use a proper encryption library)
    const { encrypt } = require('../utils/encryption'); // Create this utility

    // Store full scope information from Google
    const fullScopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify'
    ].join(' ');

    const gmailTokens = JSON.stringify({
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      scope: fullScopes,
      expiresAt: Date.now() + 3600000 // 1 hour (Google's default)
    });

    const googleServicesScopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ].join(' ');

    const googleServicesTokens = JSON.stringify({
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      scope: googleServicesScopes,
      expiresAt: Date.now() + 3600000 // 1 hour (Google's default)
    });

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { email: profile.emails[0].value }
    });

    if (user) {
      // Update user with Google ID and tokens
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: profile.id,
          gmailTokens: encrypt(gmailTokens),
          googleServicesTokens: encrypt(googleServicesTokens)
        }
      });
      return done(null, user);
    }

    // Create new user with all tokens
    const newUser = await prisma.user.create({
      data: {
        googleId: profile.id,
        name: profile.displayName,
        email: profile.emails[0].value,
        avatar: profile.photos[0]?.value,
        password: await bcrypt.hash(Math.random().toString(36), 12),
        plan: 'FREE',
        isAdmin: false,
        apiUsage: 0,
        monthlyCallLimit: 3,
        monthlyLimit: 10000,
        gmailTokens: encrypt(gmailTokens),
        googleServicesTokens: encrypt(googleServicesTokens)
      }
    });

    return done(null, newUser);
  } catch (error) {
    console.error('Google OAuth error:', error);
    return done(error, null);
  }
  }));
} else {
  console.warn('Google OAuth disabled: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or callback URL is missing');
}

// ... rest of your passport config

// JWT Strategy
passport.use(new JwtStrategy({
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET
}, async (payload, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId }
    });

    if (user) {
      return done(null, user);
    }
    return done(null, false);
  } catch (error) {
    return done(error, false);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id }
    });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

passport.isGoogleOAuthConfigured = isGoogleOAuthConfigured;
passport.getGoogleCallbackURL = getGoogleCallbackURL;

module.exports = passport;
