/**
 * /api/plan — SSE streaming generator for architectural DXF floor plans.
 *
 * The route emits Server-Sent Events so the browser can render live
 * progress ("Consultando modelo · 2.3k tokens · 45%") instead of a
 * silent 30-60s wait. Events match the `streamPlan()` generator:
 *   · { type: 'stage', label, pct }
 *   · { type: 'tokens', count, pct }
 *   · { type: 'final', plan, dxf, assistantMessage? }
 *   · { type: 'error', error, assistantMessage? }
 *
 * Persistence: when `chatId` is provided we save the user's prompt and
 * an assistant message (with DXF attachment on success, or an
 * explanatory text on failure) and include the resulting
 * assistantMessage in the final/error event so the client can swap
 * its placeholder with the authoritative row from the database.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const { streamPlan } = require('../services/plan-generator');

const router = express.Router();
router.use(authenticateToken);

async function persistSuccess(chatId, userId, displayBrief, plan, svg, dxf) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayBrief } });
  const rooms = plan?.rooms?.length || 0;
  const summary = [
    `He generado tu plano arquitectónico: **${plan?.title || plan?.project?.name || 'Planta'}**.`,
    rooms ? `${rooms} ambiente${rooms === 1 ? '' : 's'}.` : '',
    plan?.scale ? `Escala ${plan.scale}.` : '',
    dxf ? 'Podés descargarlo como `.dxf` para abrirlo en AutoCAD, BricsCAD, Revit o LibreCAD.' : '',
  ].filter(Boolean).join(' ');
  const fileData = { type: 'plan', svg, dxf, plan, title: plan?.title || plan?.project?.name || 'Plano' };
  const assistant = await prisma.message.create({
    data: {
      chatId, role: 'ASSISTANT', content: summary,
      files: JSON.stringify([fileData]),
    },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return {
    id: assistant.id, role: assistant.role, content: assistant.content,
    files: [fileData],
  };
}

async function persistFailure(chatId, userId, displayBrief, reason) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
  if (!chat) return null;
  await prisma.message.create({ data: { chatId, role: 'USER', content: displayBrief } });
  const content = `No pude generar el plano: ${reason}. Intentá con una descripción más detallada (terreno, ambientes, baños) o probá otro modelo desde el selector.`;
  const assistant = await prisma.message.create({
    data: { chatId, role: 'ASSISTANT', content },
  });
  await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
  return { id: assistant.id, role: assistant.role, content: assistant.content, files: [] };
}

router.post(
  '/generate',
  [
    body('prompt').optional().isString().trim().isLength({ min: 4, max: 4000 }),
    body('brief').optional().isString().trim().isLength({ min: 4, max: 4000 }),
    body('displayPrompt').optional().isString().trim().isLength({ max: 4000 }),
    body('displayBrief').optional().isString().trim().isLength({ max: 4000 }),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const brief = (req.body.prompt || req.body.brief || '').trim();
    if (!brief) return res.status(400).json({ error: 'prompt required' });
    const displayBrief = (req.body.displayPrompt || req.body.displayBrief || brief).trim();
    const { chatId } = req.body;

    // SSE headers.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

    // Client-disconnect handling.
    const controller = new AbortController();
    let clientGone = false;
    req.on('close', () => { clientGone = true; controller.abort(); });

    // Heartbeat every 15s so proxies don't drop the connection during
    // long LLM calls.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);

    send({ type: 'stage', label: 'Preparando generador', pct: 1 });

    let plan = null, svg = null, dxf = null, errorMsg = null;

    try {
      for await (const ev of streamPlan({ brief, model: req.body.model, signal: controller.signal })) {
        if (clientGone) break;
        if (ev.type === 'final') {
          plan = ev.plan;
          svg = ev.svg;
          dxf = ev.dxf;
          continue; // emit the real `final` after persisting
        }
        if (ev.type === 'error') {
          errorMsg = ev.error;
          continue;
        }
        send(ev);
      }
    } catch (err) {
      errorMsg = err?.message || 'generation failed';
    }

    clearInterval(heartbeat);

    // Persist + emit terminal event.
    if (plan && svg) {
      send({ type: 'stage', label: 'Guardando en la conversación', pct: 98 });
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistSuccess(chatId, req.user.id, displayBrief, plan, svg, dxf); }
        catch (e) { console.error('[plan] persist success error:', e?.message); }
      }
      send({ type: 'final', plan, svg, dxf, assistantMessage });
    } else {
      const reason = errorMsg || 'resultado vacío';
      console.error('[plan] generation failed:', reason);
      let assistantMessage = null;
      if (chatId) {
        try { assistantMessage = await persistFailure(chatId, req.user.id, displayBrief, reason); }
        catch (e) { console.error('[plan] persist failure error:', e?.message); }
      }
      send({ type: 'error', error: reason, assistantMessage });
    }

    try { res.end(); } catch {}
  }
);

module.exports = router;
