const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const prisma = require('./database');
const bcrypt = require('bcryptjs');
const { withAccelerateRetry, isAccelerateTransientError } = require('../utils/prisma-accelerate-retry');
const {
  stripTrailingSlash,
  getGoogleCallbackURL,
} = require('./oauth-url-policy');

const isGoogleOAuthConfigured = () => Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  getGoogleCallbackURL()
);

const googleCallbackURL = getGoogleCallbackURL();
const googleOAuthConfigured = isGoogleOAuthConfigured();
const configuredGoogleCallback = stripTrailingSlash(process.env.GOOGLE_AUTH_URI);

if (configuredGoogleCallback && configuredGoogleCallback !== googleCallbackURL) {
  console.warn(`Google OAuth callback override ignored; using ${googleCallbackURL}`);
}

// Google OAuth Strategy — login-only scopes (profile + email). These are
// NON-sensitive scopes that do not trigger Google's "unverified app"
// warning screen, so siragpt.com works for every user without
// individual test-user whitelisting or full verification review.
// Gmail / Calendar / Drive scopes are requested separately in their
// own opt-in flows (/api/auth/gmail, /api/auth/google-services) so the
// warning only ever appears for users who explicitly enable those
// integrations, never on the main login.
if (googleOAuthConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: googleCallbackURL,
    scope: ['profile', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('Google OAuth callback - accessToken:', !!accessToken);
    console.log('Google OAuth callback - refreshToken:', !!refreshToken);
    console.log('Google OAuth callback - profile scopes:', profile._json?.scope);

    if (!refreshToken) {
      console.error('❌ No refresh token received! User may need to revoke app access and re-authenticate.');
      console.error('📋 To get refresh token: Go to https://myaccount.google.com/permissions, revoke access to your app, then re-authenticate.');

      // Check if user already has a refresh token stored
      const existingUser = await withAccelerateRetry(
        () => prisma.user.findUnique({
          where: { email: profile.emails[0].value },
          select: { id: true, gmailTokens: true }
        }),
        { label: 'google-oauth.lookup-existing' }
      );

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
            await withAccelerateRetry(
              () => prisma.user.update({
                where: { id: existingUser.id },
                data: { gmailTokens: null }
              }),
              { label: 'google-oauth.clear-corrupted' }
            );
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
    let user = await withAccelerateRetry(
      () => prisma.user.findUnique({
        where: { email: profile.emails[0].value }
      }),
      { label: 'google-oauth.find-user' }
    );

    if (user) {
      // Update user with Google ID and tokens
      user = await withAccelerateRetry(
        () => prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: profile.id,
            gmailTokens: encrypt(gmailTokens),
            googleServicesTokens: encrypt(googleServicesTokens)
          }
        }),
        { label: 'google-oauth.update-user' }
      );
      return done(null, user);
    }

    // Create new user with all tokens
    const generatedPasswordHash = await bcrypt.hash(Math.random().toString(36), 12);
    const newUser = await withAccelerateRetry(
      () => prisma.user.create({
      data: {
        googleId: profile.id,
        name: profile.displayName,
        email: profile.emails[0].value,
        avatar: profile.photos[0]?.value,
        password: generatedPasswordHash,
        plan: 'FREE',
        isAdmin: false,
        apiUsage: 0,
        monthlyCallLimit: 3,
        monthlyLimit: 10000,
        gmailTokens: encrypt(gmailTokens),
        googleServicesTokens: encrypt(googleServicesTokens)
      }
      }),
      { label: 'google-oauth.create-user' }
    );

    return done(null, newUser);
  } catch (error) {
    console.error('Google OAuth error:', error);
    // When the underlying failure is a transient Accelerate outage
    // (P6008 etc.), signal a soft auth-failure with a tagged reason so
    // the route handler can redirect the user to the login page with a
    // friendly Spanish message instead of bubbling a 500. Real bugs
    // still propagate so we don't mask code errors.
    if (isAccelerateTransientError(error)) {
      return done(null, false, { message: 'database_unavailable' });
    }
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
    const user = await withAccelerateRetry(
      () => prisma.user.findUnique({ where: { id: payload.userId } }),
      { label: 'jwt-strategy.find-user' }
    );

    if (user) {
      return done(null, user);
    }
    return done(null, false);
  } catch (error) {
    if (isAccelerateTransientError(error)) {
      // Soft-fail JWT auth on database hiccups instead of returning a
      // hard 500; the client will see 401 and can retry the request.
      return done(null, false);
    }
    return done(error, false);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await withAccelerateRetry(
      () => prisma.user.findUnique({ where: { id } }),
      { label: 'passport.deserialize' }
    );
    done(null, user);
  } catch (error) {
    if (isAccelerateTransientError(error)) {
      // Treat as "no user" so the request continues unauthenticated
      // instead of crashing the session middleware.
      return done(null, null);
    }
    done(error, null);
  }
});

passport.isGoogleOAuthConfigured = isGoogleOAuthConfigured;
passport.getGoogleCallbackURL = getGoogleCallbackURL;

module.exports = passport;
