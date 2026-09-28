'use strict';

/**
 * Complete an /api/ai/generate SSE response after a provider 4xx/5xx.
 * Caddy turns an unterminated event-stream (headers flushed, no [DONE]/end)
 * into HTTP 502. Always write a typed error frame + [DONE], then end().
 *
 * Three user-facing classes:
 *   1) Missing/broken first-party model pin → PROVIDER_UNAVAILABLE_MESSAGE
 *      (reconnect/settings; never silent vendor swap; never /conexiones).
 *   2) Missing GitHub OAuth for clone/PR → E_GITHUB_CONNECT + /conexiones.
 *   3) True transport dead → short «Conexión no disponible», but an
 *      actionable Spanish payload is allowed through.
 */

const {
  CONNECTION_UNAVAILABLE_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
} = require('./provider-inference');

let _githubConnectMessage;
function githubConnectMessage() {
  if (_githubConnectMessage) return _githubConnectMessage;
  try {
    _githubConnectMessage = require('../construir-mvp/github-publish').CONNECT_MESSAGE;
  } catch {
    _githubConnectMessage =
      'GitHub no está conectado. Ve a Conexiones (/conexiones) y conecta tu cuenta para crear el repositorio o empujar una rama. Sira no inventa tokens.';
  }
  return _githubConnectMessage;
}

const VENDOR_LEAK_RE = /deepseek|openrouter|sk-|Bearer\s|AKIA|BEGIN (RSA|OPENSSH|PRIVATE)/i;

const STREAM_TIMEOUT_MESSAGE =
  'El modelo cortó el stream después de pensar. Reintenta; no es un fallo de GitHub. Si el modelo no responde, elige otro.';
const PROVIDER_FAIL_MESSAGE =
  'El modelo no pudo completar la respuesta. Reintenta o elige otro modelo. No cambié de modelo.';
const SANDBOX_FAIL_MESSAGE =
  'El workspace aislado rechazó esa ruta o comando. Indica owner/repo otra vez o pide un archivo concreto.';
// A provider without credit, when the error carries no annotated model name.
// Same copy as billing-failover.buildFailureMessage({ reason: 'billing' }).
const PROVIDER_NO_CREDIT_MESSAGE =
  'El modelo elegido no pudo responder: su proveedor no tiene saldo ahora. No cambié de modelo; elige otro en el selector o inténtalo más tarde.';
// An agentic turn that ran out of time (step timeout past the plain-fallback
// budget, runtime budget exhausted). Never blames GitHub.
const AGENTIC_TIMEOUT_MESSAGE =
  'La respuesta tardó más de lo previsto y no pude terminarla. No cambié de modelo; reintenta o elige un modelo más rápido.';

let _billingFailover;
function billingFailover() {
  if (_billingFailover !== undefined) return _billingFailover;
  try {
    _billingFailover = require('./billing-failover');
  } catch {
    _billingFailover = null;
  }
  return _billingFailover;
}

/**
 * 'billing' when the error is an empty account (never a per-minute quota
 * window, a reservation larger than the balance or an auth rejection), else
 * null. Advisory: any failure → null.
 */
function billingCauseOf(err) {
  const bf = billingFailover();
  if (!bf || !err || typeof err !== 'object') return null;
  try {
    return bf.failureCauseFor(err) === 'billing' ? 'billing' : null;
  } catch {
    return null;
  }
}

/**
 * The transparent copy for an error annotated by
 * billing-failover.annotateProviderFailure: which model, which cause. null
 * when the error carries no cause (or the cause has no copy).
 */
function transparentFailureMessage(err) {
  if (!err || typeof err !== 'object' || !err.siraFailureReason) return null;
  const bf = billingFailover();
  if (!bf || typeof bf.buildFailureMessage !== 'function') return null;
  try {
    return bf.buildFailureMessage({
      modelLabel: err.siraModelLabel || '',
      reason: err.siraFailureReason,
      retryAfterSeconds: err.siraRetryAfterSeconds,
    });
  } catch {
    return null;
  }
}

/**
 * Public code + Spanish message for a failed /api/ai/generate turn. An error
 * annotated with its cause (siraFailureReason) gets the 100% transparent copy
 * (model + sin saldo / clave rechazada / no responde / límite por minuto);
 * an unannotated «no credit» error gets the «sin saldo» copy. The code stays
 * the classified one (E_PROVIDER for billing). Never the provider's raw text.
 */
function classifyGenerateError(err) {
  const base = classifyGenerateErrorCore(err);
  const transparent = transparentFailureMessage(err);
  if (transparent && base.code !== 'E_GITHUB_CONNECT' && base.code !== 'E_SANDBOX') {
    return {
      code: base.code === 'connection_unavailable' ? 'E_PROVIDER' : base.code,
      message: transparent,
    };
  }
  return base;
}

