'use strict';

/**
 * F7.1 — E2BDesktopProvider + warm-pool DesktopSessionManager.
 *
 * Always-on (no Docker, no live E2B):
 *   (a) acquire() with pool>0 is < 800 ms p50;
 *   (b) status is never the generic provision error when the pool is warm;
 *   (c) reaper destroys idle > TTL;
 *   (d) missing E2B key / kill switch fail closed (honest Spanish);
 *   (e) injected fake provider — E2B stub 501 is gone.
 *
 * Optional (skip honestly):
 *   (f) live E2B_API_KEY create/destroy.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  DesktopProviderError,
  assertImplementsDesktopProvider,
  createDesktopProvider,
  E2BDesktopProvider,
} = require('../src/services/desktop/provider');
const {
  DesktopSessionManager,
  isDesktopEnabled,
  resolveProviderKind,
} = require('../src/services/desktop/session-manager');
const {
  GENERIC_PROVISION_ERROR_ES,
  DESKTOP_DISABLED_ES,
  E2B_KEY_MISSING_ES,
  isGenericProvisionError,
} = require('../src/services/desktop/desktop-errors');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function fakeProvider({ createDelayMs = 0, healthOk = true } = {}) {
  let seq = 0;
  const destroyed = [];
  const created = [];
  return {
    kind: 'fake',
    created,
    destroyed,
    async create() {
      if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
      const id = `fake-${++seq}`;
      created.push(id);
      return { id, display: ':0', provider: 'fake', wsUrl: `ws://desktop.local/${id}` };
    },
    async destroy(handle) {
      if (handle && handle.id) destroyed.push(handle.id);
    },
    async health(handle) {
      if (!healthOk) {
        throw new DesktopProviderError('unhealthy', { code: 'desktop_unhealthy' });
      }
      if (!handle || !handle.id) {
        throw new DesktopProviderError('handle required', { code: 'desktop_handle_required' });
      }
      return { status: 'ok', display: ':0' };
    },
    async screenshot() {
      return { bytes: PNG, mediaType: 'image/png' };
    },
  };
}

function enabledEnv(extra = {}) {
  return {
    SIRAGPT_DESKTOP_ENABLED: '1',
    DESKTOP_POOL_MIN: '2',
    DESKTOP_POOL_MAX: '20',
    DESKTOP_SESSION_TTL_MIN: '15',
    ...extra,
  };
}

describe('F7.1 E2BDesktopProvider', () => {
  test('F7.1(e): implements the interface; injected client is not a 501 stub', async () => {
    const sandboxes = [];
    const Desktop = {
      async create() {
        const box = {
          sandboxId: `sbx-${sandboxes.length + 1}`,
          display: ':0',
          async isRunning() { return true; },
          async screenshot() { return PNG; },
          async kill() { this.dead = true; },
        };
        sandboxes.push(box);
        return box;
      },
    };
    const p = new E2BDesktopProvider({ Desktop, apiKey: 'e2b_test_xxxx' });
    assertImplementsDesktopProvider(p);
    assert.equal(p.kind, 'e2b');
    const handle = await p.create();
    assert.equal(handle.provider, 'e2b');
    assert.equal(handle.display, ':0');
    assert.deepEqual(await p.health(handle), { status: 'ok', display: ':0' });
    const shot = await p.screenshot(handle);
    assert.equal(shot.mediaType, 'image/png');
    await p.destroy(handle);
    assert.equal(sandboxes[0].dead, true);
    await p.destroy({ id: 'already-gone' });
  });

  test('F7.1(d): missing E2B key fails closed — no network, honest Spanish', async () => {
    let required = false;
    const p = new E2BDesktopProvider({
      env: {},
      apiKey: '',
      requireFn: () => {
        required = true;
        throw new Error('should not load SDK');
      },
    });
    await assert.rejects(p.create(), (err) => (
      err instanceof DesktopProviderError
      && err.code === 'desktop_e2b_unconfigured'
      && err.status === 503
      && err.message === E2B_KEY_MISSING_ES
      && !isGenericProvisionError(err.message)
    ));
    assert.equal(required, false);
  });

  test('F7.1(e): factory still model-agnostic (kind, never an LLM id)', () => {
    const e2b = createDesktopProvider('e2b', { apiKey: '' });
    assert.equal(e2b.kind, 'e2b');
    const local = createDesktopProvider('local_gvisor');
    assert.equal(local.kind, 'local-gvisor');
    assert.throws(() => createDesktopProvider('deepseek'), /desconocido/);
  });
});

describe('F7.1 DesktopSessionManager warm pool', () => {
  const managers = [];
  after(() => {
    for (const m of managers) m.stop();
  });

  test('F7.1(a): acquire() with pool>0 is < 800 ms p50', async () => {
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      provider,
      env: enabledEnv(),
      autoStart: false,
    });
    managers.push(mgr);
    await mgr.refillPool();
    assert.ok(mgr.poolWarm() >= 2, `expected warm pool, got ${mgr.poolWarm()}`);

    const samples = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = Date.now();
      const lease = await mgr.acquire(`chat-${i}`);
      samples.push(Date.now() - t0);
      assert.equal(lease.status, 'ready');
      assert.ok(lease.sessionId);
      assert.equal(lease.provider, 'fake');
      assert.ok(!isGenericProvisionError(lease.status));
      await mgr.release(lease.sessionId, { keepWarm: true });
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    assert.ok(p50 < 800, `acquire p50 ${p50}ms >= 800ms (samples=${samples.join(',')})`);
  });

  test('F7.1(b): status is never the generic provision error when pool is warm', async () => {
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      provider,
      env: enabledEnv(),
    });
    managers.push(mgr);
    await mgr.refillPool();
    assert.ok(mgr.poolWarm() > 0);
    const lease = await mgr.acquire('chat-warm');
    const snap = mgr.status(lease.sessionId);
    assert.equal(snap.status, 'ready');
    assert.notEqual(snap.status, GENERIC_PROVISION_ERROR_ES);
    assert.equal(isGenericProvisionError(snap.status), false);
    assert.equal(isGenericProvisionError(JSON.stringify(snap)), false);
    assert.equal(isGenericProvisionError(JSON.stringify(mgr.publicStatus())), false);
    await mgr.release(lease.sessionId);
  });

  test('F7.1(c): reaper destroys idle > TTL', async () => {
    let clock = 1_000_000;
    const provider = fakeProvider();
    const mgr = new DesktopSessionManager({
      provider,
      env: enabledEnv({ DESKTOP_SESSION_TTL_MIN: '1' }),
      now: () => clock,
      autoStart: false,
    });
    managers.push(mgr);
    const lease = await mgr.acquire('chat-ttl');
    assert.equal(provider.destroyed.length, 0);
    clock += 2 * 60_000;
    const reap = await mgr.reap();
    assert.ok(reap.destroyed >= 1);
    assert.ok(provider.destroyed.includes(lease.sessionId.replace(/^desk-/, '')) || provider.destroyed.length >= 1);
    assert.equal(mgr.status(lease.sessionId).status, 'dead');
  });

  test('F7.1(d): kill switch unset/0 fails closed with honest Spanish', async () => {
    const provider = fakeProvider();
    const off = new DesktopSessionManager({
      provider,
      env: { SIRAGPT_DESKTOP_ENABLED: '0' },
    });
    const unset = new DesktopSessionManager({
      provider,
      env: {},
    });
    managers.push(off, unset);
    assert.equal(isDesktopEnabled({}), false);
    assert.equal(isDesktopEnabled({ SIRAGPT_DESKTOP_ENABLED: '0' }), false);
    assert.equal(isDesktopEnabled({ SIRAGPT_DESKTOP_ENABLED: '1' }), true);
    await assert.rejects(off.acquire('c'), (err) => (
      err.code === 'desktop_disabled'
      && err.message === DESKTOP_DISABLED_ES
      && !isGenericProvisionError(err.message)
    ));
    await assert.rejects(unset.acquire('c'), (err) => err.code === 'desktop_disabled');
    assert.equal(provider.created.length, 0);
  });

  test('F7.1(d): no DESKTOP_PROVIDER and no E2B key does not silently lie', () => {
    assert.equal(resolveProviderKind({}), '');
    assert.equal(resolveProviderKind({ E2B_API_KEY: 'e2b_x' }), 'e2b');
    assert.equal(resolveProviderKind({ DESKTOP_PROVIDER: 'local_gvisor' }), 'local-gvisor');
    const mgr = new DesktopSessionManager({
      env: enabledEnv({ E2B_API_KEY: '', DESKTOP_PROVIDER: '' }),
    });
    managers.push(mgr);
    assert.throws(() => mgr.getProvider(), (err) => err.code === 'desktop_provider_unconfigured');
  });
});

test('F7.1(f): live E2B create/destroy (skip honestly without key or SDK)', { timeout: 90_000 }, async (t) => {
  const key = String(process.env.E2B_API_KEY || '').trim();
  if (!key) {
    t.skip('E2B_API_KEY ausente — el gate de integración E2B se omite honestamente');
    return;
  }
  let sdk;
  try {
    sdk = require('@e2b/desktop');
  } catch (_) {
    t.skip('@e2b/desktop no instalado — integración E2B omitida honestamente');
    return;
  }
  const p = new E2BDesktopProvider({ apiKey: key, Desktop: sdk.Sandbox || sdk.Desktop || sdk });
  let handle;
  try {
    handle = await p.create();
    const health = await p.health(handle);
    assert.equal(health.status, 'ok');
  } finally {
    if (handle) await p.destroy(handle);
  }
});

test('F7.1: live orch #484 is still in the tree (not rerouted)', () => {
  const orch = path.join(__dirname, '../../services/computer-orchestrator/server.js');
  assert.ok(fs.existsSync(orch));
  const mgrSrc = fs.readFileSync(
    path.join(__dirname, '../src/services/desktop/session-manager.js'),
    'utf8',
  );
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '../src/routes/desktop.js'),
    'utf8',
  );
  assert.doesNotMatch(mgrSrc, /require\(['"].*orch-client['"]\)/);
  assert.doesNotMatch(mgrSrc, /orchFetch\s*\(/);
  assert.doesNotMatch(routeSrc, /require\(['"].*orch-client['"]\)/);
  assert.doesNotMatch(routeSrc, /orchFetch\s*\(/);
});
