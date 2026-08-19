'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FlagService, FlagError, hashUserKey } = require('../src/flags');

test('register + evaluate boolean flag returns default', () => {
  const svc = new FlagService();
  svc.register('beta_ui', { strategy: 'boolean', default: true, description: 'beta' });
  const out = svc.evaluate('beta_ui');
  assert.equal(out.value, true);
  assert.equal(out.reason, 'default');
});

test('evaluate unknown flag returns fallback', () => {
  const svc = new FlagService();
  const out = svc.evaluate('nope', { fallback: 'x' });
  assert.equal(out.value, 'x');
  assert.equal(out.reason, 'unknown');
});

test('disabled flag returns default with disabled reason', () => {
  const svc = new FlagService();
  svc.register('killed', { strategy: 'boolean', default: true, enabled: false });
  const out = svc.evaluate('killed');
  assert.equal(out.reason, 'disabled');
  assert.equal(out.value, true);
});

test('user override beats everything else', () => {
  const svc = new FlagService();
  svc.register('feature', { strategy: 'boolean', default: false });
  svc.setGlobalOverride('feature', true);
  svc.setUserOverride('u-1', 'feature', false);
  const u1 = svc.evaluate('feature', { userId: 'u-1' });
  assert.equal(u1.value, false);
  assert.equal(u1.reason, 'user_override');
  const u2 = svc.evaluate('feature', { userId: 'u-2' });
  assert.equal(u2.value, true);
  assert.equal(u2.reason, 'global_override');
});

test('clearUserOverride removes only the targeted flag', () => {
  const svc = new FlagService();
  svc.register('a', { strategy: 'boolean', default: false });
  svc.register('b', { strategy: 'boolean', default: false });
  svc.setUserOverride('u', 'a', true);
  svc.setUserOverride('u', 'b', true);
  assert.equal(svc.clearUserOverride('u', 'a'), true);
  assert.equal(svc.evaluate('a', { userId: 'u' }).reason, 'default');
  assert.equal(svc.evaluate('b', { userId: 'u' }).value, true);
});

test('setUserOverride throws for unknown flag', () => {
  const svc = new FlagService();
  assert.throws(() => svc.setUserOverride('u', 'missing', true), (err) => err instanceof FlagError && err.code === 'FLAG_UNKNOWN');
});

test('env var override wins over default but not user override', () => {
  const env = { FLAG_NEW_AGENT: 'true' };
  const svc = new FlagService({ env });
  svc.register('new_agent', { strategy: 'boolean', default: false });
  assert.equal(svc.evaluate('new_agent').value, true);
  assert.equal(svc.evaluate('new_agent').reason, 'env');
  svc.setUserOverride('u', 'new_agent', false);
  assert.equal(svc.evaluate('new_agent', { userId: 'u' }).value, false);
});

test('allowlist strategy admits only listed users', () => {
  const svc = new FlagService();
  svc.register('vip', { strategy: 'allowlist', allowlist: ['u-1', 'u-2'] });
  assert.equal(svc.evaluate('vip', { userId: 'u-1' }).value, true);
  assert.equal(svc.evaluate('vip', { userId: 'u-1' }).reason, 'allowlist');
  assert.equal(svc.evaluate('vip', { userId: 'u-3' }).value, false);
  assert.equal(svc.evaluate('vip', { userId: 'u-3' }).reason, 'not_allowlisted');
});

test('denylist short-circuits before percentage', () => {
  const svc = new FlagService();
  svc.register('rollout', { strategy: 'percentage', percentage: 100, denylist: ['banned'] });
  assert.equal(svc.evaluate('rollout', { userId: 'banned' }).reason, 'denylist');
  assert.equal(svc.evaluate('rollout', { userId: 'normal' }).value, true);
});

test('percentage strategy is deterministic per user', () => {
  const svc = new FlagService();
  svc.register('exp', { strategy: 'percentage', percentage: 50 });
  const a = svc.evaluate('exp', { userId: 'user-stable' });
  const b = svc.evaluate('exp', { userId: 'user-stable' });
  assert.equal(a.value, b.value);
  assert.equal(typeof a.bucket, 'number');
});

test('percentage = 0 disables for everyone, percentage = 100 enables for everyone', () => {
  const svc = new FlagService();
  svc.register('off', { strategy: 'percentage', percentage: 0 });
  svc.register('on', { strategy: 'percentage', percentage: 100 });
  for (let i = 0; i < 25; i++) {
    assert.equal(svc.evaluate('off', { userId: `u${i}` }).value, false);
    assert.equal(svc.evaluate('on', { userId: `u${i}` }).value, true);
  }
});

