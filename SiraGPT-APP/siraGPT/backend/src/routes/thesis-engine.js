'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { runThesisPipeline } = require('../services/thesis/thesis-engine');

const router = express.Router();

router.post(
  '/engine/run',
  [
    body('topic').isString().trim().isLength({ min: 8, max: 4000 }),
    body('chapterIds').optional().isArray(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const events = [];
    try {
      const report = await runThesisPipeline(
        {
          topic: req.body.topic,
          chapterIds: req.body.chapterIds,
          onEvent: (e) => events.push(e),
        },
        {
          generateChapter: async ({ template, topic, references }) => {
            const refBlock = references.slice(0, 5).map((r) => `- ${r.apa}`).join('\n');
            return [
              `# ${template.title}`,
              '',
              `Tema: ${topic}`,
              '',
              '## Referencias verificadas (DOI)',
              refBlock || '(sin referencias verificadas)',
              '',
              `Borrador generado para ${template.title}. Ampliar con el modelo LLM en producción.`,
            ].join('\n');
          },
        },
      );
      return res.json({ ok: true, report, events });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err && err.message ? err.message : String(err),
        events,
      });
    }
  },
);

router.post(
  '/engine/stream',
  [
    body('topic').isString().trim().isLength({ min: 8, max: 4000 }),
  ],
  authenticateToken,
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      await runThesisPipeline(
        { topic: req.body.topic, onEvent: send },
        {
          generateChapter: async ({ template, topic }) => `# ${template.title}\n\nTema: ${topic}\n`,
        },
      );
      send({ type: 'report_ready' });
    } catch (err) {
      send({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
    res.end();
  },
);

module.exports = router;
