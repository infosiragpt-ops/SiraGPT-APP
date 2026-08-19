"use strict";

/**
 * Sira tool policy
 *
 * Runtime trust boundary: the model can
 * request tools, but the backend decides whether the current session profile
 * may expose or execute them. This module is deterministic and shared by the
 * agent preflight runtime and the real workflow executor.
 */

const HIGH_IMPACT_PERMISSIONS = Object.freeze([
  "publish_online",
  "send_message",
  "database_write",
]);

const KNOWN_PERMISSIONS = Object.freeze([
  "none",
  "read_uploaded_file",
  "write_artifact",
  "execute_sandboxed_code",
  "external_api_access",
  "browser_access",
  "database_read",
  "database_write",
  "send_message",
  "publish_online",
]);

const TOOL_POLICY_PROFILES = Object.freeze({
  interactive: Object.freeze([...KNOWN_PERMISSIONS]),
  sandbox: Object.freeze([
    "none",
    "read_uploaded_file",
    "write_artifact",
    "execute_sandboxed_code",
    "external_api_access",
    "database_read",
  ]),
  locked_down: Object.freeze([
    "none",
    "read_uploaded_file",
  ]),
});

function resolveToolPolicyProfile({ envelope = null, runtimeOptions = {}, context = {} } = {}) {
  const explicit = normalizeProfile(
    runtimeOptions.toolPolicyProfile ||
    runtimeOptions.profile ||
    context.toolPolicyProfile ||
    envelope?.runtime_policy?.tool_policy_profile
  );
  if (explicit) return explicit;

  const requiresCode = Boolean(envelope?.task_classification?.requires_code_execution);
  const risk = String(envelope?.safety_and_permissions?.overall_risk_level || "").toLowerCase();
  if (requiresCode || risk === "high" || risk === "critical") return "sandbox";
  return "interactive";
}

function applyToolRuntimePolicy(tools = [], options = {}) {
  const profile = resolveToolPolicyProfile(options);
  const decisions = (Array.isArray(tools) ? tools : []).map((tool) => {
    const decision = evaluateToolPolicy(tool, { ...options, profile });
    return {
      ...tool,
      policy: decision,
    };
  });
  const blocked = decisions.filter((tool) => tool.policy && tool.policy.allowed === false);
  const allowed = decisions.filter((tool) => !tool.policy || tool.policy.allowed !== false);
  const warnings = decisions
    .filter((tool) => tool.policy?.warnings?.length)
    .map((tool) => ({ tool: tool.name || tool.tool_name, warnings: tool.policy.warnings }));

  return {
    profile,
    tools: decisions,
    allowed,
    blocked,
    warnings,
    summary: {
      profile,
      model_trust_boundary: "model_requests_backend_authorizes",
      total_tools: decisions.length,
      allowed_tools: allowed.length,
      blocked_tools: blocked.length,
      blocked_required_tools: blocked.filter((tool) => tool.required !== false).length,
      high_impact_permissions: [...HIGH_IMPACT_PERMISSIONS],
    },
  };
}

function evaluateToolPolicy(tool = {}, options = {}) {
  const profile = normalizeProfile(options.profile) || resolveToolPolicyProfile(options);
  const allowedPermissions = new Set(TOOL_POLICY_PROFILES[profile] || TOOL_POLICY_PROFILES.interactive);
  const permissions = normalizePermissions(
    tool.permissionsRequired ||
    tool.permissions_required ||
    tool.manifest?.scopes ||
    tool.permission_required
  );
  const riskLevel = String(tool.riskLevel || tool.risk_level || "low").toLowerCase();
  const sideEffectLevel = tool.manifest?.sideEffectLevel || tool.sideEffectLevel || "none";
  const requiresHumanConfirmation = Boolean(
    tool.requiresHumanConfirmation ||
    tool.requires_human_confirmation ||
    tool.manifest?.requiresConfirmation
  );
  const humanApproved = Boolean(options.humanApproved || options.context?.humanApproved);
  const allowExternalSideEffects = Boolean(options.allowExternalSideEffects || options.context?.allowExternalSideEffects);
  const missingPermissions = permissions.filter((permission) => permission !== "none" && !allowedPermissions.has(permission));
  const highImpact = permissions.filter((permission) => HIGH_IMPACT_PERMISSIONS.includes(permission));
  const warnings = [];
  const reasons = [];

  if (!tool.name && !tool.tool_name) {
    reasons.push({ code: "tool_identity_missing", message: "Tool has no stable name." });
  }
  if (missingPermissions.length > 0) {
    reasons.push({
      code: "permission_not_in_profile",
      message: `Profile "${profile}" does not grant ${missingPermissions.join(", ")}.`,
      permissions: missingPermissions,
    });
  }
  if (highImpact.length > 0 && !(humanApproved && allowExternalSideEffects)) {
    reasons.push({
      code: "high_impact_action_requires_approval",
      message: `${highImpact.join(", ")} requires explicit human approval and side-effect opt-in.`,
      permissions: highImpact,
    });
  }
  if (requiresHumanConfirmation && !humanApproved) {
    reasons.push({
      code: "human_confirmation_required",
      message: "Tool contract requires explicit human confirmation.",
    });
  }
  if (riskLevel === "critical" && !humanApproved) {
    reasons.push({
      code: "critical_tool_requires_approval",
      message: "Critical-risk tools require explicit human confirmation.",
    });
  }
  if (permissions.includes("execute_sandboxed_code")) {
    warnings.push({
      code: "sandbox_required",
      message: "Tool must execute only through the sandbox adapter.",
    });
  }
  if (sideEffectLevel === "external_side_effect" && highImpact.length === 0) {
    warnings.push({
      code: "external_side_effect_declared",
      message: "Tool declares external side effects; audit logging is mandatory.",
    });
  }

  return {
    allowed: reasons.length === 0,
    code: reasons.length === 0 ? "tool_policy_allowed" : "tool_policy_denied",
    reason: reasons.map((reason) => reason.message).join(" "),
    reasons,
    warnings,
    profile,
    permissions_required: permissions,
    risk_level: riskLevel,
    side_effect_level: sideEffectLevel,
    requires_human_confirmation: requiresHumanConfirmation,
    sandbox_required: permissions.includes("execute_sandboxed_code") || Boolean(tool.manifest?.sandboxRequired),
  };
}

function normalizePermissions(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = raw
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== "registered_scope");
  return normalized.length > 0 ? Array.from(new Set(normalized)) : ["none"];
}

function normalizeProfile(value) {
  if (!value) return null;
  const profile = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOOL_POLICY_PROFILES, profile) ? profile : null;
}

module.exports = {
  HIGH_IMPACT_PERMISSIONS,
  TOOL_POLICY_PROFILES,
  resolveToolPolicyProfile,
  applyToolRuntimePolicy,
  evaluateToolPolicy,
  normalizePermissions,
};
