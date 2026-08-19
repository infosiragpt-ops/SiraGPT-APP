'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const turnPolicy = require('../src/services/turn-policy');
const cognitiveMetrics = require('../src/services/cognitive-metrics');

test('resolveTurnPolicyMode defaults to observe and can turn off', () => {
  assert.equal(turnPolicy.resolveTurnPolicyMode({}), 'observe');
  assert.equal(turnPolicy.resolveTurnPolicyMode({ SIRAGPT_TURN_POLICY: 'observe' }), 'observe');
  assert.equal(turnPolicy.resolveTurnPolicyMode({ SIRAGPT_TURN_POLICY: 'enforce' }), 'enforce');
  assert.equal(turnPolicy.resolveTurnPolicyMode({ SIRAGPT_TURN_POLICY: '0' }), 'off');
  assert.equal(turnPolicy.resolveTurnPolicyMode({ SIRAGPT_TURN_POLICY: 'off' }), 'off');
});

test('buildTurnPolicy returns null when mode is off', () => {
  const policy = turnPolicy.buildTurnPolicy({
    env: { SIRAGPT_TURN_POLICY: 'off' },
    model: 'gpt-4o-mini',
  });
  assert.equal(policy, null);
});

test('buildTurnPolicy consolidates routing/capability/tool fields', () => {
  const policy = turnPolicy.buildTurnPolicy({
    env: {
      SIRAGPT_TURN_POLICY: 'observe',
      SIRAGPT_PROMPTED_MAX_STEPS: '8',
      SIRAGPT_PROMPTED_MAX_TOOLS: '6',
      SIRAGPT_TOOL_DEFER: '1',
      SIRAGPT_MEDIA_TOOLS_ALWAYS: '0',
    },
    model: 'llama-3.1-8b',
    provider: 'Cerebras',
    plan: 'PRO',
    toolCallMode: 'prompted',
    cognitiveDecision: {
      intent: { primary: 'search' },
      difficulty: { bucket: 'moderate', hasCode: false },
      risk: { level: 'low' },
      routing: { action: 'keep', selectedModel: 'llama-3.1-8b' },
    },
    routing: {
      shouldRunAgentic: true,
      disabledReason: null,
    },
    capabilities: {
      toolCallMode: 'prompted',
      supportsNativeTools: false,
      supportsImages: false,
    },
    tools: {
      hasFiles: true,
      hasCode: false,
      requiredTools: ['web_search'],
    },
    skills: {
      clearance: 'user',
      recommendedSkillIds: ['research'],
    },
    reasons: ['routing:agentic'],
  });

  assert.equal(policy.version, turnPolicy.TURN_POLICY_VERSION);
  assert.equal(policy.mode, 'observe');
  assert.equal(policy.routing.shouldRunAgentic, true);
  assert.equal(policy.routing.difficultyBucket, 'moderate');
  assert.equal(policy.capabilities.toolCallMode, 'prompted');
  assert.equal(policy.tools.promptedMaxSteps, 8);
  assert.equal(policy.tools.promptedMaxTools, 6);
  assert.equal(policy.tools.deferEnabled, true);
  assert.equal(policy.tools.mediaAlways, false);
  assert.equal(policy.tools.hasFiles, true);
  assert.deepEqual(policy.skills.recommendedSkillIds, ['research']);
  assert.deepEqual(policy.telemetry.reasons, ['routing:agentic']);
});

test('summarizeTurnPolicy returns a compact telemetry shape', () => {
  const policy = turnPolicy.buildTurnPolicy({
    model: 'gpt-4o',
    provider: 'OpenAI',
    toolCallMode: 'native',
    routing: { shouldRunAgentic: false, disabledReason: 'images_attached' },
    capabilities: { toolCallMode: 'native', supportsImages: true },
  });
  const summary = turnPolicy.summarizeTurnPolicy(policy);
  assert.equal(summary.shouldRunAgentic, false);
  assert.equal(summary.disabledReason, 'images_attached');
  assert.equal(summary.toolCallMode, 'native');
  assert.equal(summary.model, 'gpt-4o');
});

test('diffTurnPolicyAgainstRuntime records prompted step overruns', () => {
  const policy = turnPolicy.buildTurnPolicy({
    model: 'llama-3.1-8b',
    provider: 'Cerebras',
    capabilities: { toolCallMode: 'prompted' },
    tools: { promptedMaxSteps: 10 },
  });
  const diffs = turnPolicy.diffTurnPolicyAgainstRuntime(policy, {
    toolCallMode: 'prompted',
    model: 'llama-3.1-8b',
    provider: 'Cerebras',
    maxSteps: 24,
  });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, 'promptedMaxSteps');
  assert.equal(policy.telemetry.shadowDiffs.length, 1);
});

test('cognitive metrics recordTurnPolicy is bounded and resettable', () => {
  cognitiveMetrics.reset();
  const policy = turnPolicy.buildTurnPolicy({
    model: 'gpt-4o-mini',
    provider: 'OpenAI',
    routing: { shouldRunAgentic: true },
    capabilities: { toolCallMode: 'native' },
  });
  policy.telemetry.shadowDiffs = [{ field: 'toolCallMode', expected: 'native', actual: 'prompted' }];
  cognitiveMetrics.recordTurnPolicy(policy);
  const snap = cognitiveMetrics.snapshot();
  assert.equal(snap.turnPolicy.total, 1);
  assert.equal(snap.turnPolicy.agentic, 1);
  assert.equal(snap.turnPolicy.shadowDiffs, 1);
  assert.equal(snap.turnPolicy.byToolCallMode.native, 1);
  const prom = cognitiveMetrics.toPrometheusText();
  assert.match(prom, /sira_cognitive_turn_policy_total/);
  cognitiveMetrics.reset();
  assert.equal(cognitiveMetrics.snapshot().turnPolicy.total, 0);
});
