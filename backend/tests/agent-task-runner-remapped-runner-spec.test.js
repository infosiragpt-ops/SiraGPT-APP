'use strict';

// A model with no direct runtime is remapped to DeepSeek. The runner must
// follow that resolved runtime rather than hand its preflight an unresolved spec.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY', 'XAI_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY', 'CEREBRAS_API_KEY',
  'SIRAGPT_AGENT_RUNNER_MODEL', 'SIRAGPT_DOC_AGENT_MODEL', 'OPENROUTER_MODEL',
  'AGENT_TASK_OPENAI_MODEL', 'AGENT_TASK_RUNTIME_MODEL', 'NODE_ENV',
];

function withDeepSeekOnly(fn) {
  const restore = rememberEnv(ENV_KEYS);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  // Not a placeholder (doc-agent/llm-runtime PLACEHOLDER_KEY_RE): counts as configured.
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-unit-0001';
  try { return fn(); } finally { restore(); }
}

const taskRunner = require('../src/services/agents/agent-task-runner');
const agentRunner = require('../src/services/agent-runner');

test('an unknown pick remapped to DeepSeek hands the runner the DeepSeek runtime, not «Unresolved:<fallback>»', () => {
  withDeepSeekOnly(() => {
    const profile = taskRunner.normalizeAgentRuntimeModel('not-a-known-provider-model');
    assert.equal(profile.detected, null, 'the task worker has no direct runtime for this model');
    const resolution = taskRunner.resolveAgentRuntimeClient(profile);
    assert.ok(resolution.client, 'DeepSeek is configured: the task runs on it');
    assert.equal(resolution.provider, 'DeepSeek');
    assert.equal(resolution.model, 'deepseek-v4-flash');
    taskRunner.applyAgentRuntimeResolution(profile, resolution);
    assert.equal(profile.remapped, true);
    assert.equal(profile.runtimeProvider, 'DeepSeek');

    // The exact spec the production call site used to build.
    const before = agentRunner.runnerModelSpec(profile.detected && profile.detected.provider, profile.runtimeModel);
    assert.equal(before, 'Unresolved:deepseek-v4-flash');
    assert.equal(agentRunner.canCallLlm({ pickedModel: before }), false, 'the old spec fails the preflight');

    const spec = taskRunner.runnerPickedModelSpec(profile, agentRunner);
    assert.equal(spec, 'DeepSeek:deepseek-v4-flash');
    assert.equal(agentRunner.canCallLlm({ pickedModel: spec }), true, 'the runner follows the runtime the task runs on');
  });
});

test('a pick the task worker drives natively keeps the picker provider and model', () => {
  withDeepSeekOnly(() => {
    const profile = taskRunner.normalizeAgentRuntimeModel('deepseek-v4-pro');
    const resolution = taskRunner.resolveAgentRuntimeClient(profile);
    taskRunner.applyAgentRuntimeResolution(profile, resolution);
    assert.equal(profile.remapped, false);
    assert.equal(taskRunner.runnerPickedModelSpec(profile, agentRunner), 'DeepSeek:deepseek-v4-pro');
  });
});

test('with no client at all the spec stays honest: the runner reports the picked provider as unavailable', () => {
  const restore = rememberEnv(ENV_KEYS);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  try {
    const profile = taskRunner.normalizeAgentRuntimeModel('not-a-known-provider-model');
    const resolution = taskRunner.resolveAgentRuntimeClient(profile);
    assert.equal(resolution.client, null);
    assert.equal(resolution.provider, 'unconfigured');
    taskRunner.applyAgentRuntimeResolution(profile, resolution);
    assert.notEqual(profile.runtimeProvider, 'unconfigured', 'an unresolved client never rewrites the profile');
    assert.equal(taskRunner.runnerPickedModelSpec(profile, agentRunner), `Unresolved:${profile.runtimeModel}`);
    assert.equal(agentRunner.canCallLlm({ pickedModel: taskRunner.runnerPickedModelSpec(profile, agentRunner) }), false);
  } finally {
    restore();
  }
});

test('the production call site passes the runtime-aware spec', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/agents/agent-task-runner.js'), 'utf8');
  assert.match(src, /pickedModel: runnerPickedModelSpec\(runtimeModelProfile, agentRunner\)/);
  assert.doesNotMatch(src, /pickedModel: agentRunner\.runnerModelSpec\(/, 'no call site builds the spec from the original detection');
  assert.match(src, /applyAgentRuntimeResolution\(runtimeModelProfile, runtimeClientResolution\)/);
});
