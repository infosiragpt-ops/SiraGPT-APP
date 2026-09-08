'use strict';

/**
 * Honest channel delivery receipts for the OpenClaw-adapter path.
 *
 * Inspired by OpenClaw's receive/send lifecycle (accepted intent ≠ platform
 * receipt). Native SiraGPT rewrite: no OpenClaw runtime, no vendor dump.
 *
 * Invariants:
 *   delivered === true  ⇒  accepted === true && status === 'delivered'
 *   status === 'delivered'  ⇔  delivered === true
 *   accepted can be true while delivered is false (queued / stored, not sent)
 *   endpoint or API-key presence is NEVER Conectada / delivered / ok
 */

const { redactString, redactErrorMessage } = require('../../utils/secret-redactor');

const DELIVERY_STATUSES = Object.freeze({
  REJECTED: 'rejected',
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered',
  FAILED: 'failed',
});

const DELIVERY_ERRORS_ES = Object.freeze({
  openclaw_disabled: 'El puente de canales está desactivado.',
  missing_api_key: 'Falta la clave de API del puente de canales.',
  channel_not_allowed: 'El canal no está permitido.',
  empty_message: 'El mensaje está vacío.',
  missing_destination: 'Falta el destino del canal (chatId o userId).',
  transport_missing: 'El mensaje se aceptó pero no hay transporte para enviarlo.',
  transport_failed: 'El canal rechazó el envío.',
  transport_timeout: 'El envío al canal agotó el tiempo de espera.',
  transport_unreachable: 'No se pudo alcanzar el canal.',
  not_confirmed: 'El canal respondió sin confirmar el envío.',
  cron_dispatch_failed: 'El turno cron falló antes de enviarse al canal.',
  cron_not_delivered: 'El turno cron se aceptó pero no se envió al canal.',
  hermes_gateway_disabled: 'El puente Hermes está desactivado.',
  inbound_only: 'El mensaje de entrada se aceptó; no es un envío al canal.',
  secret_rejected: 'El payload no puede incluir secretos.',
});

const PREVIEW_MAX = 160;
const SECRETISH = /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|xox[baprs]-|BEGIN (?:RSA|OPENSSH|PRIVATE)|AKIA[0-9A-Z]{8,}/i;

function spanishError(code, fallback) {
  const key = typeof code === 'string' && DELIVERY_ERRORS_ES[code] ? code : null;
  const message = key ? DELIVERY_ERRORS_ES[key] : (fallback || DELIVERY_ERRORS_ES.transport_failed);
  return {
    code: key || (typeof code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : 'transport_failed'),
    message: redactString(message),
  };
}

function previewText(text) {
  const raw = redactString(String(text || '').trim());
  if (!raw) return '';
  return raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw;
}

function payloadLooksSecret(value) {
  if (value == null) return false;
  try {
    return SECRETISH.test(String(value));
  } catch {
    return true;
  }
}

function normalizeTransportResult(raw) {
  if (raw == null) return { confirmed: false, code: 'not_confirmed' };
  if (raw === true) return { confirmed: true };
  if (typeof raw !== 'object') return { confirmed: false, code: 'not_confirmed' };

  const okFlag = raw.ok === true || raw.delivered === true || raw.status === 'delivered';
  const explicitFail = raw.ok === false || raw.delivered === false || raw.status === 'failed';
  const platformMessageId = raw.platformMessageId || raw.id || raw.messageId || null;
  const hasId = typeof platformMessageId === 'string' && platformMessageId.trim() !== '';

  if (explicitFail && !okFlag) {
    return {
      confirmed: false,
      code: raw.code || raw.reason || 'transport_failed',
      errorMessage: raw.message || raw.error,
      platformMessageId: hasId ? String(platformMessageId).trim() : null,
    };
  }
  if (okFlag || hasId) {
    return {
      confirmed: true,
      platformMessageId: hasId ? String(platformMessageId).trim() : null,
    };
  }
  return { confirmed: false, code: 'not_confirmed', platformMessageId: null };
}

