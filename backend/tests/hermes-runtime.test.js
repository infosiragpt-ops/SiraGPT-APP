'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cronBridge = require('../src/services/agents/cron/hermes-cron-bridge');
const { createHermesGateway, resolveHermesGatewayConfig } = require('../src/services/agents/hermes-gateway-bridge');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const { runHermesCommand, listCommands } = require('../src/services/agents/hermes-cli-bridge');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');
const {
  bootHermesRuntime,
  shutdownHermesRuntime,
  getHermesRuntimeStatus,
} = require('../src/services/agents/hermes-runtime');

test('cron bridge normalizes Hermes interval aliases to cron', () => {
  assert.equal(cronBridge.normalizeSchedule('1h'), '0 * * * *');
  assert.equal(cronBridge.normalizeSchedule('0 9 * * *'), '0 9 * * *');
});

test('cron bridge status reports scheduler state', () => {
  const status = cronBridge.status();
  assert.equal(typeof status.totalJobs, 'number');
  assert.equal(typeof status.enabled, 'boolean');
});

test('gateway bridge resolves config and lists platforms', () => {
  const config = resolveHermesGatewayConfig({ HERMES_GATEWAY_ENABLED: '1', OPENCLAW_ENABLED: '0' });
  assert.equal(config.enabled, false);
  const gateway = createHermesGateway({ env: { HERMES_GATEWAY_ENABLED: '1', OPENCLAW_ENABLED: '1', OPENCLAW_API_KEY: 'test' } });
  assert.ok(gateway.listPlatforms().length >= 1);
});

test('memory bridge remembers and recalls facts', () => {
  const userId = 'hermes-test-user';
  memoryBridge.remember(userId, 'Prefiere respuestas en español', { category: 'language' });
  const hits = memoryBridge.recall(userId, 'español');
  assert.ok(Array.isArray(hits));
});

test('memory bridge searches sessions without throwing', () => {
  const hits = memoryBridge.searchSessions('hermes-test-user', 'hola mundo');
  assert.ok(Array.isArray(hits));
});

test('cli bridge exposes Hermes commands', () => {
  assert.ok(listCommands().includes('doctor'));
  const doctor = runHermesCommand('doctor');
  assert.equal(doctor.command, 'doctor');
  assert.equal(typeof doctor.ok, 'boolean');
});

test('hermes tools include core Hermes tool names', () => {
  const names = new Set(buildHermesTools().map((t) => t.name));
  for (const expected of ['cronjob', 'send_message', 'session_search', 'memory', 'delegate_task']) {
    assert.ok(names.has(expected), `missing tool ${expected}`);
  }
});

test('hermes runtime boots and reports status', () => {
  const prev = process.env.HERMES_RUNTIME_DISABLED;
  delete process.env.HERMES_RUNTIME_DISABLED;
  shutdownHermesRuntime();
  const boot = bootHermesRuntime();
  assert.equal(boot.booted, true);
  const status = getHermesRuntimeStatus();
  assert.equal(status.booted, true);
  assert.ok(status.cliCommands.includes('gateway'));
  shutdownHermesRuntime();
  if (prev) process.env.HERMES_RUNTIME_DISABLED = prev;
});

test('hermes runtime respects disable flag', () => {
  process.env.HERMES_RUNTIME_DISABLED = '1';
  shutdownHermesRuntime();
  const boot = bootHermesRuntime();
  assert.equal(boot.booted, false);
  delete process.env.HERMES_RUNTIME_DISABLED;
});

test('plugin bridge lists Hermes plugin catalog', () => {
  const pluginBridge = require('../src/services/agents/hermes-plugin-bridge');
  const plugins = pluginBridge.listHermesPlugins();
  assert.ok(plugins.length >= 5);
  assert.ok(plugins.some((p) => p.id === 'hermes-memory'));
});

test('optional skills bridge searches upstream catalog', () => {
  const optionalSkillsBridge = require('../src/services/agents/hermes-optional-skills-bridge');
  const hits = optionalSkillsBridge.searchOptionalSkills('debugging');
  assert.ok(Array.isArray(hits));
});

test('tui bridge handles slash commands', async () => {
  const { executeSlashCommand, parseSlashInput } = require('../src/services/agents/hermes-tui-bridge');
  assert.equal(parseSlashInput('/model gpt-4o').command, 'model');
  const result = await executeSlashCommand('/doctor', { userId: 'tui-user' });
  assert.equal(result.handled, true);
});

test('docker bridge lists Hermes backends', () => {
  const dockerBridge = require('../src/services/agents/hermes-docker-bridge');
  const backends = dockerBridge.listBackends();
  assert.ok(backends.some((b) => b.id === 'local'));
});

test('agent bridge reports capabilities', () => {
  const agentBridge = require('../src/services/agents/hermes-agent-bridge');
  const caps = agentBridge.getAgentCapabilities();
  assert.ok(caps.toolsets.includes('core'));
  assert.ok(caps.hermesTools.includes('cronjob'));
});

test('agent bridge compresses conversation deterministically', async () => {
  const agentBridge = require('../src/services/agents/hermes-agent-bridge');
  const report = await agentBridge.compressConversation({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  });
  assert.ok(report.messages.length >= 2);
});

test('runtime status includes new integrated subsystems', () => {
  shutdownHermesRuntime();
  bootHermesRuntime();
  const status = getHermesRuntimeStatus();
  assert.ok(status.plugins);
  assert.ok(status.optionalSkills);
  assert.ok(status.agent);
  assert.ok(Array.isArray(status.environments));
  assert.ok(status.extensionCatalog);
  assert.ok(status.extensionCatalog.counts.providers >= 30);
  shutdownHermesRuntime();
});
