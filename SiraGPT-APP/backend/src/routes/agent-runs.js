'use strict';

/**
 * /api/agent-runs — observability read surface over the agent_steps trace.
 *
 * GET /:traceId returns every persisted step of one agent run (all rows
 * sharing the trace_id agent-steps-store stamps at persist time), newest
 * runs being discoverable via messages.agent_metadata.traceId. Ownership
 * is enforced by walking step → message → chat.userId; a trace that
 * exists but belongs to someone else answers 404 (not 403) so ids can't
 * be probed.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

const router = express.Router();

const TRACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

router.get('/:traceId', authenticateToken, async (req, res) => {
  const traceId = String(req.params.traceId || '').trim();
  if (!TRACE_ID_RE.test(traceId)) {
    return res.status(400).json({ error: 'invalid traceId' });
  }
  if (!prisma?.agentStep?.findMany) {
    return res.status(503).json({ error: 'agent trace store unavailable' });
  }
  try {
    const steps = await prisma.agentStep.findMany({
      where: { traceId },
      orderBy: { stepIndex: 'asc' },
      include: {
        message: {
          select: {
            id: true,
            chatId: true,
            chat: { select: { userId: true } },
          },
        },
      },
    });
    if (!steps.length) return res.status(404).json({ error: 'trace not found' });
    const ownerId = steps[0]?.message?.chat?.userId;
    if (!ownerId || String(ownerId) !== String(req.user?.id)) {
      return res.status(404).json({ error: 'trace not found' });
    }
    const first = steps[0];
    return res.json({
      traceId,
      messageId: first.message?.id || null,
      chatId: first.message?.chatId || null,
      stepCount: steps.length,
      toolCalls: steps.filter((s) => s.type === 'tool_call').length,
      errors: steps.filter((s) => s.isError).length,
      durationMs: steps.reduce((sum, s) => sum + (s.durationMs || 0), 0),
      steps: steps.map((s) => ({
        stepIndex: s.stepIndex,
        type: s.type,
        toolName: s.toolName,
        args: s.args ?? null,
        result: s.result ?? null,
        status: s.status,
        durationMs: s.durationMs,
        isError: s.isError,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error('[agent-runs] trace lookup failed:', err && err.message);
    return res.status(500).json({ error: 'trace lookup failed' });
  }
});

module.exports = router;
