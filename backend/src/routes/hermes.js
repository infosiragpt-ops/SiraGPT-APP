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
const toolsetRegistry = require('../services/agents/toolset-registry');

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

module.exports = router;
