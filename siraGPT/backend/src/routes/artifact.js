/**
 * /api/artifact — SSE streaming React-artifact generator.
 *
 * Mirrors the plan / math / viz / doc contract: SSE events for
 * progress, assistant message persisted on final/error, inline
 * rendering on the front-end via <InteractiveArtifactDisplay/>.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamArtifact } = require('../services/artifact-generator');

const router = express.Router();
router.use(authenticateToken);

async function persistSuccess(chatId, userId, displayPrompt, content, file) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content, files: JSON.stringify([file]) },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [file] };
}

async function persistFailure(chatId, userId, displayPrompt, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  const content = `No pude generar el artefacto: ${reason}. Decime qué inputs debería aceptar y qué debería calcular y lo intento otra vez.`;
  const assistant = await prisma.message.create({ data: { chatId, role: 'ASSISTANT', content } });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [] };
}

router.post(
  '/generate',
  [
    body('prompt').isString().trim().isLength({ min: 4, max: 6000 }),
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

    send({ type: 'stage', label: 'Preparando generador', pct: 1 });

    let content = null, file = null, errorMsg = null;

    try {
      for await (const ev of streamArtifact({ prompt, model: req.body.model, signal: controller.signal })) {
        if (clientGone) break;
        if (ev.type === 'final') { content = ev.content; file = ev.file; continue; }
        if (ev.type === 'error') { errorMsg = ev.error; continue; }
        send(ev);
      }
    } catch (err) {
      errorMsg = err?.message || 'artifact failed';
    }

    clearInterval(heartbeat);

    if (content && file) {
      send({ type: 'stage', label: 'Guardando en la conversación', pct: 98 });
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistSuccess(chatId, req.user.id, displayPrompt, content, file); }
        catch (e) { console.error('[artifact] persist success error:', e?.message); }
      }
      send({ type: 'final', content, file, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[artifact] generation failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, displayPrompt, reason); }
        catch (e) { console.error('[artifact] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
