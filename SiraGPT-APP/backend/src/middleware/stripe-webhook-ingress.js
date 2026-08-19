'use strict';

const express = require('express');

const STRIPE_WEBHOOK_PATH = '/api/payments/stripe/webhook';

function requestPath(req) {
  const raw = req?.originalUrl || req?.url || '';
  return String(raw).split('?')[0];
}

function isExactStripeWebhookRequest(req) {
  return String(req?.method || '').toUpperCase() === 'POST'
    && requestPath(req) === STRIPE_WEBHOOK_PATH;
}

/**
 * Selectively buffers Stripe's exact webhook endpoint as raw bytes. All other
 * requests continue to the generic JSON parser mounted immediately after it.
 */
function createStripeWebhookRawBodyMiddleware() {
  const parseRawJson = express.raw({ type: 'application/json' });
  return function stripeWebhookRawBody(req, res, next) {
    if (!isExactStripeWebhookRequest(req)) return next();
    return parseRawJson(req, res, next);
  };
}

/**
 * Keep CSRF protection on the whole payments router except Stripe's signed,
 * server-to-server webhook POST. Matching uses originalUrl so an Express
 * router mount cannot accidentally exempt a sibling or child path.
 */
function createPaymentsCsrfMiddleware(requireCsrf) {
  if (typeof requireCsrf !== 'function') {
    throw new TypeError('createPaymentsCsrfMiddleware requires a CSRF middleware');
  }
  return function paymentsCsrf(req, res, next) {
    if (isExactStripeWebhookRequest(req)) return next();
    return requireCsrf(req, res, next);
  };
}

module.exports = {
  STRIPE_WEBHOOK_PATH,
  requestPath,
  isExactStripeWebhookRequest,
  createStripeWebhookRawBodyMiddleware,
  createPaymentsCsrfMiddleware,
};
