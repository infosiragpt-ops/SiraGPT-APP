'use strict';

/**
 * Hermes CLI bridge — maps Hermes CLI commands to SiraGPT backend operations.
 *
 * Hermes: hermes model | tools | skills | cron | gateway | doctor
 * SiraGPT: same semantics via HTTP/JS without Python runtime.
 */

const toolsetRegistry = require('./toolset-registry');
const skillsRegistry = require('../skills-registry');
const { buildHermesIntegrationMap } = require('./hermes-playbook-bridge');
const cronBridge = require('./cron/hermes-cron-bridge');
const { getHermesGateway } = require('./hermes-gateway-bridge');
const memoryBridge = require('./hermes-memory-bridge');
const delegateBridge = require('./hermes-delegate-bridge');

const COMMAND_HANDLERS = Object.freeze({
  model(ctx = {}) {
    return {
      command: 'model',
      defaultModel: process.env.SIRAGPT_DEFAULT_MODEL || 'gpt-4o',
      freeTierModel: process.env.FREE_IA_MODEL_ID || 'llama-3.1-8b',
      providers: ['OpenAI', 'Anthropic', 'Cerebras', 'OpenRouter'],
      userModel: ctx.model || null,
    };
  },

  tools() {
    return {
      command: 'tools',
      toolsets: toolsetRegistry.listToolsets(),
      defaultToolset: 'core',
    };
  },

  skills() {
    return {
      command: 'skills',
      skills: skillsRegistry.listSkills({ limit: 100 }).map((s) => ({
        id: s.id,
        label: s.label,
        category: s.category,
        clearance: s.clearance,
      })),
    };
  },

  cron(ctx = {}) {
    return {
      command: 'cron',
      status: cronBridge.status(),
      jobs: ctx.userId ? cronBridge.listJobs({ userId: ctx.userId }) : [],
    };
  },

  gateway() {
    return {
      command: 'gateway',
      ...getHermesGateway().status(),
      platforms: getHermesGateway().listPlatforms(),
    };
  },

  map() {
    return {
      command: 'map',
      matrix: buildHermesIntegrationMap(),
    };
  },

  memory(ctx = {}) {
    return {
      command: 'memory',
      status: memoryBridge.status(ctx.userId),
    };
  },

  delegate() {
    return {
      command: 'delegate',
      status: delegateBridge.status(),
    };
  },

  doctor() {
    const cron = cronBridge.status();
    const gateway = getHermesGateway().status();
    const delegate = delegateBridge.status();
    const issues = [];

    if (!cron.enabled) issues.push({ level: 'warn', code: 'cron_disabled', message: 'AGENT_SCHEDULER=off disables scheduled jobs' });
    if (!gateway.enabled) issues.push({ level: 'info', code: 'gateway_degraded', message: 'Enable OPENCLAW_ENABLED + OPENCLAW_API_KEY for external delivery' });
    if (!process.env.OPENAI_API_KEY) issues.push({ level: 'error', code: 'missing_openai_key', message: 'OPENAI_API_KEY not configured' });

    return {
      command: 'doctor',
      ok: issues.every((i) => i.level !== 'error'),
      issues,
      subsystems: { cron, gateway, delegate },
    };
  },
});

function runHermesCommand(command, ctx = {}) {
  const key = String(command || '').trim().toLowerCase();
  const handler = COMMAND_HANDLERS[key];
  if (!handler) {
    return {
      ok: false,
      reason: 'unknown_command',
      available: Object.keys(COMMAND_HANDLERS),
    };
  }
  return { ok: true, ...handler(ctx) };
}

function listCommands() {
  return Object.keys(COMMAND_HANDLERS);
}

module.exports = {
  COMMAND_HANDLERS,
  runHermesCommand,
  listCommands,
};
