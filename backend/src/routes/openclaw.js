const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  bootstrapOpenClawWorkspace,
  getOpenClawNativeSession,
  getOpenClawStatus,
} = require('../services/openclaw-control');

const router = express.Router();

router.use(authenticateToken);

/**
 * Translate any structured error coming from openclaw-control into a
 * predictable JSON shape `{ error, code, policy? }`. The frontend
 * branches on `code` (plan_locked, runtime_disabled, etc.) so we
 * keep that contract stable in one place.
 */
function respondWithError(res, error, fallbackMessage) {
  const status = Number(error?.statusCode) || 500;
  const payload = {
    error: error?.message || fallbackMessage,
    code: error?.code || (status === 500 ? 'internal_error' : 'request_failed'),
  };
  if (error?.policy) payload.policy = error.policy;
  return res.status(status).json(payload);
}

router.get('/status', async (req, res) => {
  try {
    const status = await getOpenClawStatus(req.user);
    res.json({ status });
  } catch (error) {
    console.error('[openclaw] status error:', error);
    respondWithError(res, error, 'No se pudo leer el estado de OpenClaw');
  }
});

router.get('/native-session', async (req, res) => {
  try {
    const session = await getOpenClawNativeSession(req.user);
    res.json({ session });
  } catch (error) {
    console.error('[openclaw] native session error:', error);
    respondWithError(res, error, 'No se pudo abrir la interfaz nativa de OpenClaw');
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    const status = await bootstrapOpenClawWorkspace(req.user);
    res.json({ status });
  } catch (error) {
    if (error?.code === 'plan_locked') {
      console.warn('[openclaw] bootstrap blocked by plan:', req.user?.id);
    } else {
      console.error('[openclaw] bootstrap error:', error);
    }
    respondWithError(res, error, 'No se pudo preparar el workspace OpenClaw');
  }
});

module.exports = router;