function classifyTransportThrown(err) {
  const name = err && err.name;
  const code = err && (err.code || err.cause?.code);
  if (name === 'AbortError' || code === 'ABORT_ERR' || /timeout/i.test(String(err && err.message || ''))) {
    return 'transport_timeout';
  }
  if (typeof code === 'string' && /ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE/.test(code)) {
    return 'transport_unreachable';
  }
  return 'transport_failed';
}

/**
 * Build a receipt. Callers must not pass secrets; they are redacted anyway.
 */
function createDeliveryReceipt(input = {}) {
  const accepted = input.accepted === true;
  let delivered = input.delivered === true && accepted;
  let status = input.status;
  if (!status) {
    if (!accepted) status = DELIVERY_STATUSES.REJECTED;
    else if (delivered) status = DELIVERY_STATUSES.DELIVERED;
    else if (input.failed === true || input.error) status = DELIVERY_STATUSES.FAILED;
    else status = DELIVERY_STATUSES.ACCEPTED;
  }
  if (!accepted && status === DELIVERY_STATUSES.DELIVERED) {
    status = DELIVERY_STATUSES.REJECTED;
  }
  if (status !== DELIVERY_STATUSES.DELIVERED) delivered = false;
  if (delivered) status = DELIVERY_STATUSES.DELIVERED;

  const error = input.error
    ? {
      code: redactString(input.error.code || 'transport_failed'),
      message: redactString(input.error.message || DELIVERY_ERRORS_ES.transport_failed),
    }
    : (input.errorCode ? spanishError(input.errorCode, input.errorMessage) : null);

  const receipt = {
    accepted,
    delivered,
    status,
    channel: input.channel ? redactString(String(input.channel)) : null,
    error,
    platformMessageId: delivered && input.platformMessageId
      ? redactString(String(input.platformMessageId))
      : null,
    preview: previewText(input.preview || ''),
    mode: input.mode || (delivered ? 'transport' : (accepted ? 'accepted_only' : 'rejected')),
  };

  if (input.route) receipt.route = redactString(String(input.route));
  if (input.userId) receipt.userId = redactString(String(input.userId));
  if (input.cronJobId) receipt.cronJobId = redactString(String(input.cronJobId));

  return receipt;
}

function rejectedReceipt(errorCode, extra = {}) {
  return createDeliveryReceipt({
    accepted: false,
    delivered: false,
    status: DELIVERY_STATUSES.REJECTED,
    errorCode,
    ...extra,
  });
}

function acceptedNotDeliveredReceipt(errorCode, extra = {}) {
  return createDeliveryReceipt({
    accepted: true,
    delivered: false,
    status: extra.failed ? DELIVERY_STATUSES.FAILED : DELIVERY_STATUSES.ACCEPTED,
    failed: extra.failed === true,
    errorCode,
    ...extra,
  });
}

function deliveredReceipt(extra = {}) {
  return createDeliveryReceipt({
    accepted: true,
    delivered: true,
    status: DELIVERY_STATUSES.DELIVERED,
    ...extra,
  });
}

function receiptHasNoSecrets(receipt, forbidden = []) {
  const blob = JSON.stringify(receipt);
  if (SECRETISH.test(blob)) return false;
  for (const item of forbidden) {
    if (item && String(item).length >= 4 && blob.includes(String(item))) return false;
  }
  return redactString(blob) === blob;
}

module.exports = {
  DELIVERY_STATUSES,
  DELIVERY_ERRORS_ES,
  PREVIEW_MAX,
  createDeliveryReceipt,
  rejectedReceipt,
  acceptedNotDeliveredReceipt,
  deliveredReceipt,
  normalizeTransportResult,
  classifyTransportThrown,
  spanishError,
  previewText,
  payloadLooksSecret,
  receiptHasNoSecrets,
  redactErrorMessage,
};
