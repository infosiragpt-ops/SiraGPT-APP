'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  REQUIRED_PROVIDER_METHODS,
  ProjectDatabaseProviderError,
  createDisabledProjectDatabaseProvider,
  invokeProjectDatabaseProvider,
  isProjectDatabaseEnabled,
  validateProjectDatabaseProvider,
} = require('../src/services/codex/database-providers/contract');

function fullProvider(overrides = {}) {
  const provider = {};
  for (const method of REQUIRED_PROVIDER_METHODS) {
    provider[method] = async () => ({ method });
  }
  return { ...provider, ...overrides };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ProjectDatabaseProviderError);
    assert.equal(error.code, code);
    return true;
  };
}

describe('ProjectDatabaseProvider contract', () => {
  test('feature is off by default and unknown values fail closed', () => {
    for (const env of [
      {},
      { CODEX_PROJECT_DATABASES: '' },
      { CODEX_PROJECT_DATABASES: '0' },
      { CODEX_PROJECT_DATABASES: 'false' },
      { CODEX_PROJECT_DATABASES: 'enabled-ish' },
    ]) {
      assert.equal(isProjectDatabaseEnabled(env), false);
    }
    for (const value of ['1', 'true', ' ON ']) {
      assert.equal(isProjectDatabaseEnabled({ CODEX_PROJECT_DATABASES: value }), true);
    }
  });

  test('disabled invocation does not inspect or call provider code', async () => {
    const poison = new Proxy({}, {
      get() { throw new Error('provider must remain untouched'); },
    });
    await assert.rejects(
      invokeProjectDatabaseProvider({
        provider: poison,
        method: 'ensureDatabase',
        args: {},
        context: {},
        env: {},
      }),
      expectCode('CODEX_PROJECT_DATABASES_DISABLED'),
    );
  });

  test('validation requires every lifecycle operation', () => {
    assert.throws(() => validateProjectDatabaseProvider(null), expectCode('CODEX_DB_PROVIDER_INVALID'));
    const incomplete = fullProvider();
    delete incomplete.issueLease;
    assert.throws(
      () => validateProjectDatabaseProvider(incomplete),
      expectCode('CODEX_DB_PROVIDER_INVALID'),
    );
    assert.equal(validateProjectDatabaseProvider(fullProvider()).ensureDatabase instanceof Function, true);
    assert.equal(Object.isFrozen(REQUIRED_PROVIDER_METHODS), true);
  });

  test('enabled invocation only dispatches allowlisted methods', async () => {
    const calls = [];
    const provider = fullProvider({
      describe: async (args, context) => {
        calls.push({ args, context });
        return { status: 'pending' };
      },
      hiddenDangerousMethod: async () => calls.push('danger'),
    });
    const result = await invokeProjectDatabaseProvider({
      provider,
      method: 'describe',
      args: { resourceRef: 'opaque' },
      context: { operationId: 'op-1' },
      env: { CODEX_PROJECT_DATABASES: '1' },
    });
    assert.deepEqual(result, { status: 'pending' });
    assert.deepEqual(calls, [{
      args: { resourceRef: 'opaque' },
      context: { operationId: 'op-1' },
    }]);

    await assert.rejects(
      invokeProjectDatabaseProvider({
        provider,
        method: 'hiddenDangerousMethod',
        env: { CODEX_PROJECT_DATABASES: '1' },
      }),
      expectCode('CODEX_DB_PROVIDER_METHOD_DENIED'),
    );
    assert.equal(calls.includes('danger'), false);
  });

  test('placeholder provider is fail-closed even if called directly', async () => {
    const disabled = createDisabledProjectDatabaseProvider();
    assert.equal(Object.isFrozen(disabled), true);
    for (const method of REQUIRED_PROVIDER_METHODS) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(disabled[method](), expectCode('CODEX_DB_PROVIDER_NOT_CONFIGURED'));
    }
  });
});
