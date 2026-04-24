/**
 * /api/doc — SSE streaming document generator (docx/xlsx/pptx/pdf/svg/csv).
 *
 * Same SSE contract as /api/plan, /api/math, /api/viz. On success
 * persists an assistant message with a `doc`-typed file carrying a
 * base64 data URL (so the client can download without a second
 * round-trip) + the metadata the <DocArtifactDisplay/> component
 * needs to render a download card.
 */

const express = require('express');
const path = require('path');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamAdvancedDocumentPipeline } = require('../services/document-pipeline/advanced-document-pipeline');

const router = express.Router();
router.use(authenticateToken);

async function persistSuccess(chatId, userId, displayPrompt, content, file) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  // Persist the dataUrl so document downloads and right-pane previews
  // keep working after a chat reload. Generated files are scoped by the
  // authenticated chat fetch; future storage can move bytes to object
  // storage without changing the client contract.
  const persistedFile = file;
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content, files: JSON.stringify([persistedFile]) },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return {
    id: assistant.id, role: assistant.role, content: assistant.content,
    files: [file], // still hand back the real one for this turn
  };
}

async function persistFailure(chatId, userId, displayPrompt, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
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
    body('displayPrompt').optional().isString().trim().isLength({ max: 6000 }),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
    body('format').optional().isIn(['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'html', 'md', 'markdown']),
    body('template').optional().isString().trim().isLength({ max: 60 }),
    body('complexity').optional().isIn(['simple', 'standard', 'high', 'stress']),
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
    req.on('close', () => { clientGone = true; controller.abort(); });
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);

    send({ type: 'stage', label: 'Preparando generador', pct: 1 });

    let content = null, file = null, format = null, errorMsg = null;

    try {
      const pipelineOptions = {
        prompt,
        model: req.body.model,
        format: req.body.format,
        template: req.body.template,
        complexity: req.body.complexity || 'standard',
        outputDir: path.join(__dirname, '../../uploads/document-pipeline/files'),
        telemetryDir: path.join(__dirname, '../../uploads/document-pipeline/telemetry'),
        signal: controller.signal,
      };
      for await (const ev of streamAdvancedDocumentPipeline(pipelineOptions)) {
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
        try { assistantMessage = await persistSuccess(chatId, req.user.id, displayPrompt, content, file); }
        catch (e) { console.error('[doc] persist success error:', e?.message); }
      }
      send({ type: 'final', content, file, format, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[doc] generation failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, displayPrompt, reason); }
        catch (e) { console.error('[doc] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
