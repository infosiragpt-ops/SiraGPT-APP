/**
 * /api/projects/:projectId/marco-teorico — SSE endpoint that runs
 * the Marco Teórico orchestrator and streams phase/source/chunk
 * events back to the client.
 *
 * Mount order: this file is wired as a nested router under
 * /api/projects from index.js, so the existing JWT middleware on
 * /api/projects applies. Ownership is rechecked here because we use
 * `mergeParams: true` to inherit `:projectId`.
 *
 * The route doesn't persist anything — saving the generated marco
 * teórico as a chat / attaching it to the project is a separate
 * POST /api/projects/:id/marco-teorico/save call (kept here too).
 * Separating generation from persistence lets the user preview,
 * regenerate, and bail without stray artifacts.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const OpenAI = require('openai');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const orchestrator = require('../services/marco-teorico/orchestrator');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);

async function ownProject(userId, id) {
  return prisma.project.findFirst({
    where: { id, userId },
    select: { id: true, name: true, description: true },
  });
}

// ─── POST /generate — streaming run ───────────────────────────────────────

router.post(
  '/generate',
  [
    body('topic').optional().isString().trim().isLength({ max: 400 }),
    body('limit').optional().isInt({ min: 5, max: 60 }),
    body('yearFrom').optional().isInt({ min: 1900, max: 2100 }),
    body('yearTo').optional().isInt({ min: 1900, max: 2100 }),
    body('lang').optional().isIn(['es', 'en', 'pt', 'fr']),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const projectId = req.params.projectId || req.params.id;
    const project = await ownProject(req.user.id, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Topic defaults to the project's description when the client
    // doesn't explicitly override — sidesteps the common case where
    // the user wants "generate marco teórico for THIS project" and
    // shouldn't have to retype the topic they already wrote.
    const topic = (req.body.topic || project.description || project.name || '').trim();
    if (!topic || topic.length < 4) {
      return res.status(400).json({ error: 'topic is too short — add a description to the project or pass topic in the body' });
    }

    const yearRange = (req.body.yearFrom && req.body.yearTo)
      ? [Number(req.body.yearFrom), Number(req.body.yearTo)]
      : null;

    // SSE framing.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Propagate a client disconnect to the orchestrator's AbortSignal
    // so we stop any in-flight CrossRef / LLM calls instead of
    // wasting tokens after the user closed the tab.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
      for await (const event of orchestrator.run(openai, {
        topic,
        description: project.description || null,
        limit: req.body.limit || 30,
        yearRange,
        lang: req.body.lang || 'es',
        model: req.body.model || 'gpt-4o',
        signal: controller.signal,
      })) {
        send(event);
        if (event.type === 'error' && event.phase !== 'search') break; // error from a later phase — stop
      }
    } catch (err) {
      console.error('[marco-teorico] orchestrator error:', err);
      send({ type: 'error', message: err.message || 'pipeline error' });
    } finally {
      try { res.end(); } catch { /* already closed */ }
    }
  }
);

// ─── POST /save — persist the generated marco as a chat ──────────────────

router.post(
  '/save',
  [
    body('title').optional().isString().isLength({ min: 1, max: 120 }),
    body('markdown').isString().isLength({ min: 50 }),
    body('sources').optional().isArray(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const projectId = req.params.projectId || req.params.id;
      const project = await ownProject(req.user.id, projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const title = (req.body.title || `Marco teórico: ${project.name}`).slice(0, 120);

      // Save as a chat with a pre-populated assistant message so the
      // user can iterate on it in the normal chat flow (ask for a
      // section to be rewritten, expand a theme, etc.). The USER
      // turn records the topic so the conversation makes sense if
      // the user scrolls up later.
      const chat = await prisma.chat.create({
        data: {
          userId: req.user.id,
          projectId: project.id,
          title,
          model: 'gpt-4o',
          messages: {
            createMany: {
              data: [
                {
                  role: 'USER',
                  content: req.body.topic || `Genera el marco teórico para: ${project.name}`,
                  metadata: { source: 'marco-teorico', phase: 'seed' },
                },
                {
                  role: 'ASSISTANT',
                  content: req.body.markdown,
                  metadata: {
                    source: 'marco-teorico',
                    sources: req.body.sources || [],
                  },
                },
              ],
            },
          },
        },
        select: { id: true, title: true, projectId: true },
      });

      res.status(201).json({ chat });
    } catch (err) {
      console.error('[marco-teorico] save error:', err);
      res.status(500).json({ error: 'Failed to save marco teórico' });
    }
  }
);

module.exports = router;
