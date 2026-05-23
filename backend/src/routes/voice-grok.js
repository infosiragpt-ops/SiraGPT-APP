'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post(
  '/stream',
  [
    body('text').optional().isString(),
    body('chatId').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    send({ type: 'phase', phase: 'stt', message: 'Voice Grok STT placeholder — wire provider API key to enable.' });
    send({ type: 'phase', phase: 'llm', message: 'Processing transcript with chat model.' });
    send({
      type: 'tts',
      audioUrl: null,
      message: 'TTS placeholder — returns text until Grok voice endpoint is configured.',
    });
    send({ type: 'done' });
    res.end();
  },
);

module.exports = router;
