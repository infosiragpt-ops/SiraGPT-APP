/**
 * /api/design — CRUD + SSE generation for DesignProject rows.
 *
 * JWT-authed, user-scoped (a user only ever sees/edits their own
 * designs). Mirrors the shape of routes/projects.js so the app's
 * conventions stay uniform (same validation, same 404-not-403 on
 * foreign id, same error shape).
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const OpenAI = require('openai');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const generator = require('../services/design-generator');

const router = express.Router();

router.use(authenticateToken);

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

async function ownDesign(userId, id) {
  return prisma.designProject.findFirst({
    where: { id, userId },
  });
}

// ─── LIST ─────────────────────────────────────────────────────────────────

router.get(
  '/',
  [query('search').optional().isString()],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const where = { userId: req.user.id };
      if (search) {
        where.name = { contains: search, mode: 'insensitive' };
      }
      // Don't ship full HTML in the list — it can be hundreds of KB.
      // Clients that need the full doc fetch GET /:id.
      const designs = await prisma.designProject.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true, name: true, kind: true, fidelity: true,
          speakerNotes: true, createdAt: true, updatedAt: true,
        },
      });
      res.json({ designs });
    } catch (err) {
      console.error('[design] list error:', err);
      res.status(500).json({ error: 'Failed to list designs' });
    }
  }
);

// ─── CREATE ───────────────────────────────────────────────────────────────

router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }),
    body('kind').isIn(['prototype', 'slide_deck', 'template', 'other']),
    body('fidelity').optional().isIn(['wireframe', 'high']),
    body('speakerNotes').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const { name, kind, fidelity, speakerNotes } = req.body;
      // Kind-specific validation: prototype needs fidelity; slide_deck
      // may have speakerNotes. Templates are a stub for now — accept
      // but don't differentiate in the generator.
      if (kind === 'prototype' && !fidelity) {
        return res.status(400).json({ error: 'fidelity required for prototype' });
      }
      const design = await prisma.designProject.create({
        data: {
          userId: req.user.id,
          name: name.trim(),
          kind,
          fidelity: kind === 'prototype' ? fidelity : null,
          speakerNotes: kind === 'slide_deck' ? !!speakerNotes : null,
          messages: [],
        },
      });
      res.status(201).json({ design });
    } catch (err) {
      console.error('[design] create error:', err);
      res.status(500).json({ error: 'Failed to create design' });
    }
  }
);

// ─── GET ──────────────────────────────────────────────────────────────────

router.get('/:id', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const design = await ownDesign(req.user.id, req.params.id);
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json({ design });
  } catch (err) {
    console.error('[design] get error:', err);
    res.status(500).json({ error: 'Failed to fetch design' });
  }
});

// ─── UPDATE (name, html snapshot) ─────────────────────────────────────────

router.put(
  '/:id',
  [
    param('id').isString(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('html').optional({ nullable: true }).isString().isLength({ max: 500_000 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const owned = await ownDesign(req.user.id, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Design not found' });

      const data = {};
      if (typeof req.body.name === 'string') data.name = req.body.name.trim();
      if ('html' in req.body) data.html = req.body.html;

      const design = await prisma.designProject.update({
        where: { id: owned.id },
        data,
      });
      res.json({ design });
    } catch (err) {
      console.error('[design] update error:', err);
      res.status(500).json({ error: 'Failed to update design' });
    }
  }
);

// ─── DELETE ───────────────────────────────────────────────────────────────

router.delete('/:id', param('id').isString(), async (req, res) => {
  try {
    if (validationFail(req, res)) return;
    const owned = await ownDesign(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Design not found' });
    await prisma.designProject.delete({ where: { id: owned.id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[design] delete error:', err);
    res.status(500).json({ error: 'Failed to delete design' });
  }
});

// ─── GENERATE (SSE) ───────────────────────────────────────────────────────

router.post(
  '/:id/generate',
  [
    param('id').isString(),
    body('instruction').isString().trim().isLength({ min: 2, max: 6000 }),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    if (validationFail(req, res)) return;
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    const owned = await ownDesign(req.user.id, req.params.id);
    if (!owned) return res.status(404).json({ error: 'Design not found' });

    // SSE headers + client-disconnect propagation. If the user
    // closes the tab mid-generation, abort the underlying OpenAI
    // stream so we don't burn tokens after they've left.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const history = Array.isArray(owned.messages) ? owned.messages : [];
    const userMsg = { role: 'user', content: req.body.instruction, at: new Date().toISOString() };

    try {
      send({ type: 'start' });
      let finalHtml = '';
      let seenChars = 0;
      for await (const chunk of generator.streamGeneration(openai, {
        instruction: req.body.instruction,
        history: history.map(m => ({ role: m.role, content: m.content })),
        currentHtml: owned.html,
        kind: owned.kind,
        fidelity: owned.fidelity,
        speakerNotes: owned.speakerNotes,
        model: req.body.model,
        signal: controller.signal,
      })) {
        if (chunk.final) {
          finalHtml = chunk.full;
          break;
        }
        // Throttle the on-the-wire chunk rate. The model emits
        // many tiny deltas; sending each as its own SSE frame
        // floods the client parser and the browser iframe
        // preview does nothing useful until the doc is done
        // anyway. We send a progress ping every ~2KB so the UI
        // can update a progress indicator.
        seenChars += chunk.delta.length;
        if (seenChars >= 2048) {
          send({ type: 'progress', chars: chunk.full.length });
          seenChars = 0;
        }
      }

      // Persist: append the user/assistant turns to messages and
      // replace html with the new document.
      const updated = await prisma.designProject.update({
        where: { id: owned.id },
        data: {
          html: finalHtml,
          messages: [
            ...history,
            userMsg,
            { role: 'assistant', content: '(generated HTML)', at: new Date().toISOString(), htmlChars: finalHtml.length },
          ],
        },
        select: { id: true, name: true, updatedAt: true },
      });

      send({ type: 'final', html: finalHtml, updatedAt: updated.updatedAt });
    } catch (err) {
      if (err?.name === 'AbortError') {
        send({ type: 'error', error: 'aborted' });
      } else {
        console.error('[design] generate error:', err);
        send({ type: 'error', error: err.message || 'generation failed' });
      }
    } finally {
      try { res.end(); } catch { /* already closed */ }
    }
  }
);

module.exports = router;
