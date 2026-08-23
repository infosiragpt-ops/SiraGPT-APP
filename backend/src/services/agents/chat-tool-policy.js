'use strict';

/**
 * chat-tool-policy — authorization chokepoint for the INTERACTIVE agentic chat.
 *
 * Background: the durable task worker routes every tool through
 * tool-authorization-gate (manifest-based). The interactive chat path
 * (agentic-chat-stream → react-agent) historically passed NO gate, so the
 * high-risk host tools (host_bash, host_file, clone_project) ran fail-open for
 * any user with the ai:generate scope. This module is that missing chokepoint.
 *
 * Design goals:
 *   - Allow-by-default for the ~80 low-risk tools (web_search, RAG, visuals,
 *     sessions…) so we don't need a full manifest for every one.
 *   - High-risk tools are governed by deployment policy:
 *       * SIRAGPT_HOST_TOOLS_DISABLED=1             → always denied (kill switch
 *                                                     for untrusted / multi-tenant
 *                                                     deployments)
 *       * SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE=a,b  → only those clearances
 *     Default (no env set): allowed in development; DENIED in production
 *     (fail-closed). A prompt-injected turn must not reach the production
 *     host just because nobody configured a policy env var — same pattern as
 *     controlTokenForEnv (code-runner) and previewTokenSecret (preview proxy).
 *
 * Shape is compatible with react-agent's `ctx.toolGate`:
 *   gate.authorize(toolName, authCtx) -> { ok: true } | { ok: false, reason }
 */

const HIGH_RISK_TOOLS = new Set([
  'host_bash',
  'host_file',
  'clone_project',
]);

function isHighRiskTool(name) {
  return HIGH_RISK_TOOLS.has(name);
}

function parseList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isTruthyFlag(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isProductionEnv(env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function resolvePolicy(env = process.env) {
  return {
    disabled: isTruthyFlag(env.SIRAGPT_HOST_TOOLS_DISABLED),
    requiredClearances: parseList(env.SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE),
    // Production without an explicit policy denies high-risk host tools:
    // fail-closed beats a silently permissive multi-tenant deployment.
    productionDefaultDeny: !policyConfigured(env) && isProductionEnv(env),
  };
}

function policyConfigured(env = process.env) {
  return Boolean(
    env.SIRAGPT_HOST_TOOLS_DISABLED != null
    || (env.SIRAGPT_HOST_TOOLS_REQUIRE_CLEARANCE || '').trim(),
  );
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]      — env source (default process.env)
 * @param {function} [opts.onAudit] — called when a high-risk tool is authorized
 * @returns {{ authorize: function, policy: object, isHighRiskTool: function }}
 */
function createChatToolGate(opts = {}) {
  const env = opts.env || process.env;
  const onAudit = typeof opts.onAudit === 'function' ? opts.onAudit : null;
  const policy = resolvePolicy(env);

  function authorize(toolName, authCtx = {}) {
    if (typeof toolName !== 'string' || !toolName) {
      return { ok: false, reason: 'invalid_tool_name' };
    }
    // Low-risk tools: allow without ceremony.
    if (!isHighRiskTool(toolName)) {
      return { ok: true };
    }
    // High-risk tools: apply deployment policy.
    if (policy.disabled) {
      return { ok: false, reason: 'host_tools_disabled' };
    }
    if (policy.productionDefaultDeny) {
      return { ok: false, reason: 'host_tools_production_denied' };
    }
    if (policy.requiredClearances.length) {
      const clearance = String(authCtx.clearance || '').toLowerCase();
      if (!policy.requiredClearances.includes(clearance)) {
        return { ok: false, reason: 'insufficient_clearance' };
      }
    }
    if (onAudit) {
      try {
        onAudit({ tool: toolName, userId: authCtx.userId || null, clearance: authCtx.clearance || null });
      } catch { /* audit must never break dispatch */ }
    }
    return { ok: true };
  }

  return { authorize, policy, isHighRiskTool };
}

module.exports = {
  createChatToolGate,
  isHighRiskTool,
  resolvePolicy,
  HIGH_RISK_TOOLS,
};
