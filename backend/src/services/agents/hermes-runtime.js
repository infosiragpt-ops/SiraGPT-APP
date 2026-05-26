'use strict';

/**
 * Hermes runtime — boots the full Hermes-compatible layer inside SiraGPT.
 *
 * Called from backend/index.js on server start. All modules are native JS;
 * no Python subprocess required.
 */

const cronBridge = require('./cron/hermes-cron-bridge');
const { getHermesGateway } = require('./hermes-gateway-bridge');
const memoryBridge = require('./hermes-memory-bridge');
const delegateBridge = require('./hermes-delegate-bridge');
const pluginBridge = require('./hermes-plugin-bridge');
const optionalSkillsBridge = require('./hermes-optional-skills-bridge');
const agentBridge = require('./hermes-agent-bridge');
const dockerBridge = require('./hermes-docker-bridge');
const { runHermesCommand, listCommands } = require('./hermes-cli-bridge');
const { buildHermesIntegrationMap } = require('./hermes-playbook-bridge');
const toolsetRegistry = require('./toolset-registry');

let _booted = false;
let _gcTimer = null;
let _pluginBoot = null;

function isDisabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.HERMES_RUNTIME_DISABLED || '').toLowerCase());
}

function bootHermesRuntime(opts = {}) {
  if (_booted) return getHermesRuntimeStatus();
  if (isDisabled()) {
    return { booted: false, reason: 'HERMES_RUNTIME_DISABLED' };
  }

  const gateway = getHermesGateway(opts);
  delegateBridge.registry.startGcLoop();

  _pluginBoot = pluginBridge.bootHermesPlugins(opts).catch((err) => {
    console.warn('[hermes-runtime] plugin boot failed:', err?.message || err);
    return { registered: [], skipped: [], total: 0, error: err?.message };
  });

  const tickMs = Number.parseInt(process.env.HERMES_CRON_TICK_MS || '0', 10);
  if (tickMs > 0) {
    _gcTimer = setInterval(() => {
      cronBridge.tick().catch((err) => {
        console.warn('[hermes-runtime] cron tick failed:', err?.message || err);
      });
    }, tickMs);
    if (_gcTimer.unref) _gcTimer.unref();
  }

  _booted = true;
  console.log('[hermes-runtime] booted — gateway=%s cron=%s delegate=%s plugins=%s',
    gateway.config.enabled ? 'on' : 'degraded',
    cronBridge.status().enabled ? 'on' : 'off',
    delegateBridge.status().total,
    pluginBridge.HERMES_PLUGIN_CATALOG.length);

  return getHermesRuntimeStatus();
}

function shutdownHermesRuntime() {
  if (_gcTimer) {
    clearInterval(_gcTimer);
    _gcTimer = null;
  }
  _booted = false;
}

function getHermesRuntimeStatus() {
  return {
    booted: _booted,
    disabled: isDisabled(),
    version: 'hermes-runtime-siragpt-2026-05',
    upstream: buildHermesIntegrationMap().source,
    cron: cronBridge.status(),
    gateway: getHermesGateway().status(),
    memory: memoryBridge.status(),
    delegate: delegateBridge.status(),
    plugins: pluginBridge.status(),
    optionalSkills: optionalSkillsBridge.status(),
    agent: agentBridge.getAgentCapabilities(),
    environments: dockerBridge.listBackends(),
    toolsets: toolsetRegistry.listToolsets().length,
    cliCommands: listCommands(),
  };
}

module.exports = {
  bootHermesRuntime,
  shutdownHermesRuntime,
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
};
