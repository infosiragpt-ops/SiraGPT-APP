'use strict';

/**
 * Hermes agent tools — Hermes-compatible tool surface for SiraGPT agents.
 * Names mirror Hermes core tools; handlers delegate to native bridges.
 */

const cronBridge = require('./cron/hermes-cron-bridge');
const { getHermesGateway } = require('./hermes-gateway-bridge');
const memoryBridge = require('./hermes-memory-bridge');
const delegateBridge = require('./hermes-delegate-bridge');
const toolsetRegistry = require('./toolset-registry');
const skillsRegistry = require('../skills-registry');
const { buildHermesIntegrationMap, recommendAdaptedPlaybooks } = require('./hermes-playbook-bridge');

function ctxUser(ctx) {
  return ctx?.userId || ctx?.user?.id || null;
}

const hermesCronjobTool = {
  name: 'cronjob',
  description: 'Create, list, trigger, pause, or resume Hermes-style scheduled agent jobs.',
  parameters: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'trigger', 'pause', 'resume', 'remove'] },
      schedule: { type: 'string', description: 'Cron expression or Hermes interval alias (1h, 1d, 5m).' },
      prompt: { type: 'string' },
      jobId: { type: 'string' },
      thinking: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
  async execute(args, ctx = {}) {
    const userId = ctxUser(ctx);
    if (!userId) return { ok: false, error: 'userId required' };

    switch (args.action) {
      case 'create':
        return { ok: true, job: cronBridge.createJob({ userId, schedule: args.schedule, prompt: args.prompt, thinking: args.thinking }) };
      case 'list':
        return { ok: true, jobs: cronBridge.listJobs({ userId }) };
      case 'trigger':
        return { ok: true, ...(await cronBridge.triggerJob(args.jobId)) };
      case 'pause':
        return { ok: true, ...cronBridge.pauseJob(args.jobId, userId) };
      case 'resume':
        return { ok: true, ...cronBridge.resumeJob(args.jobId, userId) };
      case 'remove':
        return { ok: true, ...cronBridge.removeJob(args.jobId, userId) };
      default:
        return { ok: false, error: 'invalid action' };
    }
  },
};

const hermesSendMessageTool = {
  name: 'send_message',
  description: 'Send a message to an external channel via the Hermes/OpenClaw gateway bridge.',
  parameters: {
    type: 'object',
    required: ['channel', 'text'],
    properties: {
      channel: { type: 'string' },
      text: { type: 'string' },
    },
  },
  async execute(args, ctx = {}) {
    return getHermesGateway().sendMessage({ ...args, userId: ctxUser(ctx) });
  },
};

const hermesSessionSearchTool = {
  name: 'session_search',
  description: 'Search prior session messages for cross-session recall (Hermes FTS-style heuristic).',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    },
  },
  async execute(args, ctx = {}) {
    const userId = ctxUser(ctx);
    if (!userId) return { ok: false, error: 'userId required' };
    return {
      ok: true,
      hits: memoryBridge.searchSessions(userId, args.query, { limit: args.limit || 10 }),
    };
  },
};

const hermesMemoryTool = {
  name: 'memory',
  description: 'Remember or recall persistent user facts using the Hermes memory bridge.',
  parameters: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['remember', 'recall', 'promote', 'nudge'] },
      fact: { type: 'string' },
      query: { type: 'string' },
      entryId: { type: 'string' },
    },
  },
  async execute(args, ctx = {}) {
    const userId = ctxUser(ctx);
    if (!userId) return { ok: false, error: 'userId required' };

    switch (args.action) {
      case 'remember':
        return { ok: true, entry: memoryBridge.remember(userId, args.fact) };
      case 'recall':
        return { ok: true, entries: memoryBridge.recall(userId, args.query) };
      case 'promote':
        return { ok: true, entry: memoryBridge.promote(userId, args.entryId) };
      case 'nudge':
        return { ok: true, ...memoryBridge.nudgePromotion(userId) };
      default:
        return { ok: false, error: 'invalid action' };
    }
  },
};

const hermesDelegateTool = {
  name: 'delegate_task',
  description: 'Spawn an isolated Hermes-style subagent for parallel work.',
  parameters: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string' },
      mode: { type: 'string', enum: ['sync', 'async'] },
      thinking: { type: 'string', enum: ['low', 'medium', 'high'] },
      parentTaskId: { type: 'string' },
    },
  },
  async execute(args, ctx = {}) {
    const userId = ctxUser(ctx);
    if (!userId) return { ok: false, error: 'userId required' };
    return delegateBridge.delegateTask({
      userId,
      prompt: args.prompt,
      mode: args.mode || 'async',
      thinking: args.thinking || 'low',
      parentTaskId: args.parentTaskId || ctx.taskId || null,
      depth: ctx.depth || 0,
    });
  },
};

const hermesSkillsListTool = {
  name: 'skills_list',
  description: 'List registered SiraGPT/Hermes-adapted skills.',
  parameters: { type: 'object', properties: { category: { type: 'string' } } },
  async execute(args) {
    return {
      ok: true,
      skills: skillsRegistry.listSkills({ category: args.category, limit: 100 }).map((s) => ({
        id: s.id,
        label: s.label,
        category: s.category,
      })),
    };
  },
};

const hermesToolsetTool = {
  name: 'toolset_resolve',
  description: 'Resolve a Hermes-style toolset id to concrete SiraGPT tool names.',
  parameters: {
    type: 'object',
    required: ['toolset'],
    properties: { toolset: { type: 'string' } },
  },
  async execute(args) {
    const tools = toolsetRegistry.resolveToolset(args.toolset);
    return { ok: true, toolset: args.toolset, tools };
  },
};

const hermesPlaybookMapTool = {
  name: 'hermes_playbook_map',
  description: 'Return the Hermes→SiraGPT integration matrix or playbook recommendations.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
  },
  async execute(args) {
    if (args.query) {
      return { ok: true, recommendations: recommendAdaptedPlaybooks(args.query) };
    }
    return { ok: true, matrix: buildHermesIntegrationMap() };
  },
};

function buildHermesTools() {
  return [
    hermesCronjobTool,
    hermesSendMessageTool,
    hermesSessionSearchTool,
    hermesMemoryTool,
    hermesDelegateTool,
    hermesSkillsListTool,
    hermesToolsetTool,
    hermesPlaybookMapTool,
  ];
}

module.exports = {
  buildHermesTools,
  hermesCronjobTool,
  hermesSendMessageTool,
  hermesSessionSearchTool,
  hermesMemoryTool,
  hermesDelegateTool,
};
