'use strict';

/**
 * Stable in-process contract between the Codex control plane and an agent
 * implementation. External engines will eventually cross a process boundary,
 * so the envelope deliberately contains no host filesystem path or database
 * handle. Operational dependencies stay in the execution context owned by
 * SiraGPT.
 *
 * AgentAdapter v1 keeps the execute result native-shaped (not wrapped): its
 * status/error shape is validated, then the exact object is interpreted by
 * run-processor. This lets the first adapter layer be behaviour-preserving. A
 * later result-envelope version can be introduced alongside (not silently in
 * place of) this contract before external engines are registered.
 */

const AGENT_REQUEST_SCHEMA_VERSION = 'sira.agent.v1';
const AGENT_CAPABILITIES_SCHEMA_VERSION = 'sira.agent-capabilities.v1';
const AGENT_ROLES = Object.freeze(['implementer', 'reviewer']);
const AGENT_MODES = Object.freeze(['plan', 'build']);
const WORKSPACE_ACCESS = Object.freeze(['ro', 'rw']);
const AGENT_OUTCOME_STATUSES = Object.freeze(['waiting_approval', 'done', 'error', 'cancelled']);

class AgentAdapterContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentAdapterContractError';
    this.code = 'CODEX_AGENT_ADAPTER_CONTRACT_INVALID';
  }
}

