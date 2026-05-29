'use strict';

/**
 * passport.js — thin adapter that wires the Google + JWT strategies
 * to the SOLID-split services. All business rules live in
 * `services/GoogleAuthService`, all data access lives in
 * `repositories/UserRepository`, all encryption lives in
 * `services/TokenVault`. This file's only job is to translate between
 * passport's done() callback contract and those services.
 */

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const bcrypt = require('bcryptjs');

const prisma = require('./database');
const { encrypt, decrypt } = require('../utils/encryption');
const {
  withAccelerateRetry,
  isAccelerateTransientError,
} = require('../utils/prisma-accelerate-retry');
const { UserRepository } = require('../repositories/UserRepository');
const { TokenVault } = require('../services/TokenVault');
const { GoogleAuthService } = require('../services/GoogleAuthService');
const {
  stripTrailingSlash,
  getGoogleCallbackURL,
} = require('./oauth-url-policy');

// ── Composition root ──────────────────────────────────────────────
// Wire concrete deps once at module load. Test code can rebuild
// these from their constructors with mocks; the production wiring is
// kept simple and explicit so missing dependencies fail loudly here.
const users = new UserRepository({ prisma, withRetry: withAccelerateRetry });
const tokenVault = new TokenVault({ encrypt, decrypt });
const googleAuth = new GoogleAuthService({ users, tokens: tokenVault, bcrypt });

const isGoogleOAuthConfigured = () => Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  getGoogleCallbackURL()
);

const googleCallbackURL = getGoogleCallbackURL();
const googleOAuthConfigured = isGoogleOAuthConfigured();
const configuredGoogleCallback = stripTrailingSlash(process.env.GOOGLE_AUTH_URI);

if (configuredGoogleCallback && configuredGoogleCallback !== googleCallbackURL) {
  console.info(`Google OAuth callback override ignored; using ${googleCallbackURL}`);
}

// Google OAuth Strategy — login-only scopes (profile + email). These
// are NON-sensitive scopes that do not trigger Google's "unverified
// app" warning screen. Gmail / Calendar / Drive scopes are requested
// separately in their own opt-in flows so the warning only ever
// appears for users who explicitly enable those integrations.
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

      const result = await googleAuth.handleVerify({ accessToken, refreshToken, profile });
      return done(null, result.user);
    } catch (error) {
      console.error('Google OAuth error:', error);
      // Transient DB outage (Accelerate P6008 etc.) becomes a soft
      // failure so the route handler can redirect with a friendly
      // Spanish message instead of a 500. Real bugs still propagate.
      if (isAccelerateTransientError(error)) {
        return done(null, false, { message: 'database_unavailable' });
      }
      return done(error, null);
    }
  }));
} else {
  console.warn('Google OAuth disabled: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or callback URL is missing');
}

// JWT Strategy — also routed through the repository so it benefits
// from the Accelerate retry policy automatically.
passport.use(new JwtStrategy({
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
}, async (payload, done) => {
  try {
    const user = await users.findById(payload.userId);
    if (user) return done(null, user);
    return done(null, false);
  } catch (error) {
    if (isAccelerateTransientError(error)) {
      // Soft-fail JWT auth on DB hiccups (client sees 401, can retry)
      // instead of returning a hard 500.
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
    const user = await users.findById(id);
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

// Exposed for tests + callers (routes/auth.js Google callback uses
// the SessionRepository directly with the same retry helper).
passport._composition = { users, tokenVault, googleAuth };

module.exports = passport;
