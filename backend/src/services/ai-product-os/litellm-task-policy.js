'use strict';

/**
 * Task-kind policies for LiteLLM gateway (fallbacks, timeouts).
 */
const POLICIES = {
  'agent.orchestrator': {
    allow_fallbacks: false,
    preferred_models: ['claude-opus-4-20250514', 'gpt-4.1'],
    timeoutMs: 120_000,
  },
  'agent.workspace_workflow': {
    allow_fallbacks: false,
    preferred_models: ['claude-opus-4-20250514'],
    timeoutMs: 180_000,
  },
  'agent.synthesis': {
    allow_fallbacks: true,
    preferred_models: ['gpt-4o-mini', 'gpt-4o'],
    timeoutMs: 90_000,
  },
  'research.vision': {
    allow_fallbacks: true,
    preferred_models: ['gpt-4o-mini'],
    timeoutMs: 60_000,
  },
  'chat.default': {
    allow_fallbacks: true,
    preferred_models: [],
    timeoutMs: 60_000,
  },
};

function resolveTaskPolicy(taskKind, overrides = {}) {
  const base = POLICIES[taskKind] || POLICIES['chat.default'];
  return {
    taskKind: taskKind || 'chat.default',
    allow_fallbacks: overrides.allow_fallbacks ?? base.allow_fallbacks,
    preferred_models: overrides.preferred_models || base.preferred_models,
    timeoutMs: Number(overrides.timeoutMs) || base.timeoutMs,
    fallbacks: overrides.fallbacks || (base.allow_fallbacks ? base.preferred_models.slice(1) : []),
  };
}

function applyPolicyToGatewayRequest(request, taskKind, overrides = {}) {
  const policy = resolveTaskPolicy(taskKind, overrides);
  return {
    ...request,
    allow_fallbacks: policy.allow_fallbacks,
    fallbacks: policy.fallbacks,
    timeout_ms: policy.timeoutMs,
    metadata: {
      ...(request?.metadata || {}),
      task_kind: policy.taskKind,
    },
  };
}

module.exports = {
  POLICIES,
  resolveTaskPolicy,
  applyPolicyToGatewayRequest,
};