test('percentage roughly matches configured rate', () => {
  const svc = new FlagService();
  svc.register('half', { strategy: 'percentage', percentage: 50 });
  let hits = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    if (svc.evaluate('half', { userId: `user-${i}` }).value) hits++;
  }
  const rate = hits / n;
  assert.ok(rate > 0.4 && rate < 0.6, `expected ~50% got ${rate}`);
});

test('percentage with no userId returns false with no_user reason', () => {
  const svc = new FlagService();
  svc.register('exp', { strategy: 'percentage', percentage: 100 });
  const out = svc.evaluate('exp');
  assert.equal(out.value, false);
  assert.equal(out.reason, 'no_user');
});

test('variant strategy distributes across buckets', () => {
  const svc = new FlagService();
  svc.register('exp', { strategy: 'variant', variants: { control: 50, treatment: 50 } });
  const counts = { control: 0, treatment: 0 };
  for (let i = 0; i < 1000; i++) {
    const out = svc.evaluate('exp', { userId: `u-${i}` });
    counts[out.value]++;
  }
  assert.ok(counts.control > 350 && counts.control < 650);
  assert.ok(counts.treatment > 350 && counts.treatment < 650);
});

test('variant strategy is stable per user', () => {
  const svc = new FlagService();
  svc.register('exp', { strategy: 'variant', variants: { a: 1, b: 1, c: 1 } });
  const first = svc.evaluate('exp', { userId: 'sticky' }).value;
  for (let i = 0; i < 5; i++) {
    assert.equal(svc.evaluate('exp', { userId: 'sticky' }).value, first);
  }
});

test('variant strategy without variants throws on register', () => {
  const svc = new FlagService();
  assert.throws(() => svc.register('bad', { strategy: 'variant' }), /variants/);
});

test('update merges existing definition and bumps updatedAt', async () => {
  let t = 100;
  const svc = new FlagService({ now: () => t });
  svc.register('feat', { strategy: 'percentage', percentage: 10 });
  t = 200;
  const updated = svc.update('feat', { percentage: 75 });
  assert.equal(updated.percentage, 75);
  assert.equal(updated.updatedAt, 200);
  assert.equal(svc.get('feat').percentage, 75);
});

test('update unknown flag throws', () => {
  const svc = new FlagService();
  assert.throws(() => svc.update('nope', { percentage: 10 }), (err) => err instanceof FlagError && err.code === 'FLAG_UNKNOWN');
});

test('unregister removes flag and overrides', () => {
  const svc = new FlagService();
  svc.register('feat', { strategy: 'boolean', default: false });
  svc.setUserOverride('u', 'feat', true);
  svc.setGlobalOverride('feat', true);
  assert.equal(svc.unregister('feat'), true);
  assert.equal(svc.has('feat'), false);
  assert.equal(svc.evaluate('feat', { userId: 'u' }).reason, 'unknown');
});

test('listeners receive register/update/override events', () => {
  const svc = new FlagService();
  const events = [];
  const off = svc.on((e) => events.push(e));
  svc.register('feat', { strategy: 'boolean' });
  svc.update('feat', { default: true });
  svc.setUserOverride('u', 'feat', false);
  off();
  svc.unregister('feat');
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['register', 'update', 'user_override']);
});

test('snapshot returns evaluation for every flag in scope', () => {
  const svc = new FlagService();
  svc.register('a', { strategy: 'boolean', default: true });
  svc.register('b', { strategy: 'allowlist', allowlist: ['u'] });
  const snap = svc.snapshot({ userId: 'u' });
  assert.equal(snap.a.value, true);
  assert.equal(snap.b.value, true);
});

test('hashUserKey is deterministic and bounded', () => {
  const a = hashUserKey('flag', 'user');
  const b = hashUserKey('flag', 'user');
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 100);
});

test('constructor accepts initial flag map', () => {
  const svc = new FlagService({
    flags: {
      a: { strategy: 'boolean', default: true },
      b: { strategy: 'percentage', percentage: 25 },
    },
  });
  assert.equal(svc.list().length, 2);
  assert.equal(svc.evaluate('a').value, true);
});

test('register rejects invalid strategy', () => {
  const svc = new FlagService();
  assert.throws(() => svc.register('x', { strategy: 'bogus' }), (err) => err instanceof FlagError && err.code === 'FLAG_INVALID_STRATEGY');
});

test('register rejects empty key', () => {
  const svc = new FlagService();
  assert.throws(() => svc.register('', { strategy: 'boolean' }), (err) => err instanceof FlagError && err.code === 'FLAG_INVALID_KEY');
});