function invalid(message) {
  throw new AgentAdapterContractError(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireBoundedString(value, field, { max = 256, allowEmpty = false } = {}) {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  if (!allowEmpty && value.trim().length === 0) invalid(`${field} must not be empty`);
  if (value.length > max) invalid(`${field} exceeds ${max} characters`);
  return value;
}

function assertAgentCapabilities(capabilities, { adapterId = 'adapter' } = {}) {
  if (!isRecord(capabilities)) invalid(`${adapterId}.capabilities() must return an object`);
  if (capabilities.schemaVersion !== AGENT_CAPABILITIES_SCHEMA_VERSION) {
    invalid(`${adapterId}.capabilities().schemaVersion must be ${AGENT_CAPABILITIES_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(capabilities.roles) || capabilities.roles.length === 0) {
    invalid(`${adapterId}.capabilities().roles must be a non-empty array`);
  }
  if (capabilities.roles.some((role) => !AGENT_ROLES.includes(role))) {
    invalid(`${adapterId}.capabilities().roles contains an unsupported role`);
  }
  if (!Array.isArray(capabilities.modes) || capabilities.modes.length === 0) {
    invalid(`${adapterId}.capabilities().modes must be a non-empty array`);
  }
  if (capabilities.modes.some((mode) => !AGENT_MODES.includes(mode))) {
    invalid(`${adapterId}.capabilities().modes contains an unsupported mode`);
  }
  if (!WORKSPACE_ACCESS.includes(capabilities.workspaceAccess)) {
    invalid(`${adapterId}.capabilities().workspaceAccess must be ro or rw`);
  }
  return capabilities;
}

function assertAgentAdapter(adapter) {
  if (!isRecord(adapter)) invalid('AgentAdapter must be an object');
  requireBoundedString(adapter.id, 'AgentAdapter.id', { max: 64 });
  if (!/^[a-z][a-z0-9-]*$/.test(adapter.id)) {
    invalid('AgentAdapter.id must use lowercase letters, digits, and hyphens');
  }
  requireBoundedString(adapter.version, 'AgentAdapter.version', { max: 64 });
  for (const method of ['capabilities', 'health', 'execute']) {
    if (typeof adapter[method] !== 'function') invalid(`AgentAdapter.${method} must be a function`);
  }
  assertAgentCapabilities(adapter.capabilities(), { adapterId: adapter.id });
  return adapter;
}

function assertAgentRequest(request, { expectedRole } = {}) {
  if (!isRecord(request)) invalid('AgentRequest must be an object');
  if (request.schemaVersion !== AGENT_REQUEST_SCHEMA_VERSION) {
    invalid(`AgentRequest.schemaVersion must be ${AGENT_REQUEST_SCHEMA_VERSION}`);
  }
  requireBoundedString(request.invocationId, 'AgentRequest.invocationId', { max: 256 });
  if (!AGENT_ROLES.includes(request.role)) invalid('AgentRequest.role is unsupported');
  if (expectedRole && request.role !== expectedRole) {
    invalid(`AgentRequest.role must be ${expectedRole}`);
  }
  if (!isRecord(request.run)) invalid('AgentRequest.run must be an object');
  requireBoundedString(request.run.id, 'AgentRequest.run.id', { max: 256 });
  if (!AGENT_MODES.includes(request.run.mode)) invalid('AgentRequest.run.mode is unsupported');
  if (request.run.tier !== null && request.run.tier !== undefined) {
    requireBoundedString(request.run.tier, 'AgentRequest.run.tier', { max: 64 });
  }
  if (request.run.prompt !== null && request.run.prompt !== undefined) {
    requireBoundedString(request.run.prompt, 'AgentRequest.run.prompt', { max: 20_000, allowEmpty: true });
  }
  if (request.project !== null && !isRecord(request.project)) {
    invalid('AgentRequest.project must be an object or null');
  }
  if (request.project) {
    requireBoundedString(request.project.id, 'AgentRequest.project.id', { max: 256 });
    requireBoundedString(request.project.name, 'AgentRequest.project.name', { max: 200 });
  }
  requireBoundedString(request.goal, 'AgentRequest.goal', { max: 20_000, allowEmpty: true });

  if (!isRecord(request.workspace)) invalid('AgentRequest.workspace must be an object');
  requireBoundedString(request.workspace.ref, 'AgentRequest.workspace.ref', { max: 256 });
  if (request.workspace.revision !== null && request.workspace.revision !== undefined) {
    requireBoundedString(request.workspace.revision, 'AgentRequest.workspace.revision', { max: 256 });
  }
  if (!WORKSPACE_ACCESS.includes(request.workspace.access)) {
    invalid('AgentRequest.workspace.access must be ro or rw');
  }

  if (!isRecord(request.evidence)) invalid('AgentRequest.evidence must be an object');
  if (!isRecord(request.budget)) invalid('AgentRequest.budget must be an object');
  for (const key of ['timeoutMs', 'maxSteps']) {
    if (!Number.isSafeInteger(request.budget[key]) || request.budget[key] < 1) {
      invalid(`AgentRequest.budget.${key} must be a positive safe integer`);
    }
  }
  return request;
}

function assertAgentExecutionContext(context) {
  if (!isRecord(context)) invalid('AgentExecutionContext must be an object');
  if (!isRecord(context.deps)) invalid('AgentExecutionContext.deps must be an object');
  if (context.isCancelled !== undefined && typeof context.isCancelled !== 'function') {
    invalid('AgentExecutionContext.isCancelled must be a function when provided');
  }
  if (context.runAgentLoop !== undefined && typeof context.runAgentLoop !== 'function') {
    invalid('AgentExecutionContext.runAgentLoop must be a function when provided');
  }
  if (context.nativeRun !== undefined && !isRecord(context.nativeRun)) {
    invalid('AgentExecutionContext.nativeRun must be an object when provided');
  }
  if (context.nativeProject !== undefined && context.nativeProject !== null && !isRecord(context.nativeProject)) {
    invalid('AgentExecutionContext.nativeProject must be an object or null when provided');
  }
  if (context.signal !== undefined && context.signal !== null) {
    if (typeof context.signal.aborted !== 'boolean' || typeof context.signal.addEventListener !== 'function') {
      invalid('AgentExecutionContext.signal must be AbortSignal-compatible');
    }
  }
  return context;
}

/**
 * V1 deliberately preserves the native loop's existing outcome object instead
 * of wrapping it. It is still validated fail-closed: null/undefined/unknown
 * statuses can never be interpreted as a successful run.
 */
function assertAgentOutcome(outcome) {
  if (!isRecord(outcome)) invalid('AgentAdapter.execute() must return an outcome object');
  if (!AGENT_OUTCOME_STATUSES.includes(outcome.status)) {
    invalid('AgentAdapter.execute() returned an unsupported outcome status');
  }
  if (outcome.error !== undefined && outcome.error !== null && typeof outcome.error !== 'string') {
    invalid('AgentAdapter outcome.error must be a string when provided');
  }
  return outcome;
}

function createImplementerRequest({ run, project = null, timeoutMs, maxSteps }) {
  const runView = Object.freeze({
    id: run?.id,
    mode: run?.mode,
    tier: run?.tier ?? null,
    prompt: run?.prompt ?? null,
  });
  const projectView = project
    ? Object.freeze({ id: project.id, name: project.name })
    : null;
  const request = {
    schemaVersion: AGENT_REQUEST_SCHEMA_VERSION,
    invocationId: String(run?.id || ''),
    role: 'implementer',
    run: runView,
    project: projectView,
    goal: typeof run?.prompt === 'string' ? run.prompt : '',
    workspace: {
      // Opaque control-plane reference; never expose workspacePath/host paths.
      ref: project?.id ? `codex-project:${project.id}` : `codex-run:${run?.id || ''}`,
      revision: null,
      access: 'rw',
    },
    evidence: {},
    budget: { timeoutMs, maxSteps },
  };
  return assertAgentRequest(request, { expectedRole: 'implementer' });
}

module.exports = {
  AGENT_REQUEST_SCHEMA_VERSION,
  AGENT_CAPABILITIES_SCHEMA_VERSION,
  AGENT_ROLES,
  AGENT_MODES,
  AGENT_OUTCOME_STATUSES,
  AgentAdapterContractError,
  assertAgentCapabilities,
  assertAgentAdapter,
  assertAgentRequest,
  assertAgentExecutionContext,
  assertAgentOutcome,
  createImplementerRequest,
};
