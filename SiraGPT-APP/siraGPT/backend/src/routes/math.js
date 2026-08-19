/**
 * /api/math — SSE-streaming math/science solver.
 *
 * POST /api/math/solve
 *   body: { prompt, chatId?, model? }
 *   emits SSE events (mirrors /api/plan/generate):
 *     · { type: 'stage', label, pct }
 *     · { type: 'final', assistantMessage, content, topic, usedPython }
 *     · { type: 'error', error, assistantMessage? }
 *
 * When `chatId` is provided we persist the user prompt + the
 * assistant's rendered markdown (LaTeX + Python block + output). On
 * failure we still save an explanatory assistant message so the chat
 * never lands empty — same contract as the plan route.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamSolve } = require('../services/math-solver');

const router = express.Router();
router.use(authenticateToken);

async function persistSuccess(chatId, userId, displayPrompt, content) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [] };
}

async function persistFailure(chatId, userId, displayPrompt, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  const content = `No pude resolver el problema: ${reason}. Reformulá la pregunta con más detalle (valores numéricos, definiciones) o probá otro modelo.`;
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [] };
}

router.post(
  '/solve',
  [
    body('prompt').isString().trim().isLength({ min: 2, max: 6000 }),
    body('displayPrompt').optional().isString().trim().isLength({ max: 6000 }),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const prompt = req.body.prompt.trim();
    const displayPrompt = (req.body.displayPrompt || prompt).trim();
    const { chatId } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    const controller = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);

    send({ type: 'stage', label: 'Preparando solver', pct: 1 });

    let content = null, errorMsg = null, topic = 'other', usedPython = false;

    try {
      for await (const ev of streamSolve({ prompt, model: req.body.model, signal: controller.signal })) {
        if (clientGone) break;
        if (ev.type === 'final') { content = ev.content; topic = ev.topic; usedPython = ev.usedPython; continue; }
        if (ev.type === 'error') { errorMsg = ev.error; continue; }
        send(ev);
      }
    } catch (err) {
      errorMsg = err?.message || 'solver failed';
    }

    clearInterval(heartbeat);

    if (content) {
      send({ type: 'stage', label: 'Guardando en la conversación', pct: 98 });
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistSuccess(chatId, req.user.id, displayPrompt, content); }
        catch (e) { console.error('[math] persist success error:', e?.message); }
      }
      send({ type: 'final', content, topic, usedPython, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[math] solver failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, displayPrompt, reason); }
        catch (e) { console.error('[math] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
