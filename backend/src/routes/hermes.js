'use strict';

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');
const {
  getHermesRuntimeStatus,
  runHermesCommand,
  cronBridge,
  getHermesGateway,
  memoryBridge,
  delegateBridge,
  pluginBridge,
  optionalSkillsBridge,
  agentBridge,
  dockerBridge,
} = require('../services/agents/hermes-runtime');
const { executeSlashCommand, listSlashCommands } = require('../services/agents/hermes-tui-bridge');
const { buildHermesIntegrationMap, recommendAdaptedPlaybooks } = require('../services/agents/hermes-playbook-bridge');
const {
  buildOpenClawIntegrationMap,
  recommendAdaptedPlaybooks: recommendOpenClawPlaybooks,
} = require('../services/agents/openclaw-playbook-bridge');
const toolsetRegistry = require('../services/agents/toolset-registry');

// ── Session rewind store ───────────────────────────────────────────────────
// Adapted from Hermes Agent (MIT):
//   feat(state): add messages.active flag + rewind primitives (#21910)
//   feat(undo): /undo [N] backs up N user turns with prefill + soft-delete
//
// Hermes uses a per-message `active` boolean in its SQLite state store.
// SiraGPT's message store is Prisma-backed and schema changes require
// migrations, so we implement a lightweight in-memory rewind registry that
// records how many turns have been soft-deleted per session.
//
// The registry is consulted by GET /messages/rewind-state so the frontend
// or agent layer can skip the rewound turns when building context.  The
// active-memory etag mechanism in backend/src/memory/active.ts will
// naturally see a shorter history on the next request and rebuild its
// snapshot — no extra cache-busting needed.
//
// The store is intentionally ephemeral (process-lifetime).  If the server
// restarts, the rewind count resets — which is safe: the messages are still
// in the DB; they're just logically re-included.  Persistent rewind can be
// wired to Prisma later without API changes.

const _rewindStore = new Map(); // sessionId → { rewindCount, rewoundAt }

const MAX_REWIND = 20; // maximum turns undoable in a single session

function getRewindState(sessionId) {
  return _rewindStore.get(sessionId) || { rewindCount: 0, rewoundAt: null };
}

function applyRewind(sessionId, n) {
  const current = getRewindState(sessionId);
  const next = Math.min(current.rewindCount + n, MAX_REWIND);
  _rewindStore.set(sessionId, { rewindCount: next, rewoundAt: new Date().toISOString() });
  return getRewindState(sessionId);
}

function clearRewind(sessionId) {
  _rewindStore.delete(sessionId);
  return { rewindCount: 0, rewoundAt: null };
}

const router = express.Router();

router.get('/health', optionalAuth, (_req, res) => {
  res.json(getHermesRuntimeStatus());
});

router.get('/map', optionalAuth, (_req, res) => {
  res.json(buildHermesIntegrationMap());
});

router.get('/map/recommend', optionalAuth, (req, res) => {
  const query = String(req.query.q || req.query.query || '').trim();
  res.json({ query, recommendations: recommendAdaptedPlaybooks(query) });
});

// OpenClaw integration map — parity with the Hermes map routes above. The
// openclaw-playbook-bridge was previously reachable only from a CLI script +
// test; these read-only endpoints expose it at runtime like its Hermes twin.
router.get('/openclaw/map', optionalAuth, (_req, res) => {
  res.json(buildOpenClawIntegrationMap());
});

router.get('/openclaw/map/recommend', optionalAuth, (req, res) => {
  const query = String(req.query.q || req.query.query || '').trim();
  res.json({ query, recommendations: recommendOpenClawPlaybooks(query) });
});

router.get('/toolsets', optionalAuth, (_req, res) => {
  res.json({ toolsets: toolsetRegistry.listToolsets() });
});

router.get('/toolsets/:id', optionalAuth, (req, res) => {
  const toolset = toolsetRegistry.getToolset(req.params.id);
  if (!toolset) return res.status(404).json({ error: 'toolset_not_found' });
  return res.json(toolset);
});

router.get('/cli', optionalAuth, (_req, res) => {
  const { listCommands } = require('../services/agents/hermes-cli-bridge');
  res.json({ commands: listCommands() });
});

router.get('/cli/:command', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.query.userId || null;
  res.json(runHermesCommand(req.params.command, { userId, model: req.query.model || null }));
});

router.get('/cron/jobs', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ jobs: cronBridge.listJobs({ userId }) });
});

router.post('/cron/jobs', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const job = cronBridge.createJob({
      userId,
      schedule: req.body.schedule || req.body.cron,
      prompt: req.body.prompt,
      thinking: req.body.thinking,
      delivery: req.body.delivery,
      timezone: req.body.timezone,
    });
    res.status(201).json({ job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/cron/jobs/:id/trigger', optionalAuth, async (req, res) => {
  res.json(await cronBridge.triggerJob(req.params.id, { payload: req.body?.payload || null }));
});

router.delete('/cron/jobs/:id', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.query.userId || null;
  res.json(cronBridge.removeJob(req.params.id, userId));
});

router.get('/gateway/status', optionalAuth, (_req, res) => {
  res.json(getHermesGateway().status());
});

