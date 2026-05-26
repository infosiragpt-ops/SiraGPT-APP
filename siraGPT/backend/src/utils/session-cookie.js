'use strict';

const SESSION_COOKIE_NAME = 'token';
const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_SAME_SITE = new Set(['lax', 'strict', 'none']);

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeSameSite(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_SAME_SITE.has(raw) ? raw : 'lax';
}

function getSessionCookieOptions(env = process.env) {
  const crossSite = envFlag(env.CROSS_ORIGIN_AUTH_COOKIES) || envFlag(env.SESSION_COOKIE_SAMESITE_NONE);
  const sameSite = crossSite ? 'none' : normalizeSameSite(env.SESSION_COOKIE_SAME_SITE);
  const secure = env.NODE_ENV === 'production' || crossSite || envFlag(env.SESSION_COOKIE_SECURE);
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  };
}

function getClearSessionCookieOptions(env = process.env) {
  const { maxAge: _maxAge, ...opts } = getSessionCookieOptions(env);
  return opts;
}

function setSessionCookie(res, token, env = process.env) {
  return res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(env));
}

function clearSessionCookie(res, env = process.env) {
  return res.clearCookie(SESSION_COOKIE_NAME, getClearSessionCookieOptions(env));
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_MS,
  getSessionCookieOptions,
  getClearSessionCookieOptions,
  setSessionCookie,
  clearSessionCookie,
};
