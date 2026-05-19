'use strict';

const assert = require('node:assert/strict');
const { describe, test, afterEach } = require('node:test');

// Module under test — fresh-required per test so internal state resets.
function freshLoad() {
  delete require.cache[require.resolve('../src/jobs/system-cron')];
  return require('../src/jobs/system-cron');
}

describe('system-cron', () => {
  afterEach(() => {
    delete process.env.SYSTEM_CRON_ENABLED;
    delete process.env.NODE_ENV;
    try { freshLoad().stop(); } catch (_) {}
  });

  test('isEnabled() — false in NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), false);
  });

  test('isEnabled() — true by default when not in test env', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SYSTEM_CRON_ENABLED;
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), true);
  });

  test('isEnabled() — false when SYSTEM_CRON_ENABLED=false', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'false';
    const mod = freshLoad();
    assert.equal(mod.isEnabled(), false);
  });

  test('start() — returns disabled when disabled', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    const res = mod.start({ logger: { warn() {}, info() {}, error() {} } });
    assert.equal(res.enabled, false);
    assert.deepEqual(res.tasks, []);
  });

  test('status() — empty when not started', () => {
    process.env.NODE_ENV = 'test';
    const mod = freshLoad();
    const s = mod.status();
    assert.equal(s.enabled, false);
    assert.deepEqual(s.tasks, []);
  });

  test('start() — registers both jobs with UTC schedules when enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSTEM_CRON_ENABLED = 'true';
    const mod = freshLoad();
    const logs = [];
    const logger = { warn(m) { logs.push(['warn', m]); }, info(m) { logs.push(['info', m]); }, error(m) { logs.push(['error', m]); } };
    const res = mod.start({ logger });
    try {
      assert.equal(res.enabled, true);
      const names = res.tasks.map((t) => t.name).sort();
      assert.deepEqual(names, ['hard-delete-deleted-users', 'scrub-deleted-user-content']);
      // Default schedules — scrub @ 02:30 UTC, hard-delete @ 03:00 UTC.
      const scrub = res.tasks.find((t) => t.name === 'scrub-deleted-user-content');
      const hard = res.tasks.find((t) => t.name === 'hard-delete-deleted-users');
      assert.equal(scrub.schedule, '30 2 * * *');
      assert.equal(hard.schedule, '0 3 * * *');
    } finally {
      mod.stop();
    }
  });
});
