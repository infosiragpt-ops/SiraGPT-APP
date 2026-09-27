'use strict';

/**
 * «Not configured» / «feature disabled» answers are a configuration state the
 * admin chose (no ElevenLabs key, Stripe billing off, a disabled module…),
 * not a platform failure. Observability sinks use this to keep them out of
 * «Fallos de respuesta», the audit log's user-facing errors and the error
 * sound. Mirrored in lib/api.ts (`isConfigStateFailure`) for the browser.
 */
const CONFIG_STATE_RE = /not[\s_-]?configured|no\s+est[aá]\s+configurad[oa]|sin\s+configurar|feature[\s_-]?(?:is[\s_-]?)?disabled|feature[\s_-]?not[\s_-]?enabled|service[\s_-]?disabled|provider_not_configured/i;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function isConfigStateMessage(...parts) {
  const text = parts.map(textOf).join(' ');
  return Boolean(text) && CONFIG_STATE_RE.test(text);
}

module.exports = { CONFIG_STATE_RE, isConfigStateMessage };
