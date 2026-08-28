'use strict';

/**
 * Scoped viewer token for /ws/desktop/:sessionId (F7.2).
 *
 * Binds userId + chatId + sessionId. Never a model credential.
 * Kill-switch / missing secret fail closed — no anonymous desktop WS.
 *
 * jsonwebtoken is required only when minting/verifying so F7.1
 * provision tests that load session-manager do not need the module.
 */

const DESKTOP_WS_SCOPE = 'desktop:ws';
const DEFAULT_EXPIRES = '15m';

function loadJwt() {
  return require('jsonwebtoken');
}

function resolveSecret(env = process.env, explicit) {
  if (explicit) return String(explicit);
  return String((env && (env.DESKTOP_WS_SECRET || env.JWT_SECRET)) || '').trim();
}

function issueDesktopWsToken({ userId, chatId, sessionId }, opts = {}) {
  const secret = resolveSecret(opts.env || process.env, opts.secret);
  if (!secret) {
    const err = new Error('Falta secreto para el token del escritorio.');
    err.code = 'desktop_ws_secret_missing';
    err.status = 503;
    throw err;
  }
  const uid = String(userId || '').trim();
  const sid = String(sessionId || '').trim();
  if (!uid || !sid) {
    const err = new Error('El token del escritorio requiere userId y sessionId.');
    err.code = 'desktop_ws_token_invalid';
    err.status = 400;
    throw err;
  }
  return loadJwt().sign(
    {
      scope: DESKTOP_WS_SCOPE,
      typ: 'desktop-ws',
      userId: uid,
      chatId: String(chatId || '').trim() || null,
      sessionId: sid,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: opts.expiresIn || DEFAULT_EXPIRES,
    },
  );
}

function verifyDesktopWsToken(token, opts = {}) {
  const secret = resolveSecret(opts.env || process.env, opts.secret);
  const raw = String(token || '').trim();
  if (!secret || !raw) return null;
  try {
    const payload = loadJwt().verify(raw, secret, { algorithms: ['HS256'] });
    if (!payload || payload.scope !== DESKTOP_WS_SCOPE) return null;
    if (!payload.userId || !payload.sessionId) return null;
    return {
      userId: String(payload.userId),
      chatId: payload.chatId ? String(payload.chatId) : null,
      sessionId: String(payload.sessionId),
      scope: DESKTOP_WS_SCOPE,
    };
  } catch (_) {
    return null;
  }
}

function extractDesktopWsToken(request) {
  const rawUrl = String(request && request.url || '');
  let queryToken = '';
  try {
    const u = new URL(rawUrl, 'http://desktop.local');
    queryToken = String(u.searchParams.get('token') || '').trim();
  } catch (_) {
    queryToken = '';
  }
  if (queryToken) return queryToken;
  const auth = String((request && request.headers && (
    request.headers.authorization || request.headers.Authorization
  )) || '');
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  return m ? m[1] : '';
}

module.exports = {
  DESKTOP_WS_SCOPE,
  issueDesktopWsToken,
  verifyDesktopWsToken,
  extractDesktopWsToken,
  resolveSecret,
};
