'use strict';

const jwt = require('jsonwebtoken');
const {
  SESSION_TOKEN_SCOPE_APPSHOTS,
  parseSessionTokenHash,
} = require('../services/auth/session-token-persistence');

const APPSHOTS_USER_AGENT_FALLBACK = 'SiraGPT Appshots';
const APPSHOTS_USER_AGENT_MAX_CHARS = 512;
const APPSHOTS_USER_AGENT_MARKER = 'SiraGPT-Appshots/1 ';

/**
 * Session.userAgent is the existing no-schema discriminator for Appshots
 * sessions. General login/SSO sessions leave it null; pairing always stores a
 * bounded non-empty value, even when the extension sends no User-Agent.
 */
function markAppshotsUserAgent(userAgent) {
  const normalized = typeof userAgent === 'string' ? userAgent.trim() : '';
  const visible = normalized || APPSHOTS_USER_AGENT_FALLBACK;
  return `${APPSHOTS_USER_AGENT_MARKER}${visible.slice(
    0,
    APPSHOTS_USER_AGENT_MAX_CHARS - APPSHOTS_USER_AGENT_MARKER.length,
  )}`;
}

function visibleAppshotsUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return null;
  return userAgent.startsWith(APPSHOTS_USER_AGENT_MARKER)
    ? userAgent.slice(APPSHOTS_USER_AGENT_MARKER.length)
    : userAgent;
}

/**
 * Returns true when `token` is a valid JWT signed with our JWT_SECRET and
 * carries the `appshots:capture` scope claim — i.e. it was minted by
 * POST /api/appshots/pair and stored in the Session table as a long-lived
 * Chrome-extension bearer.
 *
 * Used by background jobs and admin/cascade revocation paths that need to
 * tell Appshots sessions apart from ordinary web-login sessions so the
 * owner gets notified by email when one is auto-revoked. The check is
 * fail-closed: anything that can't be verified is treated as "not an
 * Appshots token" so we never email on a non-Appshots session.
 *
 * Mirrors the helper duplicated in backend/src/routes/appshots.js — kept
 * in its own file so sweep jobs don't have to pull the whole routes
 * module (multer, fs, ai-service, ...) just to classify a token.
 */
function isAppshotsToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    return decoded && typeof decoded === 'object' && decoded.scope === 'appshots:capture';
  } catch (_) {
    return false;
  }
}

/**
 * Classify a persisted Session row after Session.token became a one-way hash.
 * The token decoder remains only for pre-rollout plaintext rows.
 */
function isAppshotsSession(session) {
  if (!session || typeof session !== 'object') return false;
  const storedHash = parseSessionTokenHash(session.token);
  if (storedHash) return storedHash.scope === SESSION_TOKEN_SCOPE_APPSHOTS;
  return isAppshotsToken(session.token);
}

module.exports = {
  APPSHOTS_USER_AGENT_FALLBACK,
  APPSHOTS_USER_AGENT_MARKER,
  isAppshotsSession,
  isAppshotsToken,
  markAppshotsUserAgent,
  visibleAppshotsUserAgent,
};
