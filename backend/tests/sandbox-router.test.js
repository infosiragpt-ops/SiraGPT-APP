/**
 * Tests for services/sandbox/router.js — picks the strongest available
 * code-execution backend (e2b > local).
 *
 * We inject mocks for ./e2b-sandbox and ./local-sandbox via the
 * require cache so the real network/process layers never run.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const E2B_PATH = require.resolve('../src/services/sandbox/e2b-sandbox');
const LOCAL_PATH = require.resolve('../src/services/sandbox/local-sandbox');
const ROUTER_PATH = require.resolve('../src/services/sandbox/router');

const e2bMock = {
  resolveE2BConfig: () => ({ enabled: false, configured: false }),
  executeCode: async () => ({ ok: true, output: 'from-e2b' }),
};

const localMock = {
  resolveLocalConfig: () => ({ enabled: false }),
  executeLocal: async () => ({ ok: true, output: 'from-local' }),
};

let origE2BCache, origLocalCache, origRouterCache;

function installMocks() {
  origE2BCache = require.cache[E2B_PATH];
  origLocalCache = require.cache[LOCAL_PATH];
  origRouterCache = require.cache[ROUTER_PATH];

  function makeCacheEntry(id, exports_) {
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(id));
    return m;
  }
  require.cache[E2B_PATH] = makeCacheEntry(E2B_PATH, e2bMock);
  require.cache[LOCAL_PATH] = makeCacheEntry(LOCAL_PATH, localMock);
  delete require.cache[ROUTER_PATH];
}

function restoreMocks() {
  if (origE2BCache) require.cache[E2B_PATH] = origE2BCache;
  else delete require.cache[E2B_PATH];
  if (origLocalCache) require.cache[LOCAL_PATH] = origLocalCache;
  else delete require.cache[LOCAL_PATH];
  if (origRouterCache) require.cache[ROUTER_PATH] = origRouterCache;
  else delete require.cache[ROUTER_PATH];
}

let router;

before(() => {
  installMocks();
  router = require('../src/services/sandbox/router');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  // Reset stubs to defaults each test
  e2bMock.resolveE2BConfig = () => ({ enabled: false, configured: false });
  e2bMock.executeCode = async () => ({ ok: true, output: 'from-e2b' });
  localMock.resolveLocalConfig = () => ({ enabled: false });
  localMock.executeLocal = async () => ({ ok: true, output: 'from-local' });
});

// ── readPreference ────────────────────────────────────────────────

describe('readPreference', () => {
  it('returns default [e2b, local] when SANDBOX_PREFERENCE is unset', () => {
    assert.deepEqual(router.readPreference({}), ['e2b', 'local']);
    assert.deepEqual(router.readPreference({ SANDBOX_PREFERENCE: '' }), ['e2b', 'local']);
    assert.deepEqual(router.readPreference({ SANDBOX_PREFERENCE: '   ' }), ['e2b', 'local']);
  });

  it('parses a comma-separated preference', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'local,e2b' }),
      ['local', 'e2b'],
    );
  });

  it('parses a whitespace-separated preference', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'e2b local' }),
      ['e2b', 'local'],
    );
  });

  it('honours single-entry preferences', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'local' }),
      ['local'],
    );
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'e2b' }),
      ['e2b'],
    );
  });

  it('lowercases input', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'E2B,LOCAL' }),
      ['e2b', 'local'],
    );
  });

  it('drops unknown backend tokens', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'docker,e2b,wasm' }),
      ['e2b'],
    );
  });

  it('falls back to default when ALL tokens are unknown', () => {
    assert.deepEqual(
      router.readPreference({ SANDBOX_PREFERENCE: 'docker,wasm' }),
      ['e2b', 'local'],
    );
  });

  it('returns a fresh array each call (caller may mutate)', () => {
    const a = router.readPreference({});
    const b = router.readPreference({});
    assert.notStrictEqual(a, b);
    a.length = 0;
    assert.equal(router.readPreference({}).length, 2);
  });
});

// ── describeBackends ──────────────────────────────────────────────

describe('describeBackends', () => {
  it('reports availability from each backend resolver', () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true, configured: true });
    localMock.resolveLocalConfig = () => ({ enabled: false });
    const out = router.describeBackends({});
    assert.equal(out.e2b.available, true);
    assert.equal(out.e2b.configured, true);
    assert.equal(out.local.available, false);
    assert.deepEqual(out.preference, ['e2b', 'local']);
  });

  it('includes the resolved preference', () => {
    const out = router.describeBackends({ SANDBOX_PREFERENCE: 'local' });
    assert.deepEqual(out.preference, ['local']);
  });
});

// ── executeCode ───────────────────────────────────────────────────

describe('executeCode · no backend enabled', () => {
  it('returns sandbox_no_backend when nothing is available', async () => {
    const out = await router.executeCode({ code: 'print(1)', language: 'python' }, {});
    assert.equal(out.ok, false);
    assert.equal(out.code, 'sandbox_no_backend');
    assert.equal(out.backend, 'none');
    assert.match(out.message, /no sandbox backend is enabled/);
  });
});

describe('executeCode · backend selection', () => {
  it('routes to e2b when it is the first enabled backend', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true, configured: true });
    e2bMock.executeCode = async () => ({ ok: true, output: 'E2B-RESULT' });
    const out = await router.executeCode({ code: 'x', language: 'python' }, {});
    assert.equal(out.backend, 'e2b');
    assert.equal(out.output, 'E2B-RESULT');
  });

  it('falls through to local when e2b is disabled', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: false });
    localMock.resolveLocalConfig = () => ({ enabled: true });
    localMock.executeLocal = async () => ({ ok: true, output: 'LOCAL-RESULT' });
    const out = await router.executeCode({ code: 'x', language: 'python' }, {});
    assert.equal(out.backend, 'local');
    assert.equal(out.output, 'LOCAL-RESULT');
  });

  it('uses preference order — local first when SANDBOX_PREFERENCE=local,e2b', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true });
    localMock.resolveLocalConfig = () => ({ enabled: true });
    let calls = [];
    e2bMock.executeCode = async () => { calls.push('e2b'); return { ok: true }; };
    localMock.executeLocal = async () => { calls.push('local'); return { ok: true }; };
    const out = await router.executeCode({ code: 'x' }, { SANDBOX_PREFERENCE: 'local,e2b' });
    assert.equal(out.backend, 'local');
    assert.deepEqual(calls, ['local']);
  });

  it('passes args, env, and opts through to the chosen backend', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true });
    let captured;
    e2bMock.executeCode = async (args, env, opts) => {
      captured = { args, env, opts };
      return { ok: true };
    };
    const args = { code: 'print(1)', language: 'python' };
    const env = { SOME: 'value' };
    const opts = { timeout: 5000 };
    await router.executeCode(args, env, opts);
    assert.deepEqual(captured.args, args);
    assert.equal(captured.env.SOME, 'value');
    assert.deepEqual(captured.opts, opts);
  });

  it('preserves the backend result fields and tags the backend', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true });
    e2bMock.executeCode = async () => ({
      ok: false,
      code: 'sandbox_oom',
      stdout: 'partial output',
      stderr: 'oom',
      exitCode: 137,
    });
    const out = await router.executeCode({ code: 'x' });
    assert.equal(out.backend, 'e2b');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'sandbox_oom');
    assert.equal(out.exitCode, 137);
  });

  it('preference with only local skips e2b entirely (even if e2b is enabled)', async () => {
    e2bMock.resolveE2BConfig = () => ({ enabled: true });
    localMock.resolveLocalConfig = () => ({ enabled: true });
    let e2bCalled = false;
    e2bMock.executeCode = async () => { e2bCalled = true; return { ok: true }; };
    localMock.executeLocal = async () => ({ ok: true, output: 'local-only' });
    const out = await router.executeCode({ code: 'x' }, { SANDBOX_PREFERENCE: 'local' });
    assert.equal(out.backend, 'local');
    assert.equal(e2bCalled, false);
  });
});
