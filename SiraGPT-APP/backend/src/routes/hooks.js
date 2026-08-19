/**
 * /api/hooks/:id — webhook receiver that fires a stored agent job.
 *
 * Authentication model: the caller must present the job's shared
 * secret, either as `?secret=` query param or (preferred) an
 * `x-hook-secret` header. This is NOT user-auth — anyone with the
 * secret can trigger the hook. That's intentional: webhooks are for
 * third-party integrations that don't know the user's JWT.
 *
 * Defence in depth:
 *   - Hook runs asynchronously — the caller gets 202 immediately,
 *     so a slow agent run doesn't hold the integration's connection.
 *   - Rate limited by the global /api/ limiter (already configured
 *     in index.js). Webhook-specific limits live TODO above Prisma.
 *   - The body is bounded by the global 50mb JSON limit but a sane
 *     webhook should be tiny; larger payloads are accepted but only
 *     the first 8kb are serialised into the prompt template.
 */

const express = require('express');
const scheduler = require('../services/scheduler/scheduler');

const router = express.Router();

const MAX_PAYLOAD_CHARS = 8000;

function presentedSecret(req) {
  return String(req.get('x-hook-secret') || req.query.secret || '');
}

function constantTimeEquals(a, b) {
  // Not bothering with a full crypto.timingSafeEqual because the
  // secrets are equal-length base64url (24 bytes → 32 chars). If a
  // future secret generator changes length, revisit this.
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

router.post('/:id', async (req, res) => {
  const { id } = req.params;
  const job = scheduler.getJob(id);
  if (!job || job.type !== 'webhook') {
    // Same response for missing and wrong-type so we don't leak the
    // existence of cron jobs at guessable ids.
    return res.status(404).json({ error: 'not found' });
  }
  const presented = presentedSecret(req);
  if (!constantTimeEquals(presented, job.secret)) {
    return res.status(401).json({ error: 'bad secret' });
  }
  if (!job.enabled) {
    return res.status(409).json({ error: 'job disabled' });
  }

  // Truncate payload to keep prompt substitution bounded.
  let payload = req.body;
  try {
    const s = JSON.stringify(payload || {});
    if (s.length > MAX_PAYLOAD_CHARS) {
      payload = { _truncated: true, preview: s.slice(0, MAX_PAYLOAD_CHARS) };
    }
  } catch {
    payload = { _error: 'unserialisable payload' };
  }

  // Fire and forget — give the caller 202, run the agent in the
  // background. This is a webhook; the third party doesn't wait.
  setImmediate(() => {
    scheduler.fireJob(id, { source: 'webhook', payload }).catch(err => {
      console.error(`[hooks] fire failed for ${id}:`, err.message);
    });
  });
  res.status(202).json({ accepted: true, id });
});

module.exports = router;
