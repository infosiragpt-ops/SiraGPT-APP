'use strict';

/**
 * turn-policy.js — U3 shadow-mode per-turn policy object.
 *
 * Consolidates routing / quota / capability / tool / verification / skill
 * decisions into one inspectable object for telemetry. Observe mode never
 * changes runtime behaviour; later units can flip SIRAGPT_TURN_POLICY=enforce
 * once shadowDiffs stay empty.
 *
 * Public API:
 *   TURN_POLICY_VERSION
 *   resolveTurnPolicyMode(env?)
 *   buildTurnPolicy(input)
 *   summarizeTurnPolicy(policy)
 *   diffTurnPolicyAgainstRuntime(policy, runtime)
 */

const TURN_POLICY_VERSION = 1;

function envFlag(value, defaultOn) {
  if (value == null || value === '') return defaultOn;
  const v = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return defaultOn;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'observe'|'enforce'|'off'}
 */
function resolveTurnPolicyMode(env = process.env) {
  const raw = String(env.SIRAGPT_TURN_POLICY || '').trim().toLowerCase();
  if (!raw || raw === 'observe' || raw === 'shadow' || raw === '1' || raw === 'on' || raw === 'true') {
    return 'observe';
  }
  if (raw === 'enforce' || raw === 'apply') return 'enforce';
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no' || raw === 'disabled') {
    return 'off';
  }
  return 'observe';
}

function bool(value) {
  return value === true;
}

/**
 * @param {object} input
 * @returns {object|null} null when mode is off
 */
function buildTurnPolicy(input = {}) {
  const env = input.env || process.env;
  const mode = input.mode || resolveTurnPolicyMode(env);
  if (mode === 'off') return null;

  const cognitive = input.cognitiveDecision || null;
  const quota = input.quota || null;
  const caps = input.capabilities || null;
  const tools = input.tools || {};
  const verification = input.verification || {};
  const skills = input.skills || {};
  const routing = input.routing || {};

  const promptedMaxTools = Number.isFinite(Number(tools.promptedMaxTools))
    ? Number(tools.promptedMaxTools)
    : (Number(env.SIRAGPT_PROMPTED_MAX_TOOLS) || 10);
  const promptedMaxSteps = Number.isFinite(Number(tools.promptedMaxSteps))
    ? Number(tools.promptedMaxSteps)
    : (Number(env.SIRAGPT_PROMPTED_MAX_STEPS) || 10);

  const policy = {
    version: TURN_POLICY_VERSION,
    mode,
    routing: {
      shouldRunAgentic: bool(routing.shouldRunAgentic),
      disabledReason: routing.disabledReason || null,
      agentFirst: envFlag(env.SIRAGPT_AGENT_FIRST, false),
      cognitiveIntent: cognitive && cognitive.intent ? cognitive.intent : null,
      difficultyBucket: cognitive && cognitive.difficulty ? cognitive.difficulty.bucket : null,
      riskLevel: cognitive && cognitive.risk ? cognitive.risk.level : null,
      modelAction: cognitive && cognitive.routing ? cognitive.routing.action : null,
      selectedModel: (cognitive && cognitive.routing && cognitive.routing.selectedModel)
        || input.model
        || null,
    },
    quota: {
      plan: quota && quota.plan ? quota.plan : (input.plan || null),
      resolvedModel: (quota && quota.resolvedModel) || input.model || null,
      reason: (quota && quota.reason) || null,
      fallbackToFreeIa: bool(quota && quota.fallbackToFreeIa),
    },
    capabilities: {
      provider: input.provider || null,
      model: input.model || null,
      toolCallMode: (caps && caps.toolCallMode) || input.toolCallMode || 'native',
      parallelToolCalls: bool(caps && caps.parallelToolCalls),
      supportsImages: bool(caps && caps.supportsImages),
      supportsNativeTools: caps && typeof caps.supportsNativeTools === 'boolean'
        ? caps.supportsNativeTools
        : null,
    },
    tools: {
      selectionEnabled: tools.selectionEnabled !== false,
      maxTools: Number.isFinite(Number(tools.maxTools)) ? Number(tools.maxTools) : null,
      promptedMaxTools,
      promptedMaxSteps,
      deferEnabled: envFlag(env.SIRAGPT_TOOL_DEFER, false),
      mediaAlways: envFlag(env.SIRAGPT_MEDIA_TOOLS_ALWAYS, true),
      requiredTools: Array.isArray(tools.requiredTools) ? tools.requiredTools.slice(0, 32) : [],
      initialToolChoice: tools.initialToolChoice || null,
      hasFiles: bool(tools.hasFiles),
      hasCode: bool(tools.hasCode),
    },
    verification: {
      faithfulness: verification.faithfulness !== false,
      ambiguity: bool(verification.ambiguity),
      honestyCheck: verification.honestyCheck !== false,
    },
    skills: {
      clearance: skills.clearance || null,
      skillsEnabled: skills.skillsEnabled !== false,
      recommendedSkillIds: Array.isArray(skills.recommendedSkillIds)
        ? skills.recommendedSkillIds.slice(0, 24)
        : [],
      requiresSkill: bool(skills.requiresSkill),
    },
    telemetry: {
      reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 16) : [],
      shadowDiffs: [],
    },
  };

  return policy;
}

function summarizeTurnPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  return {
    version: policy.version,
    mode: policy.mode,
    shouldRunAgentic: !!(policy.routing && policy.routing.shouldRunAgentic),
    disabledReason: policy.routing ? policy.routing.disabledReason : null,
    toolCallMode: policy.capabilities ? policy.capabilities.toolCallMode : null,
    model: policy.capabilities ? policy.capabilities.model : null,
    provider: policy.capabilities ? policy.capabilities.provider : null,
    difficulty: policy.routing ? policy.routing.difficultyBucket : null,
    risk: policy.routing ? policy.routing.riskLevel : null,
    promptedMaxSteps: policy.tools ? policy.tools.promptedMaxSteps : null,
    deferEnabled: !!(policy.tools && policy.tools.deferEnabled),
    shadowDiffCount: Array.isArray(policy.telemetry && policy.telemetry.shadowDiffs)
      ? policy.telemetry.shadowDiffs.length
      : 0,
  };
}

/**
 * Compare policy expectations against the values the runtime actually used.
 * Never mutates behaviour — only returns/attaches diffs for telemetry.
 */
function diffTurnPolicyAgainstRuntime(policy, runtime = {}) {
  if (!policy || typeof policy !== 'object') return [];
  const diffs = [];
  const push = (field, expected, actual) => {
    if (expected == null || actual == null) return;
    if (String(expected) === String(actual)) return;
    diffs.push({ field, expected, actual });
  };

  push('toolCallMode', policy.capabilities && policy.capabilities.toolCallMode, runtime.toolCallMode);
  push('model', policy.capabilities && policy.capabilities.model, runtime.model);
  push('provider', policy.capabilities && policy.capabilities.provider, runtime.provider);

  if (policy.capabilities && policy.capabilities.toolCallMode === 'prompted') {
    const expectedSteps = policy.tools && policy.tools.promptedMaxSteps;
    if (Number.isFinite(Number(runtime.maxSteps)) && Number.isFinite(Number(expectedSteps))) {
      if (Number(runtime.maxSteps) > Number(expectedSteps)) {
        diffs.push({
          field: 'promptedMaxSteps',
          expected: Number(expectedSteps),
          actual: Number(runtime.maxSteps),
        });
      }
    }
  }

  if (Array.isArray(policy.telemetry && policy.telemetry.shadowDiffs)) {
    policy.telemetry.shadowDiffs = diffs.slice(0, 16);
  }
  return diffs;
}

module.exports = {
  TURN_POLICY_VERSION,
  resolveTurnPolicyMode,
  buildTurnPolicy,
  summarizeTurnPolicy,
  diffTurnPolicyAgainstRuntime,
};
