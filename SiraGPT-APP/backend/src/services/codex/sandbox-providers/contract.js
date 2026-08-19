'use strict';

/**
 * Stable boundary between the Codex control plane and workspace execution.
 *
 * Providers are trusted backend modules, not values supplied by an operator or
 * a request.  Their attestation is validated once when the runtime is selected
 * and then frozen for the lifetime of the process.  This prevents a mutable
 * env flag from upgrading a shared runner into a multi-tenant security
 * boundary.
 */

const PROVIDER_SCHEMA_VERSION = 'sira.sandbox-provider.v1';
const ATTESTATION_SCHEMA_VERSION = 'sira.sandbox-attestation.v1';
const SECRET_REF_SCHEMA_VERSION = 'sira.sandbox-secret-ref.v1';

class SandboxContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxContractError';
    this.code = code;
  }
}

class SandboxPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxPolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SandboxContractError(code, message);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_contract', `${field} must be a non-empty string`);
  return value.trim();
}

function providerId(value) {
  const id = nonEmptyString(value, 'provider.id').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) fail('invalid_contract', 'provider.id has an invalid format');
  return id;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Validate and copy a provider so later mutation of the source cannot change it. */
function normalizeProvider(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('invalid_provider', 'sandbox provider must be an object');
  }
  if (candidate.schemaVersion !== PROVIDER_SCHEMA_VERSION) {
    fail('unsupported_provider_schema', `sandbox provider schema must be ${PROVIDER_SCHEMA_VERSION}`);
  }

  const id = providerId(candidate.id);
  const version = nonEmptyString(candidate.version, 'provider.version');
  for (const method of ['attest', 'createClient', 'issueSecretRef', 'acceptSecretRef']) {
    if (typeof candidate[method] !== 'function') fail('invalid_provider', `sandbox provider ${id} is missing ${method}()`);
  }

  // Bind to the original object, then freeze the public copy. Providers may
  // keep private closure state, but callers cannot swap methods after boot.
  return Object.freeze({
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id,
    version,
    attest: candidate.attest.bind(candidate),
    createClient: candidate.createClient.bind(candidate),
    issueSecretRef: candidate.issueSecretRef.bind(candidate),
    acceptSecretRef: candidate.acceptSecretRef.bind(candidate),
  });
}

/**
 * Validate an attestation and return a minimal immutable copy. Extra provider
 * fields are deliberately not trusted or propagated into policy decisions.
 */
function normalizeAttestation(candidate, expectedProvider) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('invalid_attestation', 'sandbox attestation must be an object');
  }
  if (candidate.schemaVersion !== ATTESTATION_SCHEMA_VERSION) {
    fail('unsupported_attestation_schema', `sandbox attestation schema must be ${ATTESTATION_SCHEMA_VERSION}`);
  }

  const attestedProvider = candidate.provider;
  const isolation = candidate.isolation;
  const capabilities = candidate.capabilities;
  if (!attestedProvider || typeof attestedProvider !== 'object') fail('invalid_attestation', 'attestation.provider is required');
  if (!isolation || typeof isolation !== 'object') fail('invalid_attestation', 'attestation.isolation is required');
  if (!capabilities || typeof capabilities !== 'object') fail('invalid_attestation', 'attestation.capabilities is required');

  const normalized = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    provider: {
      id: providerId(attestedProvider.id),
      version: nonEmptyString(attestedProvider.version, 'attestation.provider.version'),
    },
    isolation: {
      isolated: isolation.isolated,
      boundary: nonEmptyString(isolation.boundary, 'attestation.isolation.boundary'),
      tenantScope: nonEmptyString(isolation.tenantScope, 'attestation.isolation.tenantScope').toLowerCase(),
    },
    capabilities: {
      publicMultiTenant: capabilities.publicMultiTenant,
      secretRefs: capabilities.secretRefs,
    },
  };

  if (typeof normalized.isolation.isolated !== 'boolean') fail('invalid_attestation', 'isolation.isolated must be boolean');
  if (!['shared', 'workspace'].includes(normalized.isolation.tenantScope)) {
    fail('invalid_attestation', 'isolation.tenantScope must be shared or workspace');
  }
  if (typeof normalized.capabilities.publicMultiTenant !== 'boolean'
    || typeof normalized.capabilities.secretRefs !== 'boolean') {
    fail('invalid_attestation', 'attestation capabilities must be boolean');
  }

  if (expectedProvider
    && (normalized.provider.id !== expectedProvider.id || normalized.provider.version !== expectedProvider.version)) {
    fail('attestation_provider_mismatch', 'attestation does not match the selected sandbox provider');
  }

  // A provider may be conservative (isolated but not public-ready), but it may
  // never advertise sensitive capabilities without workspace isolation.
  if (!normalized.isolation.isolated) {
    if (normalized.isolation.tenantScope !== 'shared') {
      fail('invalid_attestation', 'a non-isolated provider must declare shared tenant scope');
    }
    if (normalized.capabilities.publicMultiTenant || normalized.capabilities.secretRefs) {
      fail('unsafe_attestation', 'a non-isolated provider cannot attest public access or secret refs');
    }
  } else if (normalized.isolation.tenantScope !== 'workspace') {
    fail('invalid_attestation', 'an isolated provider must declare workspace tenant scope');
  }

  return deepFreeze(normalized);
}

function normalizeSecretRef(candidate, { nowMs = Date.now() } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('invalid_secret_ref', 'sandbox secret ref must be an object');
  }
  if (candidate.schemaVersion !== SECRET_REF_SCHEMA_VERSION) {
    fail('invalid_secret_ref', `sandbox secret ref schema must be ${SECRET_REF_SCHEMA_VERSION}`);
  }
  const expiresAt = nonEmptyString(candidate.expiresAt, 'secretRef.expiresAt');
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) fail('invalid_secret_ref', 'secretRef.expiresAt must be an ISO timestamp');
  if (!Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
    fail('expired_secret_ref', 'sandbox secret ref is expired');
  }
  return deepFreeze({
    schemaVersion: SECRET_REF_SCHEMA_VERSION,
    ref: nonEmptyString(candidate.ref, 'secretRef.ref'),
    sandboxRef: nonEmptyString(candidate.sandboxRef, 'secretRef.sandboxRef'),
    expiresAt,
  });
}

function hasSecretRefInput(options) {
  if (!options || typeof options !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(options, 'secretRef')
    || Object.prototype.hasOwnProperty.call(options, 'secretRefs');
}

function requireCapability(attestation, capability, operation) {
  if (!attestation?.isolation?.isolated || attestation.isolation.tenantScope !== 'workspace'
    || attestation.capabilities?.[capability] !== true) {
    throw new SandboxPolicyError(
      'sandbox_isolation_required',
      `${operation} requires an isolated workspace sandbox attested for ${capability}`,
    );
  }
}

module.exports = {
  PROVIDER_SCHEMA_VERSION,
  ATTESTATION_SCHEMA_VERSION,
  SECRET_REF_SCHEMA_VERSION,
  SandboxContractError,
  SandboxPolicyError,
  deepFreeze,
  normalizeProvider,
  normalizeAttestation,
  normalizeSecretRef,
  hasSecretRefInput,
  requireCapability,
};