router.post('/gateway/inbound', optionalAuth, async (req, res) => {
  res.json(await getHermesGateway().handleInboundMessage(req.body || {}));
});

router.post('/gateway/send', optionalAuth, async (req, res) => {
  res.json(await getHermesGateway().sendMessage(req.body || {}));
});

router.post('/memory/recall', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ entries: memoryBridge.recall(userId, req.body?.query || '') });
});

router.post('/memory/search-sessions', optionalAuth, (req, res) => {
  const userId = req.user?.id || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ hits: memoryBridge.searchSessions(userId, req.body?.query || '', { limit: req.body?.limit }) });
});

router.post('/delegate', optionalAuth, async (req, res) => {
  const userId = req.user?.id || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json(await delegateBridge.delegateTask({ ...req.body, userId }));
});

router.get('/delegate', optionalAuth, (req, res) => {
  res.json({ subagents: delegateBridge.listSubagents({ parentId: req.query.parentId || null }) });
});

router.get('/plugins', optionalAuth, (_req, res) => {
  res.json(pluginBridge.status());
});

router.get('/optional-skills', optionalAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(q
    ? { hits: optionalSkillsBridge.searchOptionalSkills(q) }
    : optionalSkillsBridge.status());
});

router.get('/optional-skills/:id', optionalAuth, (req, res) => {
  res.json(optionalSkillsBridge.activateOptionalSkill(req.params.id));
});

router.post('/agent/run', optionalAuth, async (req, res) => {
  const userId = req.user?.id || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const result = await agentBridge.runTurn({ ...req.body, userId });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/agent/compress', optionalAuth, async (req, res) => {
  try {
    const report = await agentBridge.compressConversation(req.body || {});
    res.json({ ok: true, report });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/agent/capabilities', optionalAuth, (_req, res) => {
  res.json(agentBridge.getAgentCapabilities());
});

router.get('/tui/commands', optionalAuth, (_req, res) => {
  res.json({ commands: listSlashCommands() });
});

router.post('/tui/slash', optionalAuth, async (req, res) => {
  const userId = req.user?.id || req.body?.userId || null;
  res.json(await executeSlashCommand(req.body?.input || req.body?.command || '', {
    userId,
    sessionId: req.body?.sessionId,
    messages: req.body?.messages,
    model: req.body?.model,
  }));
});

router.get('/environments', optionalAuth, (_req, res) => {
  res.json({ backends: dockerBridge.listBackends(), profile: dockerBridge.getSandboxProfile() });
});

router.get('/environments/health', optionalAuth, async (_req, res) => {
  res.json(await dockerBridge.healthCheck());
});

// ── Message rewind / undo ──────────────────────────────────────────────────
// Adapted from Hermes Agent (MIT):
//   feat(state): add messages.active flag + rewind primitives (#21910)
//   feat(undo): /undo [N] backs up N user turns with prefill + soft-delete

/**
 * GET /api/hermes/messages/rewind-state?sessionId=<id>
 * Returns the current rewind state for a session.
 * Consumers (agent context builders, chat routes) can use `rewindCount` to
 * trim the last N user+assistant turn pairs from the history they send to
 * the LLM.
 */
router.get('/messages/rewind-state', optionalAuth, (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  return res.json({ sessionId, ...getRewindState(sessionId) });
});

/**
 * POST /api/hermes/messages/undo
 * Body: { sessionId: string, n?: number }
 *
 * Soft-deletes the last `n` user+assistant turn pairs (default: 1) for the
 * given session by incrementing the session's rewindCount.  The LLM context
 * builder should subtract `rewindCount` turn pairs from the tail of the
 * history before sending to the model.
 *
 * Mirrors Hermes `/undo [N]` — backs up N user turns with soft-delete.
 * Max rewind per session is capped at MAX_REWIND (20) to prevent
 * accidentally emptying the context.
 */
router.post('/messages/undo', optionalAuth, (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const n = Math.max(1, Math.min(Number.parseInt(req.body?.n || '1', 10) || 1, MAX_REWIND));
  const state = applyRewind(sessionId, n);
  return res.json({ ok: true, sessionId, ...state, appliedN: n });
});

/**
 * POST /api/hermes/messages/undo/clear
 * Body: { sessionId: string }
 *
 * Clears the rewind state for a session (equivalent to Hermes /new which
 * resets the active-message cursor back to head).
 */
router.post('/messages/undo/clear', optionalAuth, (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const state = clearRewind(sessionId);
  return res.json({ ok: true, sessionId, ...state });
});

/**
 * POST /api/hermes/cron/scan
 * Body: { text: string }
 *
 * Two-tier scheduling-intent classifier endpoint.
 * Exposes the hermes-cron-scanner for external callers (chat middleware,
 * agent skill handlers) that need to decide whether to attempt LLM-based
 * schedule extraction before spending tokens.
 *
 * Returns: { isSchedulingIntent, tier1, tier2, hints? }
 */
router.post('/cron/scan', optionalAuth, (req, res) => {
  const text = String(req.body?.text || '');
  if (!text) return res.status(400).json({ error: 'text required' });
  const result = cronBridge.parseNaturalLanguageJob(text);
  return res.json(result);
});

module.exports = router;
