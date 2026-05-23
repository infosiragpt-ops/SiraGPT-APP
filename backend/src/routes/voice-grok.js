'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const {
  createVoiceSession,
  buildVoiceSessionSnapshot,
  appendVoiceTurn,
  stopVoiceSession,
  pruneExpiredVoiceSessions,
} = require('../services/voice-session-runtime');
const { generateGrokVoiceReply } = require('../services/grok-voice-model');

const router = express.Router();
const activeVoiceSessions = new Map();

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    success: false,
    errors: errors.array(),
  });
  return true;
}

function getUserSession(sessionId, userId) {
  if (!sessionId || !userId) return null;
  const session = activeVoiceSessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

function createAndStoreSession(req, mode) {
  pruneExpiredVoiceSessions(activeVoiceSessions);
  const session = createVoiceSession({
    userId: req.user.id,
    chatId: req.body?.chatId || null,
    mode,
  });
  activeVoiceSessions.set(session.id, session);
  return session;
}

const sessionValidators = [
  body('chatId').optional().isString().isLength({ max: 128 }),
  body('mode').optional().isIn(['advanced_voice', 'dictation', 'hands_free']),
];

const turnValidators = [
  param('sessionId').isString().isLength({ min: 1, max: 128 }),
  body('text').isString().isLength({ min: 1, max: 4000 }),
  body('source').optional().isIn(['stt', 'typed', 'system']),
  body('respond').optional().isBoolean(),
];

router.post(
  '/sessions',
  sessionValidators,
  authenticateToken,
  (req, res) => {
    if (validationErrors(req, res)) return;
    const session = createAndStoreSession(req, req.body.mode);
    res.json({
      success: true,
      session: buildVoiceSessionSnapshot(session),
    });
  },
);

router.get(
  '/sessions/:sessionId',
  [param('sessionId').isString().isLength({ min: 1, max: 128 })],
  authenticateToken,
  (req, res) => {
    if (validationErrors(req, res)) return;
    pruneExpiredVoiceSessions(activeVoiceSessions);
    const session = getUserSession(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ success: false, error: 'Voice session not found' });
    res.json({
      success: true,
      session: buildVoiceSessionSnapshot(session),
    });
  },
);

router.post(
  '/sessions/:sessionId/turn',
  turnValidators,
  authenticateToken,
  async (req, res) => {
    if (validationErrors(req, res)) return;
    pruneExpiredVoiceSessions(activeVoiceSessions);
    const session = getUserSession(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ success: false, error: 'Voice session not found' });

    try {
      const result = appendVoiceTurn(session, {
        text: req.body.text,
        source: req.body.source || 'stt',
        defaultWorkingDirectory: '/Users/luis/Desktop/siraGPT',
      });
      const payload = {
        success: true,
        ...result,
      };

      const shouldRespond = req.body.respond === true || req.body.respond === 'true';
      if (shouldRespond) {
        try {
          const responder = req.app.locals.grokVoiceResponder || generateGrokVoiceReply;
          payload.assistant = await responder({
            session,
            turn: result.turn,
            user: req.user,
          });
        } catch (replyError) {
          payload.assistant = {
            provider: 'fallback',
            model: 'grok-voice-fallback',
            configured: false,
            text: 'Recibi tu voz, pero Grok no pudo responder en este momento. El chat normal sigue disponible.',
            spoken: true,
            errorCode: replyError.code || 'grok_voice_reply_failed',
          };
        }
      }

      res.json(payload);
    } catch (error) {
      res.status(error.code === 'voice_transcript_too_large' ? 413 : 400).json({
        success: false,
        error: error.message,
        code: error.code || 'voice_turn_failed',
      });
    }
  },
);

router.post(
  '/sessions/:sessionId/stop',
  [param('sessionId').isString().isLength({ min: 1, max: 128 })],
  authenticateToken,
  (req, res) => {
    if (validationErrors(req, res)) return;
    const session = getUserSession(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ success: false, error: 'Voice session not found' });
    const snapshot = stopVoiceSession(session);
    activeVoiceSessions.delete(session.id);
    res.json({
      success: true,
      session: snapshot,
    });
  },
);

router.post(
  '/stream',
  [
    body('text').optional().isString().isLength({ max: 4000 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
    body('sessionId').optional().isString().isLength({ max: 128 }),
  ],
  authenticateToken,
  async (req, res) => {
    if (validationErrors(req, res)) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    pruneExpiredVoiceSessions(activeVoiceSessions);
    let session = req.body.sessionId ? getUserSession(req.body.sessionId, req.user.id) : null;
    if (req.body.sessionId && !session) {
      send({ type: 'error', error: 'Voice session not found' });
      send({ type: 'done' });
      res.end();
      return;
    }

    if (!session) {
      session = createAndStoreSession(req, 'advanced_voice');
    }

    send({ type: 'session', session: buildVoiceSessionSnapshot(session) });
    send({ type: 'phase', phase: 'stt', message: req.body.text ? 'Transcript received.' : 'Awaiting speech transcript.' });

    if (req.body.text) {
      const result = appendVoiceTurn(session, {
        text: req.body.text,
        source: 'stt',
        defaultWorkingDirectory: '/Users/luis/Desktop/siraGPT',
      });
      send({ type: 'turn', turn: result.turn, session: result.session });
      send({
        type: 'phase',
        phase: result.turn.route === 'desktop_action' ? 'desktop_action_planned' : 'chat_dispatch_ready',
        message: result.turn.route === 'desktop_action'
          ? 'Desktop action planned under the local bridge safety policy.'
          : 'Transcript is ready to dispatch through the normal chat pipeline.',
      });
    } else {
      send({ type: 'phase', phase: 'listening', message: 'Persistent voice session is active.' });
    }

    send({
      type: 'tts',
      audioUrl: null,
      message: 'TTS provider is not executed in this backend contract path yet.',
    });
    send({ type: 'done' });
    res.end();
  },
);

module.exports = router;
module.exports.activeVoiceSessions = activeVoiceSessions;
module.exports.INTERNAL = {
  getUserSession,
  createAndStoreSession,
};
