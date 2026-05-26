/**
 * enterprise-tool-gateway
 *
 * MCP-like gateway for the enterprise agentic runtime. It converts
 * legacy task tools and enterprise tools into one strict catalogue,
 * then authorizes an ExecutionGraph against the UniversalTaskContract.
 * No tool should be treated as available unless it is declared here.
 */

const {
  ENTERPRISE_TOOL_MANIFESTS,
  validateEnterpriseToolManifest,
} = require('./enterprise-agentic-runtime');
const {
  BUILTIN_MANIFESTS,
  validateManifest,
} = require('./tool-manifest');

const GATEWAY_VERSION = 'enterprise-tool-gateway-2026-04';

const LEGACY_SIDE_EFFECT_BY_TOOL = Object.freeze({
  python_exec: 'compute',
  bash_exec: 'compute',
  run_tests: 'compute',
  create_document: 'write',
  verify_artifact: 'read',
  web_search: 'read',
  rag_retrieve: 'read',
  self_rag_answer: 'read',
  finalize: 'none',
});

const TOOL_ALIASES = Object.freeze({
  research_search: 'hybrid_retrieval',
  academic_search: 'hybrid_retrieval',
  web_research: 'web_search',
  document_create: 'create_document',
  artifact_verify: 'verify_artifact',
  code_execute: 'python_exec',
  test_runner: 'run_tests',
});

function normalizeExtension(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.startsWith('.') ? raw : `.${raw}`;
}

function normalizeFormatList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.includes('/') || value.startsWith('.') ? value : `.${value}`));
}

function normalizeSideEffectLevel(toolName, manifest = {}) {
  const explicit = String(manifest.side_effect_level || '').trim();
  if (['none', 'read', 'compute', 'write', 'external'].includes(explicit)) return explicit;
  if (explicit === 'local-fs') return 'write';
  if (explicit === 'remote-read') return 'read';
  if (explicit === 'remote-write' || explicit === 'destructive') return 'external';
  if (LEGACY_SIDE_EFFECT_BY_TOOL[toolName]) return LEGACY_SIDE_EFFECT_BY_TOOL[toolName];
  if (manifest.usage_limits?.requires_network) return 'read';
  if ((manifest.allowed_formats || []).length > 0) return 'write';
  return 'none';
}

function adaptLegacyManifest(manifest) {
  const sideEffectLevel = normalizeSideEffectLevel(manifest.name, manifest);
  const requiresConfirmation = Boolean(manifest.requires_confirmation)
    || sideEffectLevel === 'external'
    || sideEffectLevel === 'write' && manifest.name !== 'create_document';
  return {
    name: manifest.name,
    source: 'legacy',
    server: 'task-agent-runtime',
    purpose: manifest.purpose,
    inputs_json_schema: manifest.inputs || {},
    outputs_json_schema: manifest.outputs || {},
    formats_allowed: normalizeFormatList(manifest.allowed_formats),
    formats_forbidden: normalizeFormatList(manifest.forbidden_formats),
    permissions: inferLegacyPermissions(manifest),
    oauth_scopes: manifest.scopes || [],
    side_effect_level: sideEffectLevel,
    requires_confirmation: requiresConfirmation,
    sandbox_required: manifest.sandbox_required !== false,
    audit_policy: {
      log_inputs: true,
      log_outputs: sideEffectLevel !== 'external',
      redact_fields: ['password', 'token', 'apiKey', 'authorization', 'secret'],
      retention_days: 90,
    },
    preconditions: inferLegacyPreconditions(manifest),
    postconditions: manifest.acceptance_tests || [],
    limits: {
      timeout_ms: manifest.usage_limits?.timeout_ms_max || manifest.usage_limits?.timeout_ms_default || 30000,
      max_calls_per_task: manifest.usage_limits?.max_calls_per_task || 20,
      rate_limit_policy: manifest.usage_limits?.requires_network
        ? 'provider quotas with bounded retries and exponential backoff'
        : 'local sandbox quota per task',
    },
    examples: {
      positive: (manifest.examples_positive || []).map((item) => item.when || JSON.stringify(item)).slice(0, 8),
      negative: (manifest.examples_negative || []).map((item) => item.when || item.why || JSON.stringify(item)).slice(0, 8),
    },
    expected_errors: (manifest.expected_errors || []).map((item) => item.code || String(item)).slice(0, 30),
    recovery_policy: manifest.recovery_policy?.on_error || manifest.recovery_policy?.on_timeout || 'Return structured error and let RepairAgent re-plan.',
    raw: manifest,
  };
}

function inferLegacyPermissions(manifest) {
  const permissions = new Set();
  const limits = manifest.usage_limits || {};
  if (limits.requires_auth) permissions.add('user:authenticated');
  if (limits.requires_network) permissions.add('network:read');
  if ((manifest.allowed_formats || []).length) permissions.add('artifact:write');
  if (manifest.name === 'verify_artifact') permissions.add('artifact:read');
  if (manifest.name === 'rag_retrieve' || manifest.name === 'self_rag_answer') permissions.add('rag:read');
  if (manifest.name === 'python_exec' || manifest.name === 'bash_exec' || manifest.name === 'run_tests') permissions.add('process:exec:sandbox');
  return Array.from(permissions);
}

