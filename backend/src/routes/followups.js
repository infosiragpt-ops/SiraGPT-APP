'use strict';

/**
 * /api/follow-ups — follow-up question suggestions for a chat conversation.
 *
 * POST / { messages: [{role, content}, …] } → { ok, followUps: string[] }
 *
 * Auth required (suggestions read conversation content) + per-user rate
 * limit. Functionality pattern inspired by Open WebUI's follow_up task;
 * implementation is SiraGPT's own (see services/followup-suggestions.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { slidingWindowRateLimitMiddleware } = require('../utils/sliding-window-rate-limiter');
const { generateFollowUps } = require('../services/followup-suggestions');

function buildFollowUpsRouter(deps = {}) {
  const env = deps.env || process.env;
  const auth = deps.auth || authenticateToken;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post(
    '/',
    auth,
    slidingWindowRateLimitMiddleware({
      windowMs: 60_000,
      max: Number(env.FOLLOWUPS_RATE_LIMIT_PER_MIN) || 30,
      identifier: (req) => `follow-ups:${req.user?.id || req.ip || 'anon'}`,
    }),
    async (req, res) => {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
      if (!messages || messages.length === 0) {
        return res.status(400).json({ ok: false, error: 'messages_required' });
      }
      const result = await generateFollowUps(messages, deps);
      if (!result.ok) {
        const status = result.error === 'ai_unavailable' ? 503 : result.error === 'empty_conversation' ? 400 : 502;
        return res.status(status).json({ ok: false, error: result.error });
      }
      return res.json({ ok: true, followUps: result.followUps });
    },
  );

  return router;
}

module.exports = { buildFollowUpsRouter };