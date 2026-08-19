'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createTenantNamespacedCache,
  defaultNormalize,
} = require('../src/cache/tenant-namespace');

function memoryCache() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); return v; },
    has: (k) => m.has(k),
    del: (k) => m.delete(k),
    keys: () => [...m.keys()],
    entries: () => [...m.entries()],
    _raw: m,
  };
}

describe('defaultNormalize', () => {
  test('lowercases and replaces unsafe chars with -', () => {
    assert.equal(defaultNormalize('Acme Corp.'), 'acme-corp');
    assert.equal(defaultNormalize('Tenant_42'), 'tenant_42');
    assert.equal(defaultNormalize('  spaced  '), 'spaced');
  });
  test('rejects empty / null / whitespace-only', () => {
    assert.throws(() => defaultNormalize(null), TypeError);
    assert.throws(() => defaultNormalize(''), TypeError);
    assert.throws(() => defaultNormalize('   '), /required|empty|tenantId/i);
  });
});

describe('createTenantNamespacedCache — construction', () => {
  test('rejects bad cache', () => {
    assert.throws(() => createTenantNamespacedCache(null, { tenantId: 'a' }), TypeError);
    assert.throws(() => createTenantNamespacedCache({}, { tenantId: 'a' }), TypeError);
  });
  test('rejects empty tenantId', () => {
    assert.throws(() => createTenantNamespacedCache(memoryCache(), {}), TypeError);
  });
  test('exposes prefix derived from version + tenant', () => {
    const ns = createTenantNamespacedCache(memoryCache(), { tenantId: 'acme' });
    assert.equal(ns.prefix(), 'v1:t:acme:');
    assert.equal(ns.tenantId, 'acme');
  });
});

describe('createTenantNamespacedCache — isolation', () => {
  test('two tenants with same logical key store under different keys', () => {
    const raw = memoryCache();
    const a = createTenantNamespacedCache(raw, { tenantId: 'acme' });
    const b = createTenantNamespacedCache(raw, { tenantId: 'globex' });
    a.set('user:42', 'A-data');
    b.set('user:42', 'B-data');
    assert.equal(a.get('user:42'), 'A-data');
    assert.equal(b.get('user:42'), 'B-data');
    assert.equal(raw._raw.size, 2);
  });

  test('has() respects the namespace', () => {
    const raw = memoryCache();
    const a = createTenantNamespacedCache(raw, { tenantId: 'a' });
    const b = createTenantNamespacedCache(raw, { tenantId: 'b' });
    a.set('k', 1);
    assert.equal(a.has('k'), true);
    assert.equal(b.has('k'), false);
  });

  test('del() only removes own tenant entry', () => {
    const raw = memoryCache();
    const a = createTenantNamespacedCache(raw, { tenantId: 'a' });
    const b = createTenantNamespacedCache(raw, { tenantId: 'b' });
    a.set('k', 1);
    b.set('k', 2);
    a.del('k');
    assert.equal(a.get('k'), undefined);
    assert.equal(b.get('k'), 2);
  });

  test('rejects empty / non-string keys', () => {
    const ns = createTenantNamespacedCache(memoryCache(), { tenantId: 'x' });
    assert.throws(() => ns.get(''), TypeError);
    assert.throws(() => ns.get(null), TypeError);
    assert.throws(() => ns.set(42, 'v'), TypeError);
  });
});

describe('createTenantNamespacedCache — clearTenant', () => {
  test('removes only own keys from a shared store', () => {
    const raw = memoryCache();
    const a = createTenantNamespacedCache(raw, { tenantId: 'a' });
    const b = createTenantNamespacedCache(raw, { tenantId: 'b' });
    a.set('x', 1); a.set('y', 2);
    b.set('x', 3); b.set('z', 4);
    const deleted = a.clearTenant();
    assert.equal(deleted, 2);
    assert.equal(a.get('x'), undefined);
    assert.equal(a.get('y'), undefined);
    assert.equal(b.get('x'), 3);
    assert.equal(b.get('z'), 4);
  });

  test('throws E_NO_ENUMERATION when underlying cache cannot list keys', () => {
    const raw = { get: () => null, set: () => null, del: () => null };
    const ns = createTenantNamespacedCache(raw, { tenantId: 'x' });
    try { ns.clearTenant(); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'E_NO_ENUMERATION'); }
  });
});

describe('createTenantNamespacedCache — adapters', () => {
  test('falls back from .del to .delete when only the latter exists', () => {
    const m = new Map();
    const raw = {
      get: (k) => m.get(k),
      set: (k, v) => { m.set(k, v); return v; },
      delete: (k) => m.delete(k),
    };
    const ns = createTenantNamespacedCache(raw, { tenantId: 't' });
    ns.set('k', 1);
    ns.del('k');
    assert.equal(m.size, 0);
  });

  test('custom normalize is applied', () => {
    const ns = createTenantNamespacedCache(memoryCache(), {
      tenantId: 'tenant-99',
      normalize: (id) => `T_${id}`,
    });
    assert.equal(ns.tenantId, 'T_tenant-99');
    assert.ok(ns.prefix().includes('T_tenant-99'));
  });
});
