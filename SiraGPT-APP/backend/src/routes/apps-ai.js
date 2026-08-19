'use strict';

/**
 * /api/apps-ai — the AI capability for GENERATED apps (SiraGPT Apps).
 *
 * Apps built by the /code agent run inside the preview (proxied under the
 * platform origin) and have NO API keys. This tiny public proxy lets them
 * integrate real AI — chatbots, assistants, ChatGPT/Claude-style products —
 * by POSTing here; the platform forwards to the free-tier model (FlashGPT /
 * Cerebras) with the platform's own key. The starter ships `src/lib/ai.ts`
 * (askAI) that talks to this endpoint, and the `app-con-ia` skill prescribes
 * the chat-UI pattern around it.
 *
 * Safety posture (public endpoint, zero auth by design):
 *   - Free-tier model ONLY (Cerebras — effectively zero marginal cost).
 *   - Strict per-IP sliding-window rate limit + tight payload caps.
 *   - No key material ever reaches the client; degraded 503 when unconfigured.
 */

const express = require('express');
const { createCerebrasClient, getCerebrasConfig, isFreeIaConfigured } = require('../services/ai/cerebras-client');
const { slidingWindowRateLimitMiddleware } = require('../utils/sliding-window-rate-limiter');

const MAX_MESSAGES = 30;
const MAX_CONTENT_CHARS = 4000;
const MAX_TOTAL_CHARS = 16000;
const MAX_SYSTEM_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 1024;
const ROLES = new Set(['system', 'user', 'assistant']);

const DEFAULT_SYSTEM =
  'Eres el asistente de IA integrado en una aplicación generada con SiraGPT Apps. ' +
  'Responde útil, claro y conciso, en el idioma del usuario.';

function validateBody(body) {
  const raw = Array.isArray(body?.messages) ? body.messages : null;
  if (!raw || raw.length === 0) return { error: 'messages_required' };
  if (raw.length > MAX_MESSAGES) return { error: 'too_many_messages' };
  let total = 0;
  const messages = [];
  for (const m of raw) {
    const role = String(m?.role || '').trim();
    const content = String(m?.content || '').trim();
    if (!ROLES.has(role)) return { error: 'invalid_role' };
    if (!content) return { error: 'empty_message' };
    if (content.length > MAX_CONTENT_CHARS) return { error: 'message_too_long' };
    total += content.length;
    messages.push({ role, content });
  }
  if (total > MAX_TOTAL_CHARS) return { error: 'conversation_too_long' };
  const system = String(body?.system || '').trim().slice(0, MAX_SYSTEM_CHARS);
  return { messages, system };
}

/**
 * @param {object} [deps] injectable for offline tests:
 *   { createClient, env }
 */
function buildAppsAiRouter(deps = {}) {
  const env = deps.env || process.env;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, configured: isFreeIaConfigured({ env }) });
  });

  router.post(
    '/chat',
    slidingWindowRateLimitMiddleware({
      windowMs: 60_000,
      max: Number(env.APPS_AI_RATE_LIMIT_PER_MIN) || 20,
      identifier: (req) => `apps-ai:${req.ip || 'anon'}`,
    }),
    async (req, res) => {
      const parsed = validateBody(req.body);
      if (parsed.error) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }
      if (!isFreeIaConfigured({ env })) {
        return res.status(503).json({ ok: false, error: 'ai_unavailable' });
      }
      // Streaming support: client sends { stream: true } → SSE token-by-token
      // like ChatGPT. Otherwise the classic JSON response (backwards compatible).
      const wantStream = req.body?.stream === true;
      try {
        const client = deps.createClient ? deps.createClient({ env }) : createCerebrasClient({ env });
        if (!client) return res.status(503).json({ ok: false, error: 'ai_unavailable' });
        const { model } = getCerebrasConfig({ env });
        const messages = [
          { role: 'system', content: parsed.system || DEFAULT_SYSTEM },
          ...parsed.messages,
        ];

        if (wantStream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();

          const stream = await client.chat.completions.create({
            model, messages,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.7,
            stream: true,
          });
          for await (const chunk of stream) {
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const completion = await client.chat.completions.create({
            model, messages,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.7,
          });
          const text = completion?.choices?.[0]?.message?.content || '';
          return res.json({ ok: true, text });
        }
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        if (res.headersSent) {
          // Streaming already started — send the error as an SSE event.
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
          res.end();
        } else {
          return res.status(502).json({ ok: false, error: 'ai_error', message: msg });
        }
      }
    },
  );

  return router;
}

module.exports = { buildAppsAiRouter, validateBody, MAX_MESSAGES, MAX_OUTPUT_TOKENS, DEFAULT_SYSTEM };
