/**
 * /api/doc — SSE streaming document generator (docx/xlsx/pptx/pdf/svg).
 *
 * Same SSE contract as /api/plan, /api/math, /api/viz. On success
 * persists an assistant message with a `doc`-typed file carrying a
 * base64 data URL (so the client can download without a second
 * round-trip) + the metadata the <DocArtifactDisplay/> component
 * needs to render a download card.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamDoc } = require('../services/doc-generator');

const router = express.Router();
router.use(authenticateToken);

async function persistSuccess(chatId, userId, prompt, content, file) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: prompt } });
  // Strip the heavy dataUrl before JSON.stringify to avoid bloating
  // the row — we persist a placeholder url and ship the real dataUrl
  // only over the wire. The front-end keeps it in memory for the
  // current session. Future turn: write the bytes to S3 / local
  // uploads and store a normal URL.
  const persistedFile = { ...file, dataUrl: file.dataUrl ? '[in-session]' : null };
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content, files: JSON.stringify([persistedFile]) },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return {
    id: assistant.id, role: assistant.role, content: assistant.content,
    files: [file], // still hand back the real one for this turn
  };
}

async function persistFailure(chatId, userId, prompt, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: prompt } });
  const content = `No pude generar el documento: ${reason}. Dame más detalle (formato, estructura, datos) y lo intento otra vez.`;
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [] };
}

router.post(
  '/generate',
  [
    body('prompt').isString().trim().isLength({ min: 4, max: 6000 }),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const prompt = req.body.prompt.trim();
    const { chatId } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    const controller = new AbortController();
    let clientGone = false;
    req.on('close', () => { clientGone = true; controller.abort(); });
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);

    send({ type: 'stage', label: 'Preparando generador', pct: 1 });

    let content = null, file = null, format = null, errorMsg = null;

    try {
      for await (const ev of streamDoc({ prompt, model: req.body.model, signal: controller.signal })) {
        if (clientGone) break;
        if (ev.type === 'final') { content = ev.content; file = ev.file; format = ev.format; continue; }
        if (ev.type === 'error') { errorMsg = ev.error; continue; }
        send(ev);
      }
    } catch (err) {
      errorMsg = err?.message || 'doc failed';
    }

    clearInterval(heartbeat);

    if (content && file && file.dataUrl) {
      send({ type: 'stage', label: 'Guardando en la conversación', pct: 98 });
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistSuccess(chatId, req.user.id, prompt, content, file); }
        catch (e) { console.error('[doc] persist success error:', e?.message); }
      }
      send({ type: 'final', content, file, format, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[doc] generation failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, prompt, reason); }
        catch (e) { console.error('[doc] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
