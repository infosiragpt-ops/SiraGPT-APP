'use strict';

const express = require('express');
const { authenticateToken: defaultAuthenticateToken } = require('../middleware/auth');
const defaultPrisma = require('../config/database');
const controlPlane = require('../services/cowork/control-plane');

function createCoworkAiControlRouter({
  prisma = defaultPrisma,
  authenticateToken = defaultAuthenticateToken,
} = {}) {
  const router = express.Router();

  router.post('/steer', authenticateToken, async (req, res) => {
    try {
      const uid = req.user?.id || req.user?.userId;
      let runId = String(req.body?.runId || '').trim();
      if (!runId && req.body?.chatId) {
        const run = await prisma.coworkRun.findFirst({
          where: {
            userId: String(uid),
            chatId: String(req.body.chatId),
            status: { in: controlPlane.ACTIVE_STATUSES },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        runId = run?.id || '';
      }
      if (!runId) return res.status(404).json({ error: 'active_cowork_run_not_found' });
      const steering = await controlPlane.enqueueSteering(prisma, {
        runId,
        userId: uid,
        note: req.body?.note,
      });
      return res.status(202).json({
        accepted: true,
        steering: {
          id: steering.id,
          runId: steering.runId,
          status: steering.status,
          createdAt: steering.createdAt,
        },
      });
    } catch (error) {
      const status = Number(error?.status) || 500;
      return res.status(status).json({
        error: status < 500 ? (error.code || 'cowork_steer_failed') : 'cowork_steer_failed',
        message: status < 500 ? error.message : 'Could not steer the task.',
      });
    }
  });

  return router;
}

module.exports = { createCoworkAiControlRouter };
