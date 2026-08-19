'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createFeatureFlagStore,
  bucketOf,
  attributeMatch,
} = require('../src/services/flags/feature-flags');

describe('bucketOf', () => {
  test('deterministic per (flag, actor)', () => {
    assert.equal(bucketOf('flag1', 'alice'), bucketOf('flag1', 'alice'));
  });
  test('different actors land in different buckets (probabilistically)', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(bucketOf('flag1', `user-${i}`));
    assert.ok(seen.size > 20);
  });
  test('null actor → null bucket', () => {
    assert.equal(bucketOf('flag1', null), null);
    assert.equal(bucketOf('flag1', undefined), null);
  });
});

describe('attributeMatch', () => {
  test('matches a single allowed value', () => {
    assert.deepEqual(attributeMatch({ tenant: 'acme' }, { tenant: 'acme' }), { attr: 'tenant', value: 'acme' });
  });
  test('matches when value is in allowed list', () => {
    assert.deepEqual(attributeMatch({ role: ['admin', 'support'] }, { role: 'support' }), { attr: 'role', value: 'support' });
  });
  test('returns null when no match', () => {
    assert.equal(attributeMatch({ role: 'admin' }, { role: 'user' }), null);
    assert.equal(attributeMatch({ role: 'admin' }, {}), null);
  });
});

describe('createFeatureFlagStore — upsert + evaluate', () => {
  test('unknown flag returns enabled:false / reason=unknown_flag', () => {
    const fs = createFeatureFlagStore();
    assert.deepEqual(fs.evaluate('nope'), { enabled: false, reason: 'unknown_flag' });
  });

  test('boolean disabled', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: false });
    assert.equal(fs.evaluate('beta').enabled, false);
  });

  test('boolean enabled, no percentage → enabled', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true });
    const r = fs.evaluate('beta', { actorId: 'alice' });
    assert.equal(r.enabled, true);
    assert.equal(r.reason, 'enabled');
  });

  test('upsert rejects empty flagId', () => {
    const fs = createFeatureFlagStore();
    assert.throws(() => fs.upsert(''), TypeError);
  });
});

describe('createFeatureFlagStore — exclude / include', () => {
  test('exclude wins over global enabled', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, exclude: { tenant: 'banned' } });
    const r = fs.evaluate('beta', { tenant: 'banned', actorId: 'a' });
    assert.equal(r.enabled, false);
    assert.equal(r.reason, 'excluded');
  });

  test('include wins over disabled flag', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: false, include: { role: 'admin' } });
    const r = fs.evaluate('beta', { role: 'admin' });
    assert.equal(r.enabled, true);
    assert.equal(r.reason, 'included');
  });

  test('exclude beats include when both could match', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', {
      enabled: true,
      include: { role: 'admin' },
      exclude: { tenant: 'banned' },
    });
    const r = fs.evaluate('beta', { role: 'admin', tenant: 'banned' });
    assert.equal(r.enabled, false);
    assert.equal(r.reason, 'excluded');
  });
});

describe('createFeatureFlagStore — percentage rollout', () => {
  test('percentage=0 denies everyone', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, percentage: 0 });
    for (let i = 0; i < 20; i++) {
      assert.equal(fs.evaluate('beta', { actorId: `u${i}` }).enabled, false);
    }
  });

  test('percentage=100 enables everyone', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, percentage: 100 });
    for (let i = 0; i < 20; i++) {
      assert.equal(fs.evaluate('beta', { actorId: `u${i}` }).enabled, true);
    }
  });

  test('percentage=50 enables roughly half', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, percentage: 50 });
    let on = 0;
    for (let i = 0; i < 1000; i++) if (fs.evaluate('beta', { actorId: `u${i}` }).enabled) on += 1;
    // ±10% tolerance around 500.
    assert.ok(on > 400 && on < 600, `on=${on}`);
  });

  test('same actor stays in the same bucket across calls (no flicker)', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, percentage: 25 });
    const a = fs.evaluate('beta', { actorId: 'alice' }).enabled;
    const b = fs.evaluate('beta', { actorId: 'alice' }).enabled;
    assert.equal(a, b);
  });

  test('missing actorId with percentage rollout denies + reason=no_actor_for_percentage', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true, percentage: 50 });
    const r = fs.evaluate('beta', {});
    assert.equal(r.enabled, false);
    assert.equal(r.reason, 'no_actor_for_percentage');
  });
});

describe('createFeatureFlagStore — lifecycle', () => {
  test('remove makes flag unknown again', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('beta', { enabled: true });
    assert.equal(fs.remove('beta'), true);
    assert.equal(fs.evaluate('beta').reason, 'unknown_flag');
  });

  test('snapshot reports count + per-flag def', () => {
    const fs = createFeatureFlagStore();
    fs.upsert('a', { enabled: true });
    fs.upsert('b', { enabled: false, percentage: 10 });
    const s = fs.snapshot();
    assert.equal(s.count, 2);
    assert.equal(s.flags.b.percentage, 10);
  });
});