function inferLegacyPreconditions(manifest) {
  const out = [];
  if (manifest.usage_limits?.requires_auth) out.push('authenticated user context');
  if (manifest.usage_limits?.requires_network) out.push('network provider configured');
  if (manifest.name === 'create_document') out.push('format sovereignty and ArtifactReviewer must pass before delivery');
  if (manifest.name === 'python_exec' || manifest.name === 'bash_exec') out.push('sandbox timeout and stripped environment');
  return out;
}

function adaptEnterpriseManifest(manifest) {
  return {
    ...manifest,
    source: 'enterprise',
    formats_allowed: normalizeFormatList(manifest.formats_allowed),
    formats_forbidden: normalizeFormatList(manifest.formats_forbidden),
    raw: manifest,
  };
}

function buildToolGatewayCatalog({ includeLegacy = true } = {}) {
  const tools = {};
  const errors = [];

  for (const [name, manifest] of Object.entries(ENTERPRISE_TOOL_MANIFESTS)) {
    const validation = validateEnterpriseToolManifest(manifest);
    if (!validation.ok) {
      errors.push({ tool: name, source: 'enterprise', errors: validation.errors });
      continue;
    }
    tools[name] = adaptEnterpriseManifest(manifest);
  }

  if (includeLegacy) {
    for (const [name, manifest] of Object.entries(BUILTIN_MANIFESTS)) {
      const validation = validateManifest(manifest);
      if (!validation.ok) {
        errors.push({ tool: name, source: 'legacy', errors: validation.errors });
        continue;
      }
      tools[name] = adaptLegacyManifest(manifest);
    }
  }

  return {
    version: GATEWAY_VERSION,
    tools,
    aliases: TOOL_ALIASES,
    errors,
    ok: errors.length === 0,
  };
}

function resolveGatewayToolName(toolName, catalog = buildToolGatewayCatalog()) {
  const requested = String(toolName || '').trim();
  if (!requested) return null;
  if (catalog.tools[requested]) return requested;
  const alias = catalog.aliases[requested];
  return alias && catalog.tools[alias] ? alias : requested;
}

function authorizeToolUse({
  toolName,
  contract = {},
  graphNode = null,
  catalog = buildToolGatewayCatalog(),
} = {}) {
  const requested = String(toolName || '').trim();
  const resolved = resolveGatewayToolName(requested, catalog);
  const manifest = catalog.tools[resolved];
  const blockers = [];
  const warnings = [];
  const forbidden = new Set(Array.isArray(contract.forbidden_tools) ? contract.forbidden_tools : []);
  const requiredExtension = normalizeExtension(contract.required_extension);

  if (!manifest) {
    blockers.push({
      code: 'undeclared_tool',
      detail: `Tool "${requested}" is not registered in the enterprise gateway.`,
      nodeId: graphNode?.id || null,
    });
    return {
      ok: false,
      requestedToolName: requested,
      resolvedToolName: resolved,
      manifest: null,
      blockers,
      warnings,
      requiresHumanConfirmation: false,
    };
  }

  if (forbidden.has(requested) || forbidden.has(resolved)) {
    blockers.push({
      code: 'forbidden_tool',
      detail: `Tool "${requested}" is forbidden by the UniversalTaskContract.`,
      nodeId: graphNode?.id || null,
    });
  }

  if (requiredExtension && manifest.formats_forbidden.includes(requiredExtension)) {
    blockers.push({
      code: 'format_forbidden_by_tool',
      detail: `Tool "${resolved}" cannot produce or handle ${requiredExtension}.`,
      nodeId: graphNode?.id || null,
    });
  }

  const enforceSingleArtifactFormat = contract.artifact_required
    && requiredExtension
    && !['CodePipeline'].includes(contract.pipeline);
  if (enforceSingleArtifactFormat && manifest.formats_allowed.length > 0) {
    const allowed = manifest.formats_allowed.includes(requiredExtension)
      || manifest.formats_allowed.includes(String(contract.mime_type || '').toLowerCase());
    if (!allowed && isArtifactProducingTool(manifest)) {
      blockers.push({
        code: 'format_not_allowed_by_tool',
        detail: `Tool "${resolved}" does not allow required format ${requiredExtension}.`,
        nodeId: graphNode?.id || null,
      });
    }
  }

  const requiresHumanConfirmation = Boolean(manifest.requires_confirmation)
    || graphNode?.release_gate?.requires_human_confirmation === true;
  if (requiresHumanConfirmation) {
    warnings.push({
      code: 'human_confirmation_required',
      detail: `Tool "${resolved}" has ${manifest.side_effect_level} side effects and must pause before execution until approved.`,
      nodeId: graphNode?.id || null,
    });
  }

  if (manifest.sandbox_required && !manifest.permissions.some((perm) => perm.includes('sandbox') || perm.includes('read') || perm.includes('write'))) {
    warnings.push({
      code: 'sandbox_policy_without_explicit_permission',
      detail: `Tool "${resolved}" requires sandboxing; dispatcher must enforce isolated runtime.`,
      nodeId: graphNode?.id || null,
    });
  }

  return {
    ok: blockers.length === 0,
    requestedToolName: requested,
    resolvedToolName: resolved,
    manifest,
    blockers,
    warnings,
    requiresHumanConfirmation,
  };
}

