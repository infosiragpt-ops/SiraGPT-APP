'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach } = require('node:test');

const alerting = require('../src/services/alerting');

beforeEach(() => {
  alerting._resetForTests();
  delete process.env.SLACK_ALERT_WEBHOOK_URL;
  delete process.env.PAGERDUTY_INTEGRATION_KEY;
  delete process.env.ALERT_EMAIL_WEBHOOK_URL;
});

describe('alerting — sendAlert basics', () => {
  test('rejects missing title', async () => {
    const r = await alerting.sendAlert({ message: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'title_required');
  });

  test('emits to a custom channel', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); return { ok: true }; });
    const r = await alerting.sendAlert({ title: 't1', severity: 'warn' });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, 't1');
    assert.equal(seen[0].severity, 'warn');
  });

  test('normalizes unknown severity to info', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.sendAlert({ title: 't', severity: 'banana' });
    assert.equal(seen[0].severity, 'info');
  });
});

describe('alerting — deduplication', () => {
  test('same title within window is suppressed', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.sendAlert({ title: 'dup' });
    const r2 = await alerting.sendAlert({ title: 'dup' });
    assert.equal(seen.length, 1);
    assert.equal(r2.suppressed, true);
    assert.equal(r2.count, 2);
  });

  test('different titles are not deduped', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.sendAlert({ title: 'a' });
    await alerting.sendAlert({ title: 'b' });
    assert.equal(seen.length, 2);
  });

  test('configurable dedup window — expiry replays alert', async () => {
    alerting.configure({ dedupWindowMs: 10 });
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.sendAlert({ title: 'q' });
    await new Promise((r) => setTimeout(r, 25));
    await alerting.sendAlert({ title: 'q' });
    assert.equal(seen.length, 2);
  });
});

describe('alerting — domain helpers', () => {
  test('notifyCircuitBreakerOpen passes name + JSON snapshot', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.notifyCircuitBreakerOpen({
      name: 'openai',
      toJSON: () => ({ name: 'openai', state: 'open' }),
    });
    assert.equal(seen[0].severity, 'warn');
    assert.match(seen[0].title, /openai/);
    assert.equal(seen[0].context.state, 'open');
  });

  test('notifyHighMemory uses error severity', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.notifyHighMemory(82.5);
    assert.equal(seen[0].severity, 'error');
    assert.match(seen[0].message, /82\.5/);
  });

  test('notifyDbPoolExhausted uses critical severity', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.notifyDbPoolExhausted({ active: 50, max: 50 });
    assert.equal(seen[0].severity, 'critical');
    assert.equal(seen[0].context.active, 50);
  });

  test('notifyHigh5xxRate fires error with rate context', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.notifyHigh5xxRate(7.42, { errors: 7, total: 100 });
    assert.equal(seen[0].severity, 'error');
    assert.match(seen[0].message, /7\.42/);
  });

  test('notifyFrontendError uses info severity', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    await alerting.notifyFrontendError({ page: '/chat', message: 'TypeError x', stack: 'stk' });
    assert.equal(seen[0].severity, 'info');
    assert.match(seen[0].title, /frontend_error_boundary/);
    assert.equal(seen[0].context.page, '/chat');
  });
});

describe('alerting — getActiveAlerts', () => {
  test('returns empty snapshot when no alerts have fired', () => {
    const snap = alerting.getActiveAlerts();
    assert.equal(snap.count, 0);
    assert.deepEqual(snap.items, []);
  });

  test('counts alerts inside the dedup window and ignores old ones', async () => {
    alerting.registerChannel(() => ({ ok: true }));
    await alerting.sendAlert({ title: 'fresh-1', severity: 'warn' });
    await alerting.sendAlert({ title: 'fresh-2', severity: 'error' });
    const snap = alerting.getActiveAlerts();
    assert.equal(snap.count, 2);
    const titles = snap.items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['fresh-1', 'fresh-2']);

    // Pretend a lot of time has passed → both alerts should fall out.
    const future = Date.now() + 10 * 60 * 1000;
    const old = alerting.getActiveAlerts({ now: future, windowMs: 60_000 });
    assert.equal(old.count, 0);
  });

  test('orders most-recent-first and stays stable on equal timestamps (sort contract)', async () => {
    // Regression: the comparator returned -1 on ties instead of 0, violating the
    // JS sort contract (non-antisymmetric) for alerts sharing a millisecond.
    alerting.registerChannel(() => ({ ok: true }));
    const realNow = Date.now;
    try {
      Date.now = () => 1000; // two distinct titles at the SAME ms → ISO tie
      await alerting.sendAlert({ title: 'tie-a', severity: 'warn' });
      await alerting.sendAlert({ title: 'tie-b', severity: 'warn' });
      Date.now = () => 5000; // newest
      await alerting.sendAlert({ title: 'newest', severity: 'error' });
    } finally {
      Date.now = realNow;
    }
    const snap = alerting.getActiveAlerts({ now: 5001, windowMs: 1_000_000 });
    assert.equal(snap.items[0].title, 'newest', 'most-recent alert sorts first');
    // Non-increasing by lastSentAt across the whole list — incl. the tie pair.
    for (let i = 1; i < snap.items.length; i++) {
      assert.ok(
        snap.items[i - 1].lastSentAt >= snap.items[i].lastSentAt,
        'items must be ordered newest-first with no contract violation',
      );
    }
    // All three survive — the tie pair is neither dropped nor duplicated.
    assert.deepEqual(snap.items.map((x) => x.title).sort(), ['newest', 'tie-a', 'tie-b']);
  });
});

describe('alerting — attachCircuitBreaker', () => {
  test('only fires on transitions to OPEN', async () => {
    const seen = [];
    alerting.registerChannel((p) => { seen.push(p); });
    const listeners = new Map();
    const fakeBreaker = {
      name: 'cb',
      on(evt, fn) { listeners.set(evt, fn); },
      off(evt) { listeners.delete(evt); },
      toJSON() { return { name: 'cb', state: 'open' }; },
    };
    alerting.attachCircuitBreaker(fakeBreaker);
    listeners.get('stateChange')({ from: 'closed', to: 'half_open' });
    listeners.get('stateChange')({ from: 'half_open', to: 'open' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1);
    assert.match(seen[0].title, /cb/);
  });
});