function classifyGenerateErrorCore(err) {
  const code = String((err && (err.code || err.error || err.stoppedReason || err.name)) || '').trim();
  const raw = String((err && (err.message || err.error || err.code || err.name)) || '').trim();
  const blob = `${code} ${raw}`;

  if (!raw && !code) {
    return { code: 'connection_unavailable', message: CONNECTION_UNAVAILABLE_MESSAGE };
  }
  if (
    /E_GITHUB_CONNECT|github_not_connected|github_token_invalid/i.test(blob)
    || (/\/conexiones/i.test(raw) && /github/i.test(raw))
  ) {
    return { code: 'E_GITHUB_CONNECT', message: githubConnectMessage() };
  }
  // «Sin saldo» before the vendor-leak check: an OpenRouter/DeepSeek credit
  // error names the vendor, but the user must read the real cause (in our
  // words, never the provider's text). Our own missing-connection codes keep
  // their copy.
  if (
    !/^(provider_unavailable|PROVIDER_CONNECTION_UNAVAILABLE|connection_unavailable)$/i.test(code)
    && billingCauseOf(err) === 'billing'
  ) {
    return { code: 'E_PROVIDER', message: PROVIDER_NO_CREDIT_MESSAGE };
  }
  if (VENDOR_LEAK_RE.test(raw)) {
    return { code: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_MESSAGE };
  }
  if (/unknown parameter/i.test(blob)) {
    return { code: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_MESSAGE };
  }
  if (
    /^(provider_unavailable|PROVIDER_CONNECTION_UNAVAILABLE)$/i.test(code)
    || raw === PROVIDER_UNAVAILABLE_MESSAGE
  ) {
    return { code: 'provider_unavailable', message: PROVIDER_UNAVAILABLE_MESSAGE };
  }
  if (/^connection_unavailable$/i.test(code) || raw === CONNECTION_UNAVAILABLE_MESSAGE) {
    return { code: 'connection_unavailable', message: CONNECTION_UNAVAILABLE_MESSAGE };
  }

  if (
    /E_TIMEOUT|ETIMEDOUT|timed?\s*out|first-byte timeout|stream (ended|stalled|connect)|runtime_budget_exhausted|AbortError|\baborted\b/i.test(blob)
    || /tard[oó] demasiado|cort[oó] el stream/i.test(raw)
  ) {
    return { code: 'E_TIMEOUT', message: STREAM_TIMEOUT_MESSAGE };
  }

  if (/E_PATH_ESCAPE|E_SANDBOX|\bjail\b|\bsandbox\b/i.test(blob)) {
    return { code: 'E_SANDBOX', message: raw && /[áéíóúñ¿¡]/i.test(raw) && raw.length < 240 ? raw : SANDBOX_FAIL_MESSAGE };
  }

  if (/\bE_PROVIDER\b|model_error|tool_error|EMPTY_COMPLETION|AI generation failed/i.test(blob)) {
    if (raw && raw.length < 240 && !/^https?:/i.test(raw) && /[áéíóúñ¿¡]/i.test(raw) && !/conexión no disponible/i.test(raw)) {
      return { code: 'E_PROVIDER', message: raw };
    }
    return { code: 'E_PROVIDER', message: PROVIDER_FAIL_MESSAGE };
  }

  if (raw.length < 200 && !/^https?:/i.test(raw) && /[áéíóúñ¿¡]/i.test(raw) && !/conexión no disponible/i.test(raw)) {
    return { code: code || 'E_PROVIDER', message: raw };
  }

  return { code: 'E_PROVIDER', message: PROVIDER_FAIL_MESSAGE };
}

function publicGenerateErrorMessage(err) {
  return classifyGenerateError(err).message;
}

function isProviderClientError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  if (Number.isFinite(status) && status >= 400) return true;
  const msg = String(err.message || err.error || '');
  return /unknown parameter|invalid_request|invalid parameter/i.test(msg);
}

function rawWrite(res, frame) {
  if (!res) return false;
  const write = typeof res._siraRawWrite === 'function' ? res._siraRawWrite : res.write;
  if (typeof write !== 'function') return false;
  try {
    write.call(res, frame);
    return true;
  } catch {
    return false;
  }
}

function writeGenerateSseError(res, {
  message,
  code = 'connection_unavailable',
  recovered = false,
  retryable = undefined,
  retryAfterSeconds = undefined,
  failureReason = undefined,
} = {}) {
  const text = String(message || CONNECTION_UNAVAILABLE_MESSAGE).trim() || CONNECTION_UNAVAILABLE_MESSAGE;
  const payload = {
    type: 'error',
    error: text,
    code,
    message: text,
    recovered: recovered === true,
  };
  // Optional, only when the caller knows them: `retryable:false` when a
  // retry cannot help (no balance, rejected key…), the per-minute wait the
  // copy announced, and the cause (never the provider's text).
  if (typeof retryable === 'boolean') payload.retryable = retryable;
  const wait = Number(retryAfterSeconds);
  if (Number.isFinite(wait) && wait > 0) payload.retryAfterSeconds = Math.ceil(wait);
  if (typeof failureReason === 'string' && failureReason) payload.failureReason = failureReason;
  rawWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
  if (!recovered) {
    rawWrite(res, `data: ${JSON.stringify({ type: 'text_delta', content: text })}\n\n`);
  }
  rawWrite(res, 'data: [DONE]\n\n');
  return payload;
}

function endGenerateSse(res) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const end = typeof res._siraRawEnd === 'function' ? res._siraRawEnd : res.end;
  if (typeof end !== 'function') return false;
  try {
    end.call(res);
    return true;
  } catch {
    return false;
  }
}

function closeGenerateSseWithError(res, opts) {
  const payload = writeGenerateSseError(res, opts);
  endGenerateSse(res);
  if (res && typeof res === 'object') res._siraGenerateSseClosed = true;
  return payload;
}

module.exports = {
  CONNECTION_UNAVAILABLE_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
  STREAM_TIMEOUT_MESSAGE,
  PROVIDER_FAIL_MESSAGE,
  SANDBOX_FAIL_MESSAGE,
  PROVIDER_NO_CREDIT_MESSAGE,
  AGENTIC_TIMEOUT_MESSAGE,
  classifyGenerateError,
  publicGenerateErrorMessage,
  isProviderClientError,
  writeGenerateSseError,
  endGenerateSse,
  closeGenerateSseWithError,
};
