'use strict';

const crypto = require('node:crypto');
const { cleanChatId, requireOwnedChat } = require('../codex/project-chat-binding');
const { createOAuthStateStore } = require('../auth/oauth-state-store');

const HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidContext() {
  return Object.assign(new Error('La conexión de GitHub requiere un chat y una solicitud válidos.'), {
    code: 'github_handoff_invalid', status: 400,
  });
}

/** Only the validated chat binding is stored privately with the one-use state.
 * A redirect URL, user identity or provider URL can never come from the caller.
 */
async function contextForRequest(query, userId, db) {
  if (query.chatId == null && query.handoffId == null && query.popup == null) return null;
  if (typeof query.chatId !== 'string' || !cleanChatId(query.chatId)
    || typeof query.handoffId !== 'string' || !HANDOFF_ID.test(query.handoffId)
    || query.popup !== '1') throw invalidContext();
  const chatId = await requireOwnedChat({ userId, chatId: query.chatId, db });
  return { chatId, handoffId: query.handoffId, popup: true };
}

function validContext(context) {
  return context && context.popup === true
    && typeof context.chatId === 'string' && cleanChatId(context.chatId) === context.chatId
    && typeof context.handoffId === 'string' && HANDOFF_ID.test(context.handoffId);
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Provider callback page, never an auth token transport. Polling verified
 * status remains necessary when COOP or the provider severs window.opener.
 */
function sendChatResult(res, context, result, frontendBase) {
  if (!validContext(context)) return false;
  const origin = new URL(frontendBase).origin;
  const success = result === 'connected';
  const payload = {
    type: 'github_oauth_result', service: 'github',
    status: success ? 'success' : 'error',
    chatId: context.chatId, handoffId: context.handoffId,
    ...(!success ? { error: ['denied', 'already_linked', 'chat_unavailable'].includes(result) ? result : 'error' } : {}),
  };
  const returnUrl = new URL('/agentes', origin);
  returnUrl.searchParams.set('id', context.chatId);
  const nonce = crypto.randomBytes(24).toString('base64');
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Conexión de GitHub</title></head><body><p>${success ? 'GitHub conectado. Puedes volver al chat; tu autorización quedó guardada.' : 'No se completó la conexión de GitHub. Vuelve al chat para reintentar.'}</p><a href="${escapeHtml(returnUrl.toString())}">Volver al chat</a><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${scriptJson(payload)},${scriptJson(origin)});window.close();}</script></body></html>`);
  return true;
}

const RECEIPT_TTL_MS = 10 * 60 * 1000;
let receipts;
function receiptStore() {
  if (!receipts) receipts = createOAuthStateStore({
    env: { ...process.env, OAUTH_STATE_REDIS_PREFIX: `${process.env.OAUTH_STATE_REDIS_PREFIX || 'sira:oauth-state:'}github-handoff:` },
  });
  return receipts;
}
function receiptKey(userId, context, kind) {
  return crypto.createHash('sha256').update(JSON.stringify([kind, userId, context.chatId, context.handoffId])).digest('hex');
}
async function reserveHandoff(userId, context) {
  if (!validContext(context)) return;
  const accepted = await receiptStore().issue(receiptKey(userId, context, 'start'), '1', RECEIPT_TTL_MS);
  if (!accepted) throw Object.assign(new Error('Esta solicitud de conexión ya se inició. Inicia una nueva.'), { status: 409, code: 'github_handoff_reused' });
}
async function recordHandoff(userId, context, result, connectionVersion) {
  if (!validContext(context)) return;
  const payload = {
    chatId: context.chatId, handoffId: context.handoffId,
    status: result === 'connected' ? 'success' : 'error',
    ...(result === 'connected' ? { connectionVersion: connectionVersion || null } : { error: ['denied', 'already_linked', 'chat_unavailable'].includes(result) ? result : 'error' }),
  };
  const saved = await receiptStore().issue(receiptKey(userId, context, 'result'), JSON.stringify(payload), RECEIPT_TTL_MS);
  if (!saved) throw Object.assign(new Error('No se pudo confirmar esta conexión.'), { code: 'github_handoff_reused' });
}
async function readHandoff(userId, context) {
  const raw = await receiptStore().peek(receiptKey(userId, context, 'result'));
  if (!raw) return { status: 'pending', chatId: context.chatId, handoffId: context.handoffId };
  const value = JSON.parse(raw);
  if (value.chatId !== context.chatId || value.handoffId !== context.handoffId || !['success', 'error'].includes(value.status)) throw invalidContext();
  return value;
}
async function closeReceiptStore() {
  if (receipts) await receipts.close();
  receipts = undefined;
}

/** Verify saved authorization without deleting an account: deleting it would
 * cascade to the user's repositories. Transient failures are not revocation.
 */
async function verifyAccount(account, oauth) {
  if (!account) return { connected: false, verified: false };
  let tokens;
  try { tokens = oauth.openTokens(account.encryptedTokens); } catch { /* corrupt sealed token */ }
  if (!tokens?.accessToken) return { connected: false, verified: false, reconnectRequired: true, code: 'github_token_invalid' };
  try {
    const user = await oauth.fetchGithubUser(tokens.accessToken, { signal: AbortSignal.timeout(10_000) });
    if (!user?.id || String(user.id) !== String(account.githubUserId)) {
      return { connected: false, verified: false, reconnectRequired: true, code: 'github_identity_mismatch' };
    }
    return { connected: true, verified: true };
  } catch (error) {
    if (Number(error?.status) === 401) return { connected: false, verified: false, reconnectRequired: true, code: 'github_token_invalid' };
    throw Object.assign(new Error('No se pudo comprobar la conexión de GitHub. Reintenta en unos segundos.'), {
      status: 503, code: 'github_verification_unavailable',
    });
  }
}

module.exports = { contextForRequest, validContext, sendChatResult, verifyAccount, reserveHandoff, recordHandoff, readHandoff, closeReceiptStore };
