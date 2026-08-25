'use strict';

const ISOLATION_REFUSED_ES =
  'No se pudo aislar la computadora de esta conversación.';
const OPEN_FAILED_ES = 'No se pudo abrir la computadora de esta conversación.';

function looksLikeSecretOrStack(text) {
  const raw = String(text || '');
  if (!raw) return false;
  if (/sk-[A-Za-z0-9_-]{8,}/i.test(raw)) return true;
  if (/\bat\s+\S+\s+\(/i.test(raw)) return true;
  if (/node_modules|Error:\s+\S+/.test(raw) && raw.includes('\n')) return true;
  return false;
}

function publicComputerError(err, fallback = OPEN_FAILED_ES) {
  const raw = String((err && (err.publicMessage || err.message)) || '');
  if (looksLikeSecretOrStack(raw)) return fallback;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 180);
}

function isolationError() {
  const err = new Error(ISOLATION_REFUSED_ES);
  err.status = 409;
  err.code = 'isolation_required';
  err.publicMessage = ISOLATION_REFUSED_ES;
  return err;
}

function sessionMatchesConversation(session, identity) {
  if (!identity || !identity.conversationBound) return true;
  const orchUser = String((session && session.userId) || '');
  return Boolean(orchUser) && orchUser === String(identity.userId);
}

module.exports = {
  ISOLATION_REFUSED_ES,
  OPEN_FAILED_ES,
  looksLikeSecretOrStack,
  publicComputerError,
  isolationError,
  sessionMatchesConversation,
};
