'use strict';

/**
 * Stable boundary for future Codex project-database providers.
 *
 * No provider is registered by this foundation patch. Every invocation passes
 * through invokeProjectDatabaseProvider(), which checks the off-by-default
 * feature flag before validating or calling any implementation.
 */

const PROJECT_DATABASE_FEATURE_FLAG = 'CODEX_PROJECT_DATABASES';
const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'ensureDatabase',
  'describe',
  'issueLease',
  'revokeLease',
  'rotate',
  'snapshot',
  'deleteDatabase',
]);

class ProjectDatabaseProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProjectDatabaseProviderError';
    this.code = code;
  }
}

function providerError(code, message) {
  throw new ProjectDatabaseProviderError(code, message);
}

function isProjectDatabaseEnabled(env = process.env) {
  const value = String(env[PROJECT_DATABASE_FEATURE_FLAG] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

function assertProjectDatabaseEnabled(env = process.env) {
  if (!isProjectDatabaseEnabled(env)) {
    providerError(
      'CODEX_PROJECT_DATABASES_DISABLED',
      'Codex project databases are disabled',
    );
  }
}

function validateProjectDatabaseProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    providerError('CODEX_DB_PROVIDER_INVALID', 'project database provider is invalid');
  }
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      providerError(
        'CODEX_DB_PROVIDER_INVALID',
        `project database provider is missing method ${method}`,
      );
    }
  }
  return provider;
}

async function invokeProjectDatabaseProvider({ provider, method, args, context, env = process.env } = {}) {
  // Feature check comes first. With the flag absent/false/unknown, provider
  // code is never inspected or called and cannot accidentally provision.
  assertProjectDatabaseEnabled(env);
  const implementation = validateProjectDatabaseProvider(provider);
  if (!REQUIRED_PROVIDER_METHODS.includes(method)) {
    providerError('CODEX_DB_PROVIDER_METHOD_DENIED', 'project database provider method is not allowed');
  }
  return implementation[method](args, context);
}

function createDisabledProjectDatabaseProvider() {
  const disabled = {};
  for (const method of REQUIRED_PROVIDER_METHODS) {
    disabled[method] = async () => providerError(
      'CODEX_DB_PROVIDER_NOT_CONFIGURED',
      'project database provider is not configured',
    );
  }
  return Object.freeze(disabled);
}

module.exports = {
  PROJECT_DATABASE_FEATURE_FLAG,
  REQUIRED_PROVIDER_METHODS,
  ProjectDatabaseProviderError,
  isProjectDatabaseEnabled,
  assertProjectDatabaseEnabled,
  validateProjectDatabaseProvider,
  invokeProjectDatabaseProvider,
  createDisabledProjectDatabaseProvider,
};
