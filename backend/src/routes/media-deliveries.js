'use strict';

/**
 * /api/media-deliveries — the transcriptions a chat handed off to the
 * background («te aviso aquí cuando termine»), seen from that chat.
 *
 *   POST /cancel  { chatId, deliveryIds?, fileIds? } → { ok, cancelled, results }
 *        «Detener»: closes those deliveries (all the chat's open ones when no
 *        ids are given), stops their recordings' transcription unless
 *        another open request of the user still needs them, and leaves one
 *        line in the chat that settles the pending turn.
 *
 * User-scoped (auth required): only the caller's own deliveries are ever
 * read or touched. Cookie-auth mutations are CSRF-gated at mount time
 * (index.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const MAX_IDS = 50;
// A batch of 100 recordings per message, a few messages pending.
const MAX_FILE_IDS = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function userIdOf(req) {
  return req.user && (req.user.id || req.user.userId);
}

function createMediaDeliveriesRouter({ delivery = null, auth = authenticateToken } = {}) {
  const router = express.Router();
  const service = () => delivery || require('../services/media-delivery');

  router.post('/cancel', auth, async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado.' });
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
    if (!chatId || !ID_RE.test(chatId)) {
      return res.status(400).json({ ok: false, error: 'Falta el chat.', code: 'chat_required' });
    }
    const rawIds = Array.isArray(req.body?.deliveryIds) ? req.body.deliveryIds : null;
    const deliveryIds = rawIds
      ? [...new Set(rawIds.filter(id => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_IDS)
      : null;
    // The pending hand-offs' recordings: every open delivery for them stops
    // too (two links in one turn are two deliveries; the hand-off names one).
    const rawFiles = Array.isArray(req.body?.fileIds) ? req.body.fileIds : null;
    const fileIds = rawFiles
      ? [...new Set(rawFiles.filter(id => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_FILE_IDS)
      : null;
    try {
      const out = await service().cancelChatDeliveries({ userId: String(userId), chatId, deliveryIds, fileIds });
      if (out?.error === 'disabled') {
        return res.status(409).json({ ok: false, error: 'Las entregas en segundo plano están desactivadas.', code: 'delivery_disabled' });
      }
      if (out?.error === 'unavailable') {
        return res.status(503).json({ ok: false, error: 'No se pudo leer el estado de la transcripción. Vuelve a intentarlo.', code: 'delivery_unavailable' });
      }
      const results = (Array.isArray(out?.results) ? out.results : []).map(result => ({
        id: result.id, outcome: result.outcome, messageId: result.messageId || null,
      }));
      // A Stop the store could not record is no «ya había terminado»: the
      // client says it failed and the user tries again.
      if (results.some(result => result.outcome === 'error')) {
        return res.status(500).json({ ok: false, error: 'No se pudo detener la transcripción. Vuelve a intentarlo.', code: 'cancel_failed',
          cancelled: Number(out?.cancelled) || 0, results });
      }
      return res.json({ ok: true, cancelled: Number(out?.cancelled) || 0, results });
    } catch (err) {
      try { console.warn('[media-deliveries] cancel failed:', err?.code || err?.message || 'cancel_error'); } catch (_) { /* noop */ }
      return res.status(500).json({ ok: false, error: 'No se pudo detener la transcripción.', code: 'cancel_failed' });
    }
  });

  return router;
}

module.exports = createMediaDeliveriesRouter();
module.exports.createMediaDeliveriesRouter = createMediaDeliveriesRouter;
