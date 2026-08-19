/**
 * /api/agent/keys — manage agent API keys.
 *
 * All endpoints require JWT (the owner). Key-based callers cannot
 * manage keys — that would create a privilege-escalation path.
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const keys = require('../services/agent-access/keys');

const router = express.Router();

router.use(authenticateToken);

/** POST /keys — mint a new key. Secret shown once. */
router.post(
  '/',
  [
    body('label').isString().isLength({ min: 1, max: 80 }),
    body('scope').optional().isObject(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const out = keys.createKey({
      userId: req.user.id,
      label: req.body.label,
      scope: req.body.scope || {},
    });
    res.status(201).json(out);
  }
);

/** GET /keys — list user's keys (no secrets). */
router.get('/', (req, res) => {
  res.json({ keys: keys.listKeys(req.user.id) });
});

/** POST /keys/:id/revoke — revoke a key. */
router.post('/:id/revoke', param('id').isString(), (req, res) => {
  const out = keys.revokeKey({ userId: req.user.id, id: req.params.id });
  if (!out.ok) return res.status(404).json({ error: out.reason });
  res.json({ revoked: true });
});

/** GET /keys/:id/pending — see the pending pairing for this key, if any. */
router.get('/:id/pending', param('id').isString(), (req, res) => {
  const pending = keys.listPendingPair({ userId: req.user.id, id: req.params.id });
  res.json({ pending });
});

/** POST /keys/:id/pair/:code — approve a pending pairing. */
router.post(
  '/:id/pair/:code',
  [param('id').isString(), param('code').isString().isLength({ min: 4, max: 16 })],
  (req, res) => {
    const out = keys.approvePairing({
      userId: req.user.id, id: req.params.id, code: req.params.code,
    });
    if (!out.ok) return res.status(400).json({ error: out.reason });
    res.json({ approved: true });
  }
);

/** POST /keys/:id/revoke-pair — revoke a previously-approved principal. */
router.post(
  '/:id/revoke-pair',
  [param('id').isString(), body('principalHash').isString()],
  (req, res) => {
    const out = keys.revokePairing({
      userId: req.user.id, id: req.params.id, principalHash: req.body.principalHash,
    });
    if (!out.ok) return res.status(404).json({ error: out.reason });
    res.json({ revoked: true });
  }
);

module.exports = router;