function isArtifactProducingTool(manifest) {
  if (!manifest) return false;
  return manifest.permissions.includes('artifact:write')
    || manifest.permissions.includes('fs:write:workspace')
    || manifest.permissions.includes('design:build')
    || manifest.permissions.includes('bi:build')
    || manifest.formats_allowed.length > 0;
}

function authorizeExecutionGraph({ graph, contract = {}, catalog = buildToolGatewayCatalog() } = {}) {
  const blockers = [];
  const warnings = [...(catalog.errors || []).map((error) => ({
    code: 'manifest_validation_failed',
    detail: `${error.source}:${error.tool} failed manifest validation`,
    errors: error.errors,
  }))];
  const authorizedTools = [];
  const toolsByNode = {};
  const sideEffectSummary = { none: 0, read: 0, compute: 0, write: 0, external: 0 };
  let requiresHumanConfirmation = false;
  const seen = new Set();

  for (const node of graph?.nodes || []) {
    const nodeTools = [];
    for (const toolName of node.tools || []) {
      const decision = authorizeToolUse({ toolName, contract, graphNode: node, catalog });
      blockers.push(...decision.blockers);
      warnings.push(...decision.warnings);
      if (decision.manifest) {
        const toolSummary = {
          requested: decision.requestedToolName,
          name: decision.resolvedToolName,
          nodeId: node.id,
          server: decision.manifest.server,
          source: decision.manifest.source,
          side_effect_level: decision.manifest.side_effect_level,
          requires_confirmation: decision.requiresHumanConfirmation,
          sandbox_required: decision.manifest.sandbox_required,
          permissions: decision.manifest.permissions,
          formats_allowed: decision.manifest.formats_allowed,
          formats_forbidden: decision.manifest.formats_forbidden,
        };
        nodeTools.push(toolSummary);
        if (!seen.has(`${node.id}:${decision.resolvedToolName}`)) {
          authorizedTools.push(toolSummary);
          seen.add(`${node.id}:${decision.resolvedToolName}`);
        }
        sideEffectSummary[decision.manifest.side_effect_level] = (sideEffectSummary[decision.manifest.side_effect_level] || 0) + 1;
        requiresHumanConfirmation = requiresHumanConfirmation || decision.requiresHumanConfirmation;
      }
    }
    toolsByNode[node.id] = nodeTools;
  }

  return {
    ok: blockers.length === 0 && catalog.ok,
    catalogVersion: catalog.version,
    authorizedTools,
    blockers,
    warnings,
    toolsByNode,
    sideEffectSummary,
    requiresHumanConfirmation,
  };
}

function buildToolRuntimePlan({ contract, graph } = {}) {
  const catalog = buildToolGatewayCatalog();
  const authorization = authorizeExecutionGraph({ graph, contract, catalog });
  const events = [
    {
      type: 'tool_catalog_built',
      catalogVersion: catalog.version,
      toolCount: Object.keys(catalog.tools).length,
      ok: catalog.ok,
    },
    {
      type: authorization.ok ? 'tool_manifest_authorized' : 'tool_manifest_blocked',
      graphId: graph?.graph_id || null,
      authorizedToolCount: authorization.authorizedTools.length,
      blockerCount: authorization.blockers.length,
      requiresHumanConfirmation: authorization.requiresHumanConfirmation,
    },
  ];

  return {
    version: GATEWAY_VERSION,
    ok: authorization.ok,
    graphId: graph?.graph_id || null,
    contractPipeline: contract?.pipeline || null,
    authorization,
    events,
    summary: {
      ok: authorization.ok,
      catalogVersion: catalog.version,
      authorizedToolCount: authorization.authorizedTools.length,
      blockerCount: authorization.blockers.length,
      warningCount: authorization.warnings.length,
      sideEffectSummary: authorization.sideEffectSummary,
      requiresHumanConfirmation: authorization.requiresHumanConfirmation,
    },
  };
}

module.exports = {
  GATEWAY_VERSION,
  TOOL_ALIASES,
  buildToolGatewayCatalog,
  buildToolRuntimePlan,
  authorizeToolUse,
  authorizeExecutionGraph,
  normalizeExtension,
  resolveGatewayToolName,
};
