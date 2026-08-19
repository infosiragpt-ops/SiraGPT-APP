/**
 * /api/compute — public HTTP wrapper over the internal code-sandbox.
 *
 * Exposes the same isolated subprocess executor used by AgentCoder to
 * the math solver (and, in the future, to the chat tool-use surface).
 * This is still NOT a general-purpose "run any user code" endpoint —
 * authenticated users only, short timeouts, memory-capped, output
 * truncated. Network is not kernel-blocked; we rely on the stripped
 * env + short TTL to make that acceptable for short SymPy / NumPy /
 * SciPy / Pandas calculations.
 *
 * Intended caller: the math-solver service, which generates the code
 * from the user's brief and posts it here for execution. End-users do
 * not paste code directly.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { run } = require('../services/agents/code-sandbox');

const router = express.Router();
router.use(authenticateToken);

const MAX_TIMEOUT_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 10_000;

router.post(
  '/run',
  [
    body('language').isIn(['python', 'javascript', 'node']),
    body('source').isString().isLength({ min: 1, max: 40_000 }),
    body('timeoutMs').optional().isInt({ min: 100, max: MAX_TIMEOUT_MS }),
    body('stdin').optional().isString().isLength({ max: 10_000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const result = await run({
        language: req.body.language,
        source: req.body.source,
        timeoutMs: Math.min(req.body.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        stdin: req.body.stdin || '',
      });
      res.json(result);
    } catch (err) {
      console.error('[compute] run error:', err?.message || err);
      res.status(500).json({ error: err?.message || 'execution failed' });
    }
  }
);

module.exports = router;
