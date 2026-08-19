'use strict';

/**
 * Dev-only Sentry smoke-test endpoint.
 *
 * Gated by NODE_ENV !== 'production'. Calls
 * `Sentry.captureException(new Error('test'))` so an operator can verify
 * that the wiring between siraGPT and the configured Sentry project is
 * working end-to-end without having to manually trigger a real crash.
 *
 * The route is registered at `/api/__dev/sentry-test`. It is mounted from
 * backend/index.js but the router *itself* short-circuits with a 404 in
 * production to keep this safe even if an operator accidentally re-enables
 * the mount.
 */

const express = require('express');
const { captureException, getSentryStatus } = require('../services/observability/sentry');

function buildDevSentryRouter() {
  const router = express.Router();

  router.all('/sentry-test', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }
    const sentryStatus = getSentryStatus();
    let captureResult = null;
    let captureError = null;
    try {
      const err = new Error('siragpt sentry smoke test');
      err.smokeTest = true;
      captureResult = captureException(err, { tags: { smoke: 'sentry-test', source: 'dev-endpoint' } });
    } catch (err) {
      captureError = err.message || String(err);
    }
    return res.json({
      ok: !captureError,
      sentry: sentryStatus,
      eventId: captureResult || null,
      error: captureError,
      note: 'Smoke test only — Sentry must be enabled (SENTRY_DSN + SENTRY_ENABLED=true) for the event to actually be delivered.',
    });
  });

  return router;
}

module.exports = { buildDevSentryRouter };
