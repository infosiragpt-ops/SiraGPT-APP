'use strict';

const jwt = require('jsonwebtoken');

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded && typeof decoded === 'object' && decoded.scope === 'appshots:capture';
  } catch (_) {
    return false;
  }
}

module.exports = { isAppshotsToken };
