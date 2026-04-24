/**
 * /api/viz — SSE streaming data-visualisation generator.
 *
 * POST /api/viz/generate   body: { prompt, chatId?, model? }
 *   emits: stage / final / error events identical in shape to
 *          /api/plan and /api/math so the chat can reuse the same
 *          SSE reader + progress UI.
 *
 * On success the persisted assistant message carries a single file
 * of shape { type: 'viz', format, title, explanation, <payload> }.
 * The front-end <VizArtifactDisplay /> dispatches on `format`:
 *   matplotlib → <img src={imageUrl}/>
 *   plotly      → react-plotly.js
 *   chartjs     → chart.js renderer
 *   recharts    → <LineChart>/<BarChart>/<AreaChart>/<PieChart>/<ScatterChart>
 *   d3          → sandboxed iframe srcdoc={html}
 *   mermaid     → FigmaDiagramDisplay (mermaid.ink image + client SVG)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamViz } = require('../services/viz-generator');

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
  return {
    id: assistant.id, role: assistant.role, content: assistant.content,
    files: [file],
  };
}

async function persistFailure(chatId, userId, displayPrompt, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayPrompt } });
  const content = `No pude generar la visualización: ${reason}. Reformulá el pedido dándome los datos concretos o el tipo de gráfico que querés.`;
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
      for await (const ev of streamViz({ prompt, model: req.body.model, signal: controller.signal })) {
        if (clientGone) break;
        if (ev.type === 'final') { content = ev.content; file = ev.file; format = ev.format; continue; }
        if (ev.type === 'error') { errorMsg = ev.error; continue; }
        send(ev);
      }
    } catch (err) {
      errorMsg = err?.message || 'viz failed';
    }

    clearInterval(heartbeat);

    if (content && file) {
      send({ type: 'stage', label: 'Guardando en la conversación', pct: 98 });
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistSuccess(chatId, req.user.id, displayPrompt, content, file); }
        catch (e) { console.error('[viz] persist success error:', e?.message); }
      }
      send({ type: 'final', content, file, format, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[viz] generation failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, displayPrompt, reason); }
        catch (e) { console.error('[viz] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
